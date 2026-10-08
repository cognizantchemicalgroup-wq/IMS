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
        $apiKey = env('FIREBASE_API_KEY', '');
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

    /**
     * Fetch user profile from Firestore (/users/{uid}) using OAuth2 Datastore token
     */
    public static function getUserProfile(string $uid): ?array {
        try {
            $sa = self::getServiceAccountData();
            $projectId = $sa['project_id'] ?? env('FIREBASE_PROJECT_ID', 'ccpl-ims');

            $creds = new ServiceAccountCredentials(['https://www.googleapis.com/auth/datastore'], $sa);
            $tokenInfo = $creds->fetchAuthToken();
            if (empty($tokenInfo['access_token'])) {
                error_log("Could not obtain datastore access token.");
                return null;
            }
            $accessToken = $tokenInfo['access_token'];

            $url = "https://firestore.googleapis.com/v1/projects/{$projectId}/databases/(default)/documents/users/" . urlencode($uid);
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                    "Authorization: Bearer {$accessToken}",
                    "Accept: application/json"
                ],
                CURLOPT_TIMEOUT => 8,
            ]);
            $res = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200 || !$res) {
                return null;
            }

            $doc = json_decode($res, true);
            if (empty($doc['fields'])) {
                return null;
            }

            // Convert Firestore format to plain associative array
            $profile = [];
            foreach ($doc['fields'] as $key => $val) {
                if (isset($val['stringValue'])) {
                    $profile[$key] = $val['stringValue'];
                } elseif (isset($val['booleanValue'])) {
                    $profile[$key] = (bool)$val['booleanValue'];
                } elseif (isset($val['integerValue'])) {
                    $profile[$key] = (int)$val['integerValue'];
                } elseif (isset($val['doubleValue'])) {
                    $profile[$key] = (float)$val['doubleValue'];
                } else {
                    $profile[$key] = reset($val);
                }
            }

            return $profile;
        } catch (\Throwable $e) {
            error_log("Firestore getUserProfile error: " . $e->getMessage());
            return null;
        }
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
