<?php
/**
 * CCPL ERP - OTP Verification Endpoint (Step 2: Verify OTP & mint Firebase Custom Token)
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/firebase.php';
require_once __DIR__ . '/otp-service.php';

apply_security_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method Not Allowed. POST is required.', 405);
}

$input = get_json_input();
$challengeId = trim((string)($input['challenge_id'] ?? ''));
$signature = trim((string)($input['challenge_signature'] ?? ''));
$otp = trim((string)($input['otp'] ?? ''));

if (empty($challengeId) || empty($signature) || empty($otp)) {
    json_error('Challenge details and 6-digit OTP code are required.');
}

$ip = get_client_ip();

// Verify OTP
$verifyResult = OtpService::verifyOtp($challengeId, $signature, $otp, $ip);
if (!$verifyResult['success']) {
    $statusCode = !empty($verifyResult['session_expired']) ? 410 : 400;
    json_error($verifyResult['error'], $statusCode, $verifyResult);
}

$uid = $verifyResult['uid'];

// Mint Firebase Custom Token for the verified user
try {
    $customToken = FirebaseService::createCustomToken($uid);
    json_response([
        'success' => true,
        'message' => 'OTP verified successfully.',
        'custom_token' => $customToken,
        'uid' => $uid,
    ]);
} catch (\Throwable $e) {
    error_log("Custom token minting failed for UID {$uid}: " . $e->getMessage());
    json_error('Failed to establish authenticated session. Please try again.', 500);
}
