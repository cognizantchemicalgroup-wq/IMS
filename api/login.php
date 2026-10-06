<?php
/**
 * CCPL ERP - Login Endpoint (Step 1: Validate credentials & dispatch OTP)
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/firebase.php';
require_once __DIR__ . '/otp-service.php';

apply_security_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method Not Allowed. POST is required.', 405);
}

$input = get_json_input();
$email = trim((string)($input['email'] ?? ''));
$password = (string)($input['password'] ?? '');

if (empty($email) || empty($password)) {
    json_error('Email and password are required.');
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_error('Please enter a valid email address.');
}

$ip = get_client_ip();

// Rate limiting check
if (!OtpService::checkIpRateLimit($ip)) {
    json_error('Too many sign-in attempts. Please try again after 15 minutes.', 429);
}

try {
    // Step 1: Validate Firebase email & password on backend
    $credResult = FirebaseService::validateCredentials($email, $password);
    if (!$credResult['valid']) {
        OtpService::recordIpAttempt($ip, true);
        json_error($credResult['error'], 401);
    }

    $uid = $credResult['uid'];
    $verifiedEmail = $credResult['email'];

    // Step 2: Verify active user profile in Firestore
    $profile = FirebaseService::getUserProfile($uid);
    if (!$profile || empty($profile['active'])) {
        json_error('This account is not authorised for the CCPL ERP, or it has been deactivated.', 403);
    }

    // Credentials and active profile confirmed
    OtpService::recordIpAttempt($ip, false);

    // Step 3: Create OTP challenge & send code to registered email
    $userName = $profile['name'] ?? 'ERP User';
    $challengeResult = OtpService::createChallenge($uid, $verifiedEmail, $userName, $ip);

    if (!$challengeResult['success']) {
        json_error($challengeResult['error'], 500);
    }

    json_response([
        'success' => true,
        'message' => 'Verification code sent to registered email.',
        'challenge_id' => $challengeResult['challenge_id'],
        'challenge_signature' => $challengeResult['challenge_signature'],
        'email_masked' => $challengeResult['email_masked'],
        'expires_in' => $challengeResult['expires_in'],
        'resend_cooldown' => $challengeResult['resend_cooldown'],
    ]);
} catch (\Throwable $e) {
    error_log("Login processing error: " . $e->getMessage());
    json_error("Sign-in failed: " . $e->getMessage(), 500);
}
