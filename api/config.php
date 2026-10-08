<?php
/**
 * CCPL ERP - API Configuration & Common Utilities
 */

// Block direct URL access to library file
if (isset($_SERVER['SCRIPT_FILENAME']) && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'])) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Direct access forbidden']);
    exit;
}

// Ensure error display is off in API responses to avoid leaking paths
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Autoload composer packages
$autoloadPath = dirname(__DIR__) . '/vendor/autoload.php';
if (!file_exists($autoloadPath)) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Server misconfiguration: vendor dependencies not installed.']);
    exit;
}
require_once $autoloadPath;

// Load environment variables from .env file if available
function load_env_file(): void {
    // Preferred: one level ABOVE the public web root (e.g. /home/<user>/.env next to public_html),
    // so the file can never be downloaded. The in-root locations are kept only for older installs.
    $possiblePaths = [
        dirname(__DIR__, 2) . '/.env',
        dirname(__DIR__) . '/.env',
        __DIR__ . '/.env'
    ];

    foreach ($possiblePaths as $path) {
        if (file_exists($path) && is_readable($path)) {
            $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            foreach ($lines as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#')) {
                    continue;
                }
                $parts = explode('=', $line, 2);
                if (count($parts) === 2) {
                    $key = trim($parts[0]);
                    $val = trim($parts[1]);
                    // Strip quotes if wrapped
                    if ((str_starts_with($val, '"') && str_ends_with($val, '"')) ||
                        (str_starts_with($val, "'") && str_ends_with($val, "'"))) {
                        $val = substr($val, 1, -1);
                    }
                    if (!isset($_ENV[$key]) && getenv($key) === false) {
                        putenv("{$key}={$val}");
                        $_ENV[$key] = $val;
                        $_SERVER[$key] = $val;
                    }
                }
            }
            break;
        }
    }

    // Optional config.local.php override
    $localConfig = __DIR__ . '/config.local.php';
    if (file_exists($localConfig)) {
        $localVars = require $localConfig;
        if (is_array($localVars)) {
            foreach ($localVars as $k => $v) {
                putenv("{$k}={$v}");
                $_ENV[$k] = $v;
                $_SERVER[$k] = $v;
            }
        }
    }
}

load_env_file();

/**
 * Get config variable with fallback
 */
function env(string $key, mixed $default = null): mixed {
    $val = getenv($key);
    if ($val !== false && $val !== '') {
        return $val;
    }
    if (isset($_ENV[$key]) && $_ENV[$key] !== '') {
        return $_ENV[$key];
    }
    if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') {
        return $_SERVER[$key];
    }

    // Non-secret fallbacks only. Passwords / keys must come from .env (kept ABOVE public_html) or config.local.php.
    $defaults = [
        'FIREBASE_PROJECT_ID' => 'ccpl-ims',
        'FIREBASE_SERVICE_ACCOUNT_PATH' => 'service-account.json',
        'ALLOWED_ORIGINS' => ''
    ];

    if ($default !== null && $default !== '') {
        return $default;
    }

    if (isset($defaults[$key])) {
        return $defaults[$key];
    }

    return $default;
}

/**
 * Send JSON response and exit
 */
function json_response(array $data, int $statusCode = 200): void {
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Send JSON error response and exit
 */
function json_error(string $message, int $statusCode = 400, array $extra = []): void {
    json_response(array_merge(['success' => false, 'error' => $message], $extra), $statusCode);
}

/**
 * Read and decode JSON request payload
 */
function get_json_input(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/**
 * Securely get client IP
 */
function get_client_ip(): string {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    // If behind reverse proxy, check HTTP_X_FORWARDED_FOR
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        $candidate = trim($parts[0]);
        if (filter_var($candidate, FILTER_VALIDATE_IP)) {
            $ip = $candidate;
        }
    }
    return $ip;
}

/**
 * Apply standard security and CORS headers
 */
function apply_security_headers(): void {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: strict-origin-when-cross-origin');

    // CORS Handling
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = env('ALLOWED_ORIGINS', '');
    $allowedList = array_map('trim', explode(',', $allowed));

    // If request comes from same host or allowed origin
    $currentHost = $_SERVER['HTTP_HOST'] ?? '';
    $currentHostName = explode(':', $currentHost)[0];
    $isAllowed = false;
    if ($origin) {
        $parsedOrigin = parse_url($origin, PHP_URL_HOST);
        if ($parsedOrigin && ($parsedOrigin === $currentHostName || $parsedOrigin === $currentHost || in_array($origin, $allowedList, true))) {
            header("Access-Control-Allow-Origin: {$origin}");
            header('Access-Control-Allow-Credentials: true');
            $isAllowed = true;
        }
    }

    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        if ($isAllowed) {
            header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
            header('Access-Control-Max-Age: 86400');
        }
        http_response_code(204);
        exit;
    }
}

/**
 * Mask email address for user presentation (e.g. r***r@cognizantchemical.com)
 */
function mask_email(string $email): string {
    $parts = explode('@', $email);
    if (count($parts) !== 2) {
        return '***';
    }
    $name = $parts[0];
    $domain = $parts[1];
    $len = strlen($name);
    if ($len <= 2) {
        $maskedName = substr($name, 0, 1) . '***';
    } else {
        $maskedName = substr($name, 0, 1) . str_repeat('*', min(4, $len - 2)) . substr($name, -1);
    }
    return $maskedName . '@' . $domain;
}
