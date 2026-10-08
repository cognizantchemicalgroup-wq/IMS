<?php
/**
 * CCPL ERP - Firebase Admin & Auth Integration
 */

require_once __DIR__ . '/config.php';

use Kreait\Firebase\Factory;
use Kreait\Firebase\Contract\Auth;
use Google\Auth\Credentials\ServiceAccountCredentials;

if (isset($_SERVER['SCRIPT_FILENAME']) && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'])) {
    http_response_code(403);
    exit('Direct access forbidden');
}

class FirebaseService {
    private static ?Auth $authInstance = null;
    private static ?array $serviceAccountData = null;
    private static ?string $serviceAccountPath = null;

    /**
     * Locate and validate service account JSON path
     */
    public static function getServiceAccountPath(): string {
        if (self::$serviceAccountPath !== null) {
            return self::$serviceAccountPath;
        }

        $configuredPath = env('FIREBASE_SERVICE_ACCOUNT_PATH', 'service-account.json');
        if (!preg_match('/^[a-zA-Z]:[\\\\\/]|\//', $configuredPath)) {
            $resolvedPath = dirname(__DIR__) . '/' . ltrim($configuredPath, '/\\');
        } else {
            $resolvedPath = $configuredPath;
        }

        // Preferred location is OUTSIDE the public web root (one level above public_html).
        $candidates = [
            $resolvedPath,
            dirname(__DIR__, 2) . '/service-account.json',
            dirname(__DIR__) . '/service-account.json',
            __DIR__ . '/service-account.json',
            dirname(__DIR__) . '/admin/service-account.json'
        ];

        foreach ($candidates as $cand) {
            if (file_exists($cand) && is_readable($cand)) {
                self::$serviceAccountPath = $cand;
                return self::$serviceAccountPath;
            }
        }

        throw new RuntimeException("Firebase service account credentials file not found. Checked: " . implode(', ', array_unique($candidates)));
    }

    /**
     * Get parsed service account data
     */
    public static function getServiceAccountData(): array {
        if (self::$serviceAccountData !== null) {
            return self::$serviceAccountData;
        }
        $raw = file_get_contents(self::getServiceAccountPath());
        $data = json_decode($raw, true);
        if (!is_array($data) || empty($data['client_email']) || empty($data['private_key'])) {
            throw new RuntimeException("Invalid service account JSON format.");
        }
        self::$serviceAccountData = $data;
        return self::$serviceAccountData;
    }

    /**
     * Get Kreait Firebase Auth instance
     */
    public static function getAuth(): Auth {
        if (self::$authInstance === null) {
            $saPath = self::getServiceAccountPath();
            $factory = (new Factory)->withServiceAccount($saPath);
            self::$authInstance = $factory->createAuth();
        }
        return self::$authInstance;
    }

    /**
     * Validate Firebase Email & Password credentials via Google Identity Toolkit REST API.
     * Keeps temporary auth tokens strictly on the server; does not establish client session.
     */
    public static function validateCredentials(string $email, string $password): array {
        $apiKey = env('FIREBASE_API_KEY', 'AIzaSyASaR4XRhIgrSMAgvHGaLpxfCKMKvDLLro');
        $url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" . urlencode($apiKey);

        $payload = json_encode([
            'email' => $email,
            'password' => $password,
            'returnSecureToken' => true
        ]);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json'
            ],
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_SSL_VERIFYPEER => true
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($curlErr) {
            error_log("Firebase Auth cURL error: " . $curlErr);
            return ['valid' => false, 'error' => 'Network error connecting to authentication service.'];
        }

        $data = json_decode($response, true);
        if ($httpCode === 200 && !empty($data['localId'])) {
            return [
                'valid' => true,
                'uid' => $data['localId'],
                'email' => $data['email'] ?? $email,
                'idToken' => $data['idToken'] ?? null
            ];
        }

        $errMsg = $data['error']['message'] ?? '';
        if (str_contains($errMsg, 'INVALID_LOGIN_CREDENTIALS') ||
            str_contains($errMsg, 'EMAIL_NOT_FOUND') ||
            str_contains($errMsg, 'INVALID_PASSWORD')) {
            return ['valid' => false, 'error' => 'Incorrect email or password.'];
        }
        if (str_contains($errMsg, 'USER_DISABLED')) {
            return ['valid' => false, 'error' => 'This account has been disabled by the administrator.'];
        }
        if (str_contains($errMsg, 'TOO_MANY_ATTEMPTS_TRY_LATER')) {
            return ['valid' => false, 'error' => 'Too many failed attempts. The account is temporarily locked — try again later.'];
        }

