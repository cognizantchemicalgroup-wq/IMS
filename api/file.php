<?php
/**
 * CCPL ERP - Private document download.
 * Attachments live in a private Storage bucket; there are no public links. The browser asks for a file with the
 * signed-in user's Firebase ID token and this endpoint streams it only to active ERP users.
 *   GET api/file.php?path=CCPL-IMS/receipts/<id>/<file>         (any active user)
 *   GET api/file.php?path=backups/<file>                        (super admin only)
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/firebase.php';

apply_security_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Method Not Allowed.', 405);
}

$user = FirebaseService::requireActiveUser();

$path = (string)($_GET['path'] ?? '');
if ($path === '' || strlen($path) > 512 || str_contains($path, '..') || !preg_match('#^(CCPL-IMS|backups)/[A-Za-z0-9._()\- /]+$#', $path)) {
    json_error('Invalid file path.', 400);
}
if (str_starts_with($path, 'backups/') && !FirebaseService::isSuperAdmin($user)) {
    json_error('Not allowed.', 403);
}

try {
    $object = FirebaseService::bucket()->object($path);
    if (!$object->exists()) {
        json_error('File not found.', 404);
    }
    $info = $object->info();
    $type = (string)($info['contentType'] ?? 'application/octet-stream');
    $inline = (bool)preg_match('#^(application/pdf|image/(jpeg|png))$#', $type);
    $name = preg_replace('/[^A-Za-z0-9._-]+/', '_', basename($path));

    header('Content-Type: ' . ($inline ? $type : 'application/octet-stream'));
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . $name . '"');
    header('Cache-Control: private, no-store, max-age=0');
    header('Content-Security-Policy: sandbox; default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'');
    header('X-Robots-Tag: noindex, nofollow, noarchive');
    if (isset($info['size'])) {
        header('Content-Length: ' . (int)$info['size']);
    }
    $stream = $object->downloadAsStream();
    while (!$stream->eof()) {
        echo $stream->read(65536);
        flush();
    }
} catch (\Throwable $e) {
    error_log('file.php error: ' . $e->getMessage());
    if (!headers_sent()) {
        json_error('Could not read the file.', 500);
    }
}
