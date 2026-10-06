<?php
/**
 * CCPL ERP - OTP Security & Storage Engine
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/mailer.php';

if (isset($_SERVER['SCRIPT_FILENAME']) && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'])) {
    http_response_code(403);
    exit('Direct access forbidden');
}

class OtpService {
    private static function getStorageDir(): string {
        $dir = __DIR__ . '/data/otp_sessions';
        if (!is_dir($dir)) {
            mkdir($dir, 0750, true);
        }
        return $dir;
    }

    private static function getRateLimitDir(): string {
        $dir = __DIR__ . '/data/rate_limits';
        if (!is_dir($dir)) {
            mkdir($dir, 0750, true);
        }
        return $dir;
    }

    private static function getSecretKey(): string {
        $secret = (string) env('OTP_SECRET_KEY', '');
        // Fail closed: without a long random secret in the environment no OTP can be issued or verified.
        if (strlen($secret) < 32) {
            error_log('OTP_SECRET_KEY is missing or shorter than 32 characters; OTP login disabled.');
            throw new RuntimeException('Sign-in is temporarily unavailable. Please contact the administrator.');
        }
        return $secret;
    }

    /**
     * Generate HMAC signature binding challenge_id, uid, exp, and IP
     */
    public static function createSignature(string $challengeId, string $uid, int $expiresAt, string $ip): string {
        $data = "{$challengeId}|{$uid}|{$expiresAt}|{$ip}";
        return hash_hmac('sha256', $data, self::getSecretKey());
    }

    /**
     * Verify HMAC signature
     */
    public static function verifySignature(string $signature, string $challengeId, string $uid, int $expiresAt, string $ip): bool {
        $expected = self::createSignature($challengeId, $uid, $expiresAt, $ip);
        return hash_equals($expected, $signature);
    }

    /**
     * IP rate limiting for sign-in attempts
     */
    public static function checkIpRateLimit(string $ip): bool {
        $file = self::getRateLimitDir() . '/' . hash('sha256', $ip) . '.json';
        $now = time();
        $window = 900; // 15 minutes
        $maxAttempts = 15;

        if (file_exists($file)) {
            $data = json_decode(file_get_contents($file), true);
            if (is_array($data) && isset($data['reset_at']) && $data['reset_at'] > $now) {
                if ($data['count'] >= $maxAttempts) {
                    return false;
                }
            }
        }
        return true;
    }

    public static function recordIpAttempt(string $ip, bool $isFailed): void {
        $file = self::getRateLimitDir() . '/' . hash('sha256', $ip) . '.json';
        $now = time();
        $window = 900; // 15 minutes

        if (!$isFailed) {
            // Reset on successful sign-in
            if (file_exists($file)) {
                @unlink($file);
            }
            return;
        }

        $data = ['count' => 1, 'reset_at' => $now + $window];
        if (file_exists($file)) {
            $existing = json_decode(file_get_contents($file), true);
            if (is_array($existing) && isset($existing['reset_at']) && $existing['reset_at'] > $now) {
                $data['count'] = ($existing['count'] ?? 0) + 1;
                $data['reset_at'] = $existing['reset_at'];
            }
        }
        file_put_contents($file, json_encode($data), LOCK_EX);
    }

    /**
     * Generate cryptographically secure 6-digit OTP
     */
    public static function generateOtp(): string {
        return str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    }

    /**
     * Create a new OTP challenge and send OTP email
     */
    public static function createChallenge(string $uid, string $email, string $userName, string $ip): array {
        self::maybeGarbageCollect();

        $challengeId = bin2hex(random_bytes(16));
        $otp = self::generateOtp();
        $otpHash = password_hash($otp, PASSWORD_DEFAULT);

        $expirySeconds = (int)env('OTP_EXPIRY_SECONDS', 300);
        $cooldownSeconds = (int)env('OTP_RESEND_COOLDOWN_SECONDS', 60);
        $maxAttempts = (int)env('OTP_MAX_ATTEMPTS', 5);

        $now = time();
        $expiresAt = $now + $expirySeconds;
        $resendAvailableAt = $now + $cooldownSeconds;

        $record = [
            'challenge_id' => $challengeId,
            'uid' => $uid,
            'email' => $email,
            'user_name' => $userName,
            'otp_hash' => $otpHash,
            'attempts' => 0,
            'max_attempts' => $maxAttempts,
            'created_at' => $now,
            'expires_at' => $expiresAt,
            'resend_available_at' => $resendAvailableAt,
            'ip' => $ip,
        ];

        $filePath = self::getStorageDir() . '/' . $challengeId . '.json';
        file_put_contents($filePath, json_encode($record), LOCK_EX);

        // Send OTP email
        $sent = MailerService::sendOtpEmail($email, $otp, $userName);
        if (!$sent) {
            @unlink($filePath);
            return [
                'success' => false,
                'error' => 'Failed to send OTP verification email. Please contact the administrator or verify your mail settings.'
            ];
        }

        $signature = self::createSignature($challengeId, $uid, $expiresAt, $ip);

        return [
            'success' => true,
            'challenge_id' => $challengeId,
            'challenge_signature' => $signature,
            'email_masked' => mask_email($email),
            'expires_in' => $expirySeconds,
            'resend_cooldown' => $cooldownSeconds,
        ];
    }

    /**
     * Verify submitted OTP against challenge
     */
    public static function verifyOtp(string $challengeId, string $signature, string $enteredOtp, string $ip): array {
        // Basic pattern validation
        if (!preg_match('/^[a-f0-9]{32}$/', $challengeId)) {
            return ['success' => false, 'error' => 'Invalid challenge token format.'];
        }

        $enteredOtp = trim($enteredOtp);
        if (!preg_match('/^[0-9]{6}$/', $enteredOtp)) {
            return ['success' => false, 'error' => 'Please enter a valid 6-digit verification code.'];
        }

        $filePath = self::getStorageDir() . '/' . $challengeId . '.json';
        if (!file_exists($filePath)) {
            return [
                'success' => false,
                'error' => 'Verification session expired or already used. Please start sign-in again.',
                'session_expired' => true
            ];
        }

        $raw = file_get_contents($filePath);
        $record = json_decode($raw, true);
        if (!is_array($record)) {
            @unlink($filePath);
            return ['success' => false, 'error' => 'Corrupt verification session. Please sign in again.'];
        }

        // Verify cryptographic signature
        if (!self::verifySignature($signature, $challengeId, $record['uid'], $record['expires_at'], $record['ip'])) {
            @unlink($filePath);
            return ['success' => false, 'error' => 'Challenge signature verification failed. Please sign in again.'];
        }

        // Check expiration
        if (time() > $record['expires_at']) {
            @unlink($filePath);
            return [
                'success' => false,
                'error' => 'The verification code has expired. Please sign in again.',
                'session_expired' => true
            ];
        }

        // Check attempts limit
        if ($record['attempts'] >= $record['max_attempts']) {
            @unlink($filePath);
            return [
                'success' => false,
                'error' => 'Maximum verification attempts exceeded. Please start sign-in again.',
                'session_expired' => true
            ];
        }

        // Verify OTP hash
        if (password_verify($enteredOtp, $record['otp_hash'])) {
            // One-time usage: immediately delete session file
            @unlink($filePath);
            return [
                'success' => true,
                'uid' => $record['uid'],
                'email' => $record['email'],
                'user_name' => $record['user_name']
            ];
        }

        // Failed attempt: increment counter
        $record['attempts']++;
        $remaining = $record['max_attempts'] - $record['attempts'];

        if ($remaining <= 0) {
            @unlink($filePath);
            return [
                'success' => false,
                'error' => 'Maximum verification attempts exceeded. Please start sign-in again.',
                'session_expired' => true
            ];
        }

        file_put_contents($filePath, json_encode($record), LOCK_EX);

        return [
            'success' => false,
            'error' => "Incorrect verification code. {$remaining} " . ($remaining === 1 ? 'attempt' : 'attempts') . " remaining.",
            'remaining_attempts' => $remaining
        ];
    }

    /**
     * Resend a fresh OTP for an existing active challenge
     */
    public static function resendOtp(string $challengeId, string $signature, string $ip): array {
        if (!preg_match('/^[a-f0-9]{32}$/', $challengeId)) {
            return ['success' => false, 'error' => 'Invalid challenge token format.'];
        }

        $filePath = self::getStorageDir() . '/' . $challengeId . '.json';
        if (!file_exists($filePath)) {
            return [
                'success' => false,
                'error' => 'Verification session expired. Please start sign-in again.',
                'session_expired' => true
            ];
        }

        $record = json_decode(file_get_contents($filePath), true);
        if (!is_array($record)) {
            @unlink($filePath);
            return ['success' => false, 'error' => 'Corrupt verification session. Please sign in again.'];
        }

        // Verify cryptographic signature
        if (!self::verifySignature($signature, $challengeId, $record['uid'], $record['expires_at'], $record['ip'])) {
            @unlink($filePath);
            return ['success' => false, 'error' => 'Challenge signature verification failed. Please sign in again.'];
        }

        // Check cooldown
        $now = time();
        if ($now < $record['resend_available_at']) {
            $wait = $record['resend_available_at'] - $now;
            return [
                'success' => false,
                'error' => "Please wait {$wait} seconds before requesting a new code.",
                'cooldown' => $wait
            ];
        }

        // Generate new OTP
        $newOtp = self::generateOtp();
        $expirySeconds = (int)env('OTP_EXPIRY_SECONDS', 300);
        $cooldownSeconds = (int)env('OTP_RESEND_COOLDOWN_SECONDS', 60);

        $record['otp_hash'] = password_hash($newOtp, PASSWORD_DEFAULT);
        $record['created_at'] = $now;
        $record['expires_at'] = $now + $expirySeconds;
        $record['resend_available_at'] = $now + $cooldownSeconds;
        $record['attempts'] = 0; // Reset attempts for the new code

        // Send email
        $sent = MailerService::sendOtpEmail($record['email'], $newOtp, $record['user_name']);
        if (!$sent) {
            return ['success' => false, 'error' => 'Failed to send OTP email. Please try again.'];
        }

        file_put_contents($filePath, json_encode($record), LOCK_EX);

        // Update signature with new expires_at
        $newSignature = self::createSignature($challengeId, $record['uid'], $record['expires_at'], $record['ip']);

        return [
            'success' => true,
            'challenge_signature' => $newSignature,
            'expires_in' => $expirySeconds,
            'resend_cooldown' => $cooldownSeconds,
            'message' => 'A new 6-digit verification code has been sent to your email.'
        ];
    }

    /**
     * Cleanup old expired OTP session files
     */
    private static function maybeGarbageCollect(): void {
        if (random_int(1, 20) === 1) { // 5% chance
            $dir = self::getStorageDir();
            $now = time();
            $files = glob("{$dir}/*.json");
            if ($files) {
                foreach ($files as $f) {
                    if ($now - filemtime($f) > 900) { // older than 15 mins
                        @unlink($f);
                    }
                }
            }
        }
    }
}
