<?php
/**
 * CCPL ERP - Logout Endpoint
 */

require_once __DIR__ . '/config.php';

apply_security_headers();

if (session_status() === PHP_SESSION_ACTIVE) {
    session_unset();
    session_destroy();
}

json_response([
    'success' => true,
    'message' => 'Logged out successfully.'
]);
