<?php
/**
 * CCPL ERP - Login Endpoint (Direct authentication without OTP)
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/firebase.php';

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

try {
    // Step 1: Validate Firebase email & password credentials
    $credResult = FirebaseService::validateCredentials($email, $password);
    if (!$credResult['valid']) {
        json_error($credResult['error'], 401);
    }

    $uid = $credResult['uid'];
    $verifiedEmail = $credResult['email'];

    // Step 2: Verify active user profile in Firestore
    $profile = FirebaseService::getUserProfile($uid);
    if (!$profile || empty($profile['active'])) {
        json_error('This account is not authorised for the CCPL ERP, or it has been deactivated.', 403);
    }

    // Step 3: Issue Firebase Custom Token directly without OTP
    $customToken = FirebaseService::createCustomToken($uid);

    json_response([
        'success' => true,
        'message' => 'Sign-in successful.',
        'custom_token' => $customToken,
        'user' => [
            'uid' => $uid,
            'email' => $verifiedEmail,
            'name' => $profile['name'] ?? ''
        ]
    ]);
} catch (\Throwable $e) {
    error_log("Login processing error: " . $e->getMessage());
    json_error("Sign-in failed. Please try again.", 500);
}
