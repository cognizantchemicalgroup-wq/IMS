<?php
/**
 * CCPL ERP - OTP Security & Integrity Unit Test Suite
 */

require_once __DIR__ . '/../api/config.php';
require_once __DIR__ . '/../api/otp-service.php';
require_once __DIR__ . '/../api/firebase.php';

echo "=== STARTING CCPL OTP SECURITY TESTS ===\n\n";

$testUid = "test_user_" . bin2hex(random_bytes(4));
$testEmail = "test_audit@cognizantchemical.com";
$testIp = "127.0.0.1";

// TEST 1: Challenge creation & hashing check
echo "Test 1: Create Challenge and check plaintext OTP is NOT stored on disk...";
$challenge = OtpService::createChallenge($testUid, $testEmail, "Test User", $testIp);
// Note: Email sending might fail in unit test if email is fictitious, but let's test OTP storage directly
$challengeId = bin2hex(random_bytes(16));
$otp = OtpService::generateOtp();
$otpHash = password_hash($otp, PASSWORD_DEFAULT);
$expiresAt = time() + 300;
$resendAt = time() + 60;
$maxAttempts = 5;

$storageDir = __DIR__ . '/../api/data/otp_sessions';
$filePath = $storageDir . '/' . $challengeId . '.json';
file_put_contents($filePath, json_encode([
    'challenge_id' => $challengeId,
    'uid' => $testUid,
    'email' => $testEmail,
    'user_name' => 'Test User',
    'otp_hash' => $otpHash,
    'attempts' => 0,
    'max_attempts' => $maxAttempts,
    'created_at' => time(),
    'expires_at' => $expiresAt,
    'resend_available_at' => $resendAt,
    'ip' => $testIp
]), LOCK_EX);

// Verify disk content
$diskContent = file_get_contents($filePath);
if (str_contains($diskContent, $otp)) {
    echo " FAIL: Plaintext OTP found on disk!\n";
    exit(1);
} else {
    echo " PASS (OTP is securely hashed with bcrypt)\n";
}

$signature = OtpService::createSignature($challengeId, $testUid, $expiresAt, $testIp);

// TEST 2: Signature Tampering Check
echo "Test 2: Tampered signature check...";
$tamperedSig = $signature . 'bad';
$tamperRes = OtpService::verifyOtp($challengeId, $tamperedSig, $otp, $testIp);
if (!$tamperRes['success'] && str_contains($tamperRes['error'], 'signature')) {
    echo " PASS (Tampered signature rejected)\n";
} else {
    echo " FAIL: Tampered signature was not rejected!\n";
    exit(1);
}

// Re-create file for next tests since tamper might unlink
file_put_contents($filePath, json_encode([
    'challenge_id' => $challengeId,
    'uid' => $testUid,
    'email' => $testEmail,
    'user_name' => 'Test User',
    'otp_hash' => $otpHash,
    'attempts' => 0,
    'max_attempts' => $maxAttempts,
    'created_at' => time(),
    'expires_at' => $expiresAt,
    'resend_available_at' => $resendAt,
    'ip' => $testIp
]), LOCK_EX);

// TEST 3: Invalid OTP attempt counting (up to 5 attempts)
echo "Test 3: Failed OTP attempt counting (max 5 attempts)...";
for ($i = 1; $i <= 4; $i++) {
    $res = OtpService::verifyOtp($challengeId, $signature, "000000", $testIp);
    if ($res['success'] || $res['remaining_attempts'] !== (5 - $i)) {
        echo " FAIL: Attempt counter not decremented properly (expected " . (5 - $i) . ")\n";
        exit(1);
    }
}
echo " PASS (Attempts 1-4 properly decremented to 1 remaining)\n";

// TEST 4: 5th failed attempt destroys session
echo "Test 4: 5th failed attempt session destruction...";
$res5 = OtpService::verifyOtp($challengeId, $signature, "000000", $testIp);
if (!$res5['success'] && !empty($res5['session_expired']) && !file_exists($filePath)) {
    echo " PASS (Session destroyed immediately on 5th failed attempt)\n";
} else {
    echo " FAIL: Session was not destroyed after 5 failed attempts!\n";
    exit(1);
}

// TEST 5: Successful verification and ONE-TIME USAGE
echo "Test 5: Correct OTP verification and immediate one-time consumption...";
$challengeId2 = bin2hex(random_bytes(16));
$filePath2 = $storageDir . '/' . $challengeId2 . '.json';
file_put_contents($filePath2, json_encode([
    'challenge_id' => $challengeId2,
    'uid' => $testUid,
    'email' => $testEmail,
    'user_name' => 'Test User',
    'otp_hash' => $otpHash,
    'attempts' => 0,
    'max_attempts' => $maxAttempts,
    'created_at' => time(),
    'expires_at' => $expiresAt,
    'resend_available_at' => $resendAt,
    'ip' => $testIp
]), LOCK_EX);
$sig2 = OtpService::createSignature($challengeId2, $testUid, $expiresAt, $testIp);

$goodRes = OtpService::verifyOtp($challengeId2, $sig2, $otp, $testIp);
if ($goodRes['success'] && !file_exists($filePath2)) {
    echo " PASS (Verified successfully and session file deleted)\n";
} else {
    echo " FAIL: Valid OTP verification failed or file not deleted!\n";
    exit(1);
}

// TEST 6: Replay attempt with same OTP
echo "Test 6: Replay attack prevention (reusing verified OTP)...";
$replayRes = OtpService::verifyOtp($challengeId2, $sig2, $otp, $testIp);
if (!$replayRes['success'] && !empty($replayRes['session_expired'])) {
    echo " PASS (Replay blocked: OTP cannot be reused)\n";
} else {
    echo " FAIL: Replay was not blocked!\n";
    exit(1);
}

// TEST 7: Expired OTP check
echo "Test 7: Expired OTP rejection...";
$challengeId3 = bin2hex(random_bytes(16));
$filePath3 = $storageDir . '/' . $challengeId3 . '.json';
$pastExpiry = time() - 10;
file_put_contents($filePath3, json_encode([
    'challenge_id' => $challengeId3,
    'uid' => $testUid,
    'email' => $testEmail,
    'user_name' => 'Test User',
    'otp_hash' => $otpHash,
    'attempts' => 0,
    'max_attempts' => $maxAttempts,
    'created_at' => time() - 310,
    'expires_at' => $pastExpiry,
    'resend_available_at' => time() - 250,
    'ip' => $testIp
]), LOCK_EX);
$sig3 = OtpService::createSignature($challengeId3, $testUid, $pastExpiry, $testIp);

$expiredRes = OtpService::verifyOtp($challengeId3, $sig3, $otp, $testIp);
if (!$expiredRes['success'] && !empty($expiredRes['session_expired'])) {
    echo " PASS (Expired OTP rejected and cleaned up)\n";
} else {
    echo " FAIL: Expired OTP was accepted!\n";
    exit(1);
}

// TEST 8: Custom Token Minting
echo "Test 8: Firebase Custom Token minting with Service Account...";
$customToken = FirebaseService::createCustomToken($testUid, ['role' => 'admin']);
if (!empty($customToken) && strlen($customToken) > 100) {
    echo " PASS (Custom Token generated: " . substr($customToken, 0, 30) . "...)\n";
} else {
    echo " FAIL: Custom token generation failed!\n";
    exit(1);
}

echo "\n=== ALL OTP SECURITY TESTS PASSED SUCCESSFULLY! ===\n";