        error_log("Firebase Auth unexpected error ({$httpCode}): " . $response);
        return ['valid' => false, 'error' => 'Incorrect email or password.'];
    }

    private static ?string $datastoreToken = null;

    /** OAuth access token of the service account for the given scope (cached per request). */
    public static function accessToken(string $scope = 'https://www.googleapis.com/auth/datastore'): string {
        if ($scope === 'https://www.googleapis.com/auth/datastore' && self::$datastoreToken !== null) {
            return self::$datastoreToken;
        }
        $creds = new ServiceAccountCredentials([$scope], self::getServiceAccountData());
        $tokenInfo = $creds->fetchAuthToken();
        if (empty($tokenInfo['access_token'])) {
            throw new RuntimeException('Could not obtain an access token.');
        }
        if ($scope === 'https://www.googleapis.com/auth/datastore') {
            self::$datastoreToken = $tokenInfo['access_token'];
        }
        return $tokenInfo['access_token'];
    }

    public static function projectId(): string {
        return self::getServiceAccountData()['project_id'] ?? env('FIREBASE_PROJECT_ID', 'ccpl-ims');
    }

    /** Converts one Firestore REST value to PHP. Timestamps become Unix seconds (float). */
    private static function decodeValue(array $val): mixed {
        if (array_key_exists('stringValue', $val)) return $val['stringValue'];
        if (array_key_exists('booleanValue', $val)) return (bool)$val['booleanValue'];
        if (array_key_exists('integerValue', $val)) return (int)$val['integerValue'];
        if (array_key_exists('doubleValue', $val)) return (float)$val['doubleValue'];
        if (array_key_exists('nullValue', $val)) return null;
        if (array_key_exists('timestampValue', $val)) {
            $ts = strtotime($val['timestampValue']);
            return $ts === false ? null : (float)$ts;
        }
        if (isset($val['mapValue'])) {
            $out = [];
            foreach (($val['mapValue']['fields'] ?? []) as $k => $v) $out[$k] = self::decodeValue($v);
            return $out;
        }
        if (isset($val['arrayValue'])) {
            return array_map([self::class, 'decodeValue'], $val['arrayValue']['values'] ?? []);
        }
        return reset($val);
    }

    /**
     * Reads one Firestore document with the service account (bypasses rules — callers must authorise first).
     * $path like "users/abc". Returns plain fields, or null when missing / on error.
     */
    public static function getDocument(string $path): ?array {
        try {
            $segments = array_map('rawurlencode', explode('/', $path));
            $url = 'https://firestore.googleapis.com/v1/projects/' . self::projectId() . '/databases/(default)/documents/' . implode('/', $segments);
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . self::accessToken(), 'Accept: application/json'],
                CURLOPT_TIMEOUT => 8,
            ]);
            $res = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($httpCode !== 200 || !$res) {
                return null;
            }
            $doc = json_decode($res, true);
            if (!is_array($doc) || !isset($doc['fields'])) {
                return is_array($doc) && isset($doc['name']) ? [] : null;
            }
            $out = [];
            foreach ($doc['fields'] as $key => $val) $out[$key] = self::decodeValue($val);
            return $out;
        } catch (\Throwable $e) {
            error_log("Firestore getDocument({$path}) error: " . $e->getMessage());
            return null;
        }
    }

    /**
     * Fetch user profile from Firestore (/users/{uid})
     */
    public static function getUserProfile(string $uid): ?array {
        $profile = self::getDocument('users/' . $uid);
        return $profile ?: null;
    }

    /**
     * Authenticates an API request: "Authorization: Bearer <Firebase ID token>" of a signed-in user whose
     * /users/{uid} profile is active. Ends the request with 401/403 otherwise.
     * Returns ['uid' => ..., 'email' => ..., 'profile' => [...]].
     */
    public static function requireActiveUser(): array {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (!preg_match('/^Bearer\s+(\S+)$/i', $header, $m)) {
            json_error('Sign in required.', 401);
        }
        try {
            $token = self::getAuth()->verifyIdToken($m[1], true);
        } catch (\Throwable $e) {
            json_error('Your session has expired. Sign in again.', 401);
        }
        $uid = (string)$token->claims()->get('sub');
        $email = strtolower((string)($token->claims()->get('email') ?? ''));
        $profile = self::getUserProfile($uid);
        if (!$profile || ($profile['active'] ?? false) !== true) {
            json_error('This account is not authorised for the CCPL ERP, or it has been deactivated.', 403);
        }
        return ['uid' => $uid, 'email' => $email, 'profile' => $profile];
    }

    public static function isSuperAdmin(array $user): bool {
        return $user['email'] === strtolower(env('SUPER_ADMIN_EMAIL', 'rupesh.mudliar@cognizantchemical.com'));
    }

    /**
     * True when the super admin has a valid reset grant: /secure/resetGrant written by this user in the last
     * 30 minutes whose proof matches the stored reset-password hash (same check as firestore.rules).
     */
    public static function hasResetGrant(array $user): bool {
        if (!self::isSuperAdmin($user)) return false;
        $grant = self::getDocument('secure/resetGrant');
        $lock = self::getDocument('secure/resetLock');
        if (!$grant || !$lock || empty($grant['proof']) || empty($lock['hash'])) return false;
        if (($grant['uid'] ?? '') !== $user['uid']) return false;
        $at = $grant['at'] ?? null;
        if (!is_float($at) || $at < time() - 30 * 60) return false;
        return hash_equals(strtolower((string)$lock['hash']), hash('sha256', (string)$grant['proof']));
    }

    /** Firebase Storage bucket (private; accessed only with the service account). */
    public static function bucket(): \Google\Cloud\Storage\Bucket {
        $client = new \Google\Cloud\Storage\StorageClient([
            'keyFile' => self::getServiceAccountData(),
            'projectId' => self::projectId(),
        ]);
        return $client->bucket(env('FIREBASE_STORAGE_BUCKET', self::projectId() . '.firebasestorage.app'));
    }

    /**
     * Generate Firebase Custom Token for authenticated user after OTP verification
     */
    public static function createCustomToken(string $uid, array $claims = []): string {
        $auth = self::getAuth();
        $token = $auth->createCustomToken($uid, $claims);
        return $token->toString();
    }
}
