<?php
/**
 * CCPL ERP - Resend OTP Endpoint
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/otp-service.php';

apply_security_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method Not Allowed. POST is required.', 405);
}

$input = get_json_input();
$challengeId = trim((string)($input['challenge_id'] ?? ''));
$signature = trim((string)($input['challenge_signature'] ?? ''));

if (empty($challengeId) || empty($signature)) {
    json_error('Challenge details are required.');
}

$ip = get_client_ip();

try {
    $result = OtpService::resendOtp($challengeId, $signature, $ip);
    if (!$result['success']) {
        $statusCode = !empty($result['cooldown']) ? 429 : (!empty($result['session_expired']) ? 410 : 400);
        json_error($result['error'], $statusCode, $result);
    }

    json_response($result);
} catch (\Throwable $e) {
    error_log("Resend error: " . $e->getMessage());
    json_error("Failed to resend code: " . $e->getMessage(), 500);
}
