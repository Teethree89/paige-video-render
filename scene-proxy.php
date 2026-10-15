<?php
declare(strict_types=1);

/**
 * Same-origin login + AI scene proxy for the Paige editor.
 *
 * IMPORTANT:
 * - Public code lives in /www/paige-lighthouse.50webs.org/Indium/paiver/.
 * - Actual credentials live ONLY at /www/certificates/paiver.php.
 * - Do not copy the private configuration into this repository or public root.
 * - Fails closed if HTTPS, credentials, PHP sessions or cURL are unavailable.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');

function answer(int $code, array $payload): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function reject(int $code, string $message): void {
    answer($code, ['ok' => false, 'error' => $message]);
}
function is_https(): bool {
    // Do not trust arbitrary X-Forwarded-Proto headers from an internet client.
    return isset($_SERVER['HTTPS'])
        && in_array(strtolower((string) $_SERVER['HTTPS']), ['1', 'on'], true);
}
function same_origin(): bool {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    return is_string($origin) && is_string($host)
        && hash_equals('https://' . strtolower($host), strtolower($origin))
        && ($_SERVER['HTTP_X_PAIGE_CLIENT'] ?? '') === 'SceneStudio';
}
function read_json_body(int $limit): array {
    $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > $limit) reject(413, 'Request is too large');
    if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') !== 0) {
        reject(415, 'Expected JSON request');
    }
    $raw = file_get_contents('php://input', false, null, 0, $limit + 1);
    if (!is_string($raw) || strlen($raw) > $limit) reject(413, 'Request is too large');
    $obj = json_decode($raw, true);
    if (!is_array($obj) || json_last_error() !== JSON_ERROR_NONE) reject(400, 'Invalid JSON request');
    return $obj;
}

if (!is_https()) reject(403, 'HTTPS is required');
if (!extension_loaded('curl')) reject(503, 'PHP cURL extension is required');
if (!function_exists('session_start')) reject(503, 'PHP sessions are required');

// The 50webs file manager displays /www/... as a virtual path. The PHP
// filesystem can have a different account prefix; resolve from this installed
// script rather than assuming the file manager's /www is PHP's true root.
// public: <account-www>/paige-lighthouse.50webs.org/Indium/paiver/
// private: <account-www>/certificates/paiver.php
$privateConfigCandidates = [
    '/home/www/certificates/paiver.php',
    dirname(__DIR__, 3) . '/certificates/paiver.php',
    '/www/certificates/paiver.php',
];
// TEMPORARY READ-ONLY DIAGNOSTIC. No secret/config is opened, no filesystem
// paths are returned, and no supplied path can influence these fixed probes.
// Remove this route when the private-config problem is resolved.
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET'
    && ($_GET['diagnose_private_config'] ?? '') === '1') {
    $probes = [];
    $labels = ['home_www', 'installed_www_root', 'virtual_www'];
    foreach ($privateConfigCandidates as $index => $candidate) {
        error_clear_last();
        $parentVisible = @is_dir(dirname($candidate));
        $parentError = (string) (error_get_last()['message'] ?? '');
        error_clear_last();
        $fileVisible = @is_file($candidate);
        $fileError = (string) (error_get_last()['message'] ?? '');
        error_clear_last();
        $fileReadable = @is_readable($candidate);
        $readError = (string) (error_get_last()['message'] ?? '');
        $allErrors = $parentError . ' ' . $fileError . ' ' . $readError;
        $probes[$labels[$index]] = [
            'directory_visible' => $parentVisible,
            'file_visible' => $fileVisible,
            'file_readable' => $fileReadable,
            'open_basedir_warning' => stripos($allErrors, 'open_basedir') !== false,
        ];
    }
    // Investigate a virtual FTP-root mapping without publishing absolute paths.
    // Never enumerate directories, evaluate PHP, or read the private config.
    $additionalProbes = [];
    for ($level = 2; $level <= 6; $level++) {
        $parent = dirname(__DIR__, $level);
        $candidate = $parent . '/certificates/paiver.php';
        $additionalProbes['script_parent_' . $level] = [
            'directory_visible' => @is_dir(dirname($candidate)),
            'file_visible' => @is_file($candidate),
            'file_readable' => @is_readable($candidate),
        ];
    }
    $docRoot = (string) ($_SERVER['DOCUMENT_ROOT'] ?? '');
    if ($docRoot !== '' && is_dir($docRoot)) {
        for ($level = 0; $level <= 3; $level++) {
            $parent = $level === 0 ? $docRoot : dirname($docRoot, $level);
            $candidate = $parent . '/certificates/paiver.php';
            $additionalProbes['document_root_parent_' . $level] = [
                'directory_visible' => @is_dir(dirname($candidate)),
                'file_visible' => @is_file($candidate),
                'file_readable' => @is_readable($candidate),
            ];
        }
    }
    $anyReadable = false;
    foreach (array_merge($probes, $additionalProbes) as $probe) {
        if ($probe['file_visible'] && $probe['file_readable']) {
            $anyReadable = true;
        }
    }
    answer(200, [
        'ok' => true,
        'diagnostic' => 'private_config_paths_v2',
        'configuration_readable' => $anyReadable,
        'open_basedir_configured' => trim((string) ini_get('open_basedir')) !== '',
        'script_directory_visible' => @is_dir(__DIR__),
        'document_root_visible' => $docRoot !== '' && @is_dir($docRoot),
        'probes' => $probes,
        'ancestor_probes' => $additionalProbes,
        'temporary' => true,
    ]);
}

$privateConfigPath = null;
foreach ($privateConfigCandidates as $candidate) {
    // Intentionally do not disclose internal paths or PHP warnings to clients.
    if (@is_file($candidate) && @is_readable($candidate)) {
        $privateConfigPath = $candidate;
        break;
    }
}
if ($privateConfigPath === null) {
    reject(503, 'Private server configuration is not available');
}
try {
    $config = require $privateConfigPath;
} catch (Throwable $error) {
    reject(503, 'Private server configuration could not be loaded');
}
if (!is_array($config)) reject(503, 'Private server configuration is invalid');

$secret = $config['scene_access_token'] ?? '';
$passphrase = $config['editor_passphrase'] ?? '';
$workerEndpoint = $config['worker_endpoint'] ?? '';
if (!is_string($secret) || strlen($secret) < 32 ||
    !is_string($passphrase) || strlen($passphrase) < 16 ||
    !is_string($workerEndpoint) ||
    strpos($secret, 'PASTE_') !== false || strpos($passphrase, 'CHOOSE_') !== false ||
    strpos($workerEndpoint, 'YOUR_WORKER') !== false) {
    reject(503, 'Private server configuration needs valid values');
}

// Only permit the intended Cloudflare workers.dev endpoint; no arbitrary URLs.
$urlParts = parse_url($workerEndpoint);
if (!is_array($urlParts) || ($urlParts['scheme'] ?? '') !== 'https' ||
    !preg_match('/^[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.workers\\.dev$/i', (string) ($urlParts['host'] ?? '')) ||
    ($urlParts['path'] ?? '') !== '/api/scene' ||
    isset($urlParts['port']) || isset($urlParts['user']) ||
    isset($urlParts['pass']) || isset($urlParts['query']) || isset($urlParts['fragment'])) {
    reject(503, 'Worker endpoint must be an HTTPS workers.dev /api/scene URL');
}

ini_set('session.use_strict_mode', '1');
session_name('__Host-paiver-scene');
session_set_cookie_params([
    'lifetime' => 0, 'path' => '/', 'secure' => true,
    'httponly' => true, 'samesite' => 'Strict'
]);
if (!session_start()) reject(503, 'Could not start a private PHP session');

if (!isset($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    answer(200, ['ok' => true, 'authenticated' => !empty($_SESSION['authenticated']),
                 'csrf' => $_SESSION['csrf']]);
}
if ($method !== 'POST') reject(405, 'Use GET or POST');
if (!same_origin()) reject(403, 'Same-origin editor request required');
$input = read_json_body(1600000);
$action = $input['action'] ?? '';

if ($action === 'login') {
    $now = time();
    if (($now < (int) ($_SESSION['lock_until'] ?? 0))) reject(429, 'Too many attempts; try later');
    $candidate = $input['passphrase'] ?? '';
    if (!is_string($candidate) || strlen($candidate) > 256 ||
        !hash_equals($passphrase, $candidate)) {
        $_SESSION['attempts'] = ((int) ($_SESSION['attempts'] ?? 0)) + 1;
        if ($_SESSION['attempts'] >= 5) {
            $_SESSION['lock_until'] = $now + 900;
            $_SESSION['attempts'] = 0;
        }
        reject(401, 'Incorrect editor passphrase');
    }
    session_regenerate_id(true);
    $_SESSION['authenticated'] = true;
    $_SESSION['attempts'] = 0;
    $_SESSION['lock_until'] = 0;
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    answer(200, ['ok' => true, 'authenticated' => true, 'csrf' => $_SESSION['csrf']]);
}

if (empty($_SESSION['authenticated'])) reject(401, 'Sign in before generating a scene');
$providedCsrf = $input['csrf'] ?? '';
if (!is_string($providedCsrf) || !hash_equals($_SESSION['csrf'], $providedCsrf)) {
    reject(403, 'Invalid editor session token');
}
if ($action === 'logout') {
    $_SESSION = [];
    session_destroy();
    answer(200, ['ok' => true, 'authenticated' => false]);
}
if ($action !== 'generate') reject(400, 'Unsupported action');

// Protect upstream quota; a single session gets at most 10 proposals/hour.
$window = (int) ($_SESSION['ai_window'] ?? 0);
if ($window < time() - 3600) {
    $_SESSION['ai_window'] = time();
    $_SESSION['ai_calls'] = 0;
}
if ((int) ($_SESSION['ai_calls'] ?? 0) >= 10) reject(429, 'Session AI limit reached');
$shotId = $input['shotId'] ?? '';
$frames = $input['frames'] ?? null;
if (!is_string($shotId) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', $shotId)) {
    reject(400, 'Invalid shot ID');
}
if (!is_array($frames) || count($frames) < 1 || count($frames) > 3) {
    reject(400, 'Supply 1 to 3 JPEG frames');
}
$validated = [];
foreach ($frames as $frame) {
    if (!is_array($frame)) reject(400, 'Invalid frame');
    $image = $frame['imageDataUrl'] ?? '';
    $at = $frame['at'] ?? null;
    if (!is_string($image) || strlen($image) > 500000 ||
        !preg_match('/^data:image\\/jpeg;base64,([A-Za-z0-9+\\/=]+)$/D', $image, $matches) ||
        !is_numeric($at) || (float) $at < 0 || (float) $at > 36000) {
        reject(400, 'Invalid JPEG frame');
    }
    $decoded = base64_decode($matches[1], true);
    if ($decoded === false || strlen($decoded) > 350000 ||
        substr($decoded, 0, 2) !== hex2bin('ffd8')) {
        reject(400, 'Invalid frame encoding');
    }
    $validated[] = ['at' => (float) $at, 'imageDataUrl' => $image];
}
$body = json_encode(['shotId' => $shotId, 'frames' => $validated], JSON_UNESCAPED_SLASHES);
if (!is_string($body)) reject(400, 'Could not encode scene request');

$_SESSION['ai_calls'] = (int) ($_SESSION['ai_calls'] ?? 0) + 1;
session_write_close();
$ch = curl_init($workerEndpoint);
if (!$ch) reject(503, 'Could not open the Worker connection');
$response = '';
$tooLarge = false;
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json',
                            'Authorization: Bearer ' . $secret],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT => 55,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_WRITEFUNCTION => static function ($handle, $chunk) use (&$response, &$tooLarge) {
        if (strlen($response) + strlen($chunk) > 1500000) {
            $tooLarge = true;
            return 0;
        }
        $response .= $chunk;
        return strlen($chunk);
    }
]);
if (defined('CURLOPT_PROTOCOLS')) {
    curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
}
$ok = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($tooLarge) reject(502, 'Worker response exceeded safety limit');
if ($ok === false) reject(502, 'Could not reach the AI Worker');
if ($status === 429) reject(429, 'AI request limit reached');
if ($status < 200 || $status >= 300) reject(502, 'The AI Worker rejected this request');
$result = json_decode($response, true);
if (!is_array($result) || json_last_error() !== JSON_ERROR_NONE) {
    reject(502, 'Worker response was not valid JSON');
}
answer(200, ['ok' => true, 'proposal' => $result]);
