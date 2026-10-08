<?php
/**
 * CCPL ERP - Attachment backup / removal for the go-live reset (super admin only).
 * POST JSON {action: "list"}                      → JSON backups in backups/ (name, size, time)
 * POST JSON {action: "count"}                     → number and size of attachments (CCPL-IMS/...)
 * POST JSON {action: "backup", stamp: "..."}      → server-side copy of every attachment to backups/attachments-<stamp>/
 * POST JSON {action: "delete", stamp: "..."}      → deletes attachments, but only those that have a verified copy in that backup
 * backup and delete need a valid reset grant (the separate reset password entered on the Backup & Reset page).
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/firebase.php';

apply_security_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method Not Allowed. POST is required.', 405);
}

$user = FirebaseService::requireActiveUser();
if (!FirebaseService::isSuperAdmin($user)) {
    json_error('Only the super admin can manage backups.', 403);
}

$input = get_json_input();
$action = (string)($input['action'] ?? '');
$stamp = (string)($input['stamp'] ?? '');
if (in_array($action, ['backup', 'delete'], true)) {
    if (!preg_match('/^[0-9]{8}-[0-9]{6}$/', $stamp)) {
        json_error('Invalid backup stamp.');
    }
    if (!FirebaseService::hasResetGrant($user)) {
        json_error('The reset password check has expired. Start again.', 403);
    }
}

@set_time_limit(600);
const SOURCE_PREFIX = 'CCPL-IMS/';

try {
    $bucket = FirebaseService::bucket();
    if ($action === 'list') {
        // JSON backups saved by the Backup & Reset page, newest first (attachment copies are in sub-folders).
        $files = [];
        foreach ($bucket->objects(['prefix' => 'backups/', 'delimiter' => '/']) as $o) {
            $info = $o->info();
            $files[] = ['path' => $o->name(), 'name' => basename($o->name()), 'size' => (int)($info['size'] ?? 0), 'created' => (string)($info['timeCreated'] ?? '')];
        }
        usort($files, fn($a, $b) => strcmp($b['created'], $a['created']));
        json_response(['success' => true, 'files' => $files]);
    }
    $objects = [];
    foreach ($bucket->objects(['prefix' => SOURCE_PREFIX]) as $object) {
        $objects[] = $object;
    }
    $target = fn(string $name): string => 'backups/attachments-' . $stamp . '/' . substr($name, strlen(SOURCE_PREFIX));

    if ($action === 'count') {
        $bytes = 0;
        foreach ($objects as $o) $bytes += (int)($o->info()['size'] ?? 0);
        json_response(['success' => true, 'count' => count($objects), 'bytes' => $bytes]);
    }

    if ($action === 'backup') {
        $copied = 0;
        foreach ($objects as $o) {
            $o->copy($bucket, ['name' => $target($o->name())]);
            $copied++;
        }
        json_response(['success' => true, 'copied' => $copied, 'folder' => 'backups/attachments-' . $stamp . '/']);
    }

    if ($action === 'delete') {
        $deleted = 0;
        $missing = [];
        foreach ($objects as $o) {
            $copy = $bucket->object($target($o->name()));
            if (!$copy->exists() || (int)($copy->info()['size'] ?? -1) !== (int)($o->info()['size'] ?? -2)) {
                $missing[] = $o->name();
                continue;
            }
            $o->delete();
            $deleted++;
        }
        if ($missing) {
            json_error(count($missing) . ' attachment(s) have no backup copy and were NOT deleted. Run the backup again.', 409, ['deleted' => $deleted]);
        }
        json_response(['success' => true, 'deleted' => $deleted]);
    }

    json_error('Unknown action.');
} catch (\Throwable $e) {
    error_log('storage-admin.php error: ' . $e->getMessage());
    json_error('Storage operation failed. See the server error log.', 500);
}
