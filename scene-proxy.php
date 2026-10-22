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
/**
 * Decode ONLY exact, versioned Worker error strings. Never relay arbitrary
 * upstream JSON, provider responses, debug headers or secret material.
 * This runs only after successful PHP session and CSRF authentication.
 */
function safe_worker_error(int $status, string $body): string {
    $payload = json_decode($body, true);
    $error = (is_array($payload) && isset($payload['error']) &&
              is_string($payload['error'])) ? $payload['error'] : '';
    $allowed = [
        '401:Unauthorized' => 'The Worker rejected the PHP access token. Verify the private PHP scene_access_token matches Cloudflare SCENE_ACCESS_TOKEN.',
        '400:Invalid image request' => 'The Worker rejected the sampled video frames. Check JPEG validation and frame sizes.',
        '413:Invalid image request' => 'The sampled frames exceed the Worker request size limit.',
        '503:AI backend is not configured' => 'The AI Worker is missing its runtime configuration.',
        '429:Provider rate limit reached' => 'Gemini rate limit reached. Try later.',
        '504:AI provider request timed out' => 'Gemini took longer than 45 seconds. Try Primary subject only, then retry. See Cloudflare Worker logs if it persists.',
        '504:AI provider extended request timed out' => 'Gemini 3.8 Medium took longer than 70 seconds. Retry later or select 3.8 Low. Longer generation may require asynchronous processing.',
        '502:AI provider network connection failed' => 'The Cloudflare Worker could not reach Gemini. Check sanitized Worker logs for gemini-upstream-fetch and retry.',
        '502:AI provider connection failed' => 'The Worker could not connect to Gemini (older Worker version).',
        '502:AI provider refused the request' => 'Gemini rejected the inference request. Check API access, quota and model availability.',
        '502:AI provider authentication or permission failed' => 'Gemini rejected the provider API credentials or permissions.',
        '502:Requested AI model is unavailable' => 'The configured Gemini model is not available to this API key.',
        '502:AI provider rejected request format' => 'Gemini rejected the submitted frame or model request format.',
        '502:Argon rejected output format configuration' => 'Argon rejected its structured JSON output configuration. The Worker must deploy the corrected response schema.',
        '502:Argon rejected generation configuration' => 'Argon rejected a generation setting (thinking level or token budget). Check the Worker model compatibility.',
        '502:Argon rejected image input configuration' => 'Argon rejected the inline reference image format. Check the Worker image payload contract.',
        '502:Argon rejected background execution configuration' => 'Argon rejected background job settings. Check model support for Interactions background mode.',
        '502:Argon rejected model configuration' => 'Argon rejected the requested model or a model-specific option. Verify paid-tier Argon access.',
        '502:Argon model metadata check unavailable' => 'Google model metadata could not be checked right now. No generation request was made.',

        '502:Argon rejected Interactions request' => 'Argon returned HTTP 400 without a supported field diagnostic. No job was created; review sanitized Worker logs before retrying.',

        '502:AI provider capacity unavailable' => 'Gemini is overloaded (upstream 503). Automatic retries were exhausted. Try again later or select 3.8 Low.',
        '404:No resumable Argon job' => 'Argon job is no longer available. Start another generation if needed.',
        '502:AI provider temporarily unavailable' => 'Gemini returned a temporary server error (upstream 5xx). Try again later or select 3.8 Low.',
        '502:Invalid provider response' => 'Gemini returned an unreadable response.',
        '502:Provider produced no usable scene' => 'Gemini did not produce usable scene JSON.',
        '502:Provider scene did not match the editor schema' => 'Gemini returned geometry that failed scene validation.',
    ];
    $key = (string) $status . ':' . $error;
    if (isset($allowed[$key])) return $allowed[$key];
    if ($status === 401 || $status === 403)
        return 'The Worker request was denied upstream. Check the Cloudflare Worker authentication and access policy.';
    if ($status === 429) return 'The AI Worker is rate limited. Try again later.';
    return 'The AI Worker could not complete the request (upstream status ' .
           (in_array($status, [400, 401, 403, 404, 413, 429, 500, 502, 503, 504], true)
               ? (string) $status : 'other') . ').';
}

/** Fixed-target Argon background job transport (only after session+CSRF). */
function argon_worker_call(string $endpoint, string $secret, string $action, array $body): array {
    if (!in_array($action, ['start', 'status', 'check'], true)) reject(400, 'Invalid Argon action');
    $route = preg_replace('~/api/scene$~', '/api/scene/argon/' . $action, $endpoint);
    // The metadata-only check accepts an empty JSON OBJECT, not an array.
    // PHP json_encode([]) serializes as "[]", which the Worker correctly rejects
    // with HTTP 400 before Google is queried. Always send "{}" for this route.
    $encoded = json_encode($action === 'check' ? (object) [] : $body, JSON_UNESCAPED_SLASHES);
    if (!is_string($encoded) || strlen($encoded) > 1600000) reject(413, 'Invalid Argon request');
    $ch = curl_init($route);
    if (!$ch) reject(503, 'Could not open the Worker connection');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $encoded,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json',
            'Authorization: Bearer ' . $secret],
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => $action === 'start' ? 45 : 30,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_RETURNTRANSFER => true
    ]);
    if (defined('CURLOPT_PROTOCOLS')) curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if (!is_string($response) || strlen($response) > 1500000)
        reject(502, 'Could not retrieve Argon Worker response');
    $value = json_decode($response, true);
    if ($status < 200 || $status >= 300)
        reject($status === 429 ? 429 : 502, safe_worker_error($status, $response));
    if (!is_array($value) || ($value['ok'] ?? false) !== true)
        reject(502, 'Invalid Argon Worker response');
    return $value;
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
    // Only use this option after confirming /.private/deny-check.txt
    // returns HTTP 403 (or a host-confirmed equivalent access denial).
    // Web requests must never be able to retrieve this file or its backups.
    __DIR__ . '/.private/paiver.php',
    '/home/www/certificates/paiver.php',
    dirname(__DIR__, 3) . '/certificates/paiver.php',
    '/www/certificates/paiver.php',
];
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
// The Gemini endpoint is public infrastructure, not a credential.
// Fix it server-side so a mistyped .private config URL cannot break the gateway.
// Do NOT allow requests or user-controlled configuration to alter this target.
$workerEndpoint = 'https://paige-video-render.ivaniscreative.workers.dev/api/scene';

if (!is_string($secret) || strlen($secret) < 32 ||
    !is_string($passphrase) || strlen($passphrase) < 16 ||
    strpos($secret, 'PASTE_') !== false ||
    strpos($passphrase, 'CHOOSE_') !== false) {
    reject(503, 'Private server configuration needs valid values');
}

// 50webs shared hosting may override the PHP defaults. A POST login can
// succeed within one request even when PHP does not issue a session cookie,
// leaving the next POST unauthenticated. Require safe, cookie-only sessions.
ini_set('session.use_cookies', '1');
ini_set('session.use_only_cookies', '1');
ini_set('session.use_trans_sid', '0');
ini_set('session.use_strict_mode', '1');
// These fixed labels reveal configuration capability, never configured
// secrets, cookies, session identifiers or filesystem locations.
if ((string) ini_get('session.use_cookies') !== '1')
    reject(503, 'Secure PHP session setting unavailable: use-cookies');
if ((string) ini_get('session.use_only_cookies') !== '1')
    reject(503, 'Secure PHP session setting unavailable: only-cookies');
if ((string) ini_get('session.use_trans_sid') !== '0')
    reject(503, 'Secure PHP session setting unavailable: trans-sid');
if ((string) ini_get('session.use_strict_mode') !== '1')
    reject(503, 'Secure PHP session setting unavailable: strict-mode');
session_name('__Host-paiver-scene');
// PHP < 7.3 has no array signature for session_set_cookie_params().
// 50webs can silently ignore the array options while session_start() succeeds.
// Keep Secure/HttpOnly and SameSite=Strict on BOTH paths, with no Domain
// attribute (required by the __Host- prefix).
$modernCookieApi = PHP_VERSION_ID >= 70300;
$cookiePath = $modernCookieApi ? '/' : '/; SameSite=Strict';
if ($modernCookieApi) {
    session_set_cookie_params([
        'lifetime' => 0, 'path' => '/', 'domain' => '',
        'secure' => true, 'httponly' => true, 'samesite' => 'Strict'
    ]);
} else {
    // PHP 7.0-7.2: the fixed, non-user-controlled Path suffix yields
    // "Path=/; SameSite=Strict" in the outgoing Set-Cookie header.
    session_set_cookie_params(0, $cookiePath, '', true, true);
}
$cookiePolicy = session_get_cookie_params();
if ((int) ($cookiePolicy['lifetime'] ?? -1) !== 0 ||
    ($cookiePolicy['path'] ?? '') !== $cookiePath ||
    ($cookiePolicy['domain'] ?? null) !== '' ||
    ($cookiePolicy['secure'] ?? false) !== true ||
    ($cookiePolicy['httponly'] ?? false) !== true ||
    ($modernCookieApi && strcasecmp((string) ($cookiePolicy['samesite'] ?? ''), 'Strict') !== 0)) {
    reject(503, 'Secure PHP cookie policy is unavailable');
}
if (!session_start()) reject(503, 'Could not start a private PHP session');

if (!isset($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    $active = !empty($_SESSION['authenticated']) ? ($_SESSION['argon_job'] ?? null) : null;
    if (is_array($active) && (int) ($active['created'] ?? 0) < time() - 86400)
        $active = null;
    answer(200, ['ok' => true, 'authenticated' => !empty($_SESSION['authenticated']),
                 'csrf' => $_SESSION['csrf'],
                 'argonJob' => $active === null ? null : [
                    'shotId' => $active['shotId'], 'status' => $active['status']]]);
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
// Model metadata check is authenticated, no-generation, and does not consume
// the hourly proposal budget. No video frame or client content leaves PHP.
if ($action === 'argon_check') {
    $check = argon_worker_call($workerEndpoint, $secret, 'check', []);
    if (!isset($check['available']) || !is_bool($check['available']) ||
        !in_array($check['check'] ?? '', ['listed', 'not_listed'], true))
        reject(502, 'Invalid Argon model check response');
    answer(200, ['ok' => true, 'available' => $check['available'],
        'check' => $check['check']]);
}
// Polling never consumes a generation quota slot. The Google job ID is
// session-private; callers cannot supply another user's interaction ID.
if ($action === 'argon_status') {
    $job = $_SESSION['argon_job'] ?? null;
    if (!is_array($job) || (int) ($job['created'] ?? 0) < time() - 86400)
        reject(404, 'No resumable Argon job in this session');
    if (!preg_match('/^[A-Za-z0-9_-]{8,160}$/', (string) ($job['id'] ?? '')))
        reject(400, 'Invalid Argon job');
    $value = argon_worker_call($workerEndpoint, $secret, 'status',
        ['jobId' => $job['id'], 'shotId' => $job['shotId']]);
    if (!in_array($value['status'] ?? '', ['queued','in_progress','completed','failed'], true))
        reject(502, 'Invalid Argon job status');
    $_SESSION['argon_job']['status'] = $value['status'];
    answer(200, ['ok' => true, 'status' => $value['status'],
        'shotId' => $job['shotId']] +
        (($value['status'] === 'completed' && isset($value['proposal'])) ?
          ['proposal' => $value['proposal']] : []));
}
if ($action !== 'generate' && $action !== 'argon_start')
    reject(400, 'Unsupported action');

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
$workerInput = ['shotId' => $shotId, 'frames' => $validated];
// Legacy model-only clients remain compatible. New clients select one
// server-defined profile. Reject ambiguous requests rather than guessing.
if (array_key_exists('profile', $input)) {
    if (array_key_exists('model', $input) ||
        !is_string($input['profile']) ||
        !in_array($input['profile'], ['lite_default', 'g38_low', 'g38_medium', 'argon_previs'], true)) {
        reject(400, 'Unsupported AI profile');
    }
    $workerInput['profile'] = $input['profile'];
}
// Optional legacy model selector; both gateways use strict exact allowlists.
if (array_key_exists('model', $input)) {
    if (!is_string($input['model']) ||
        !in_array($input['model'], ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], true)) {
        reject(400, 'Unsupported AI model');
    }
    $workerInput['model'] = $input['model'];
}
// Whitelist the single-pass detail profile explicitly. Never trust a model
// selector or arbitrary prompt sent by the browser.
if (array_key_exists('mode', $input)) {
    if ($input['mode'] !== 'primary_subject' || array_key_exists('layer', $input)) {
        reject(400, 'Invalid generation mode');
    }
    $workerInput['mode'] = 'primary_subject';
}
// Authenticated four-pass environment generation. Validate pass name and count
// before forwarding. The Worker validates every previous object's geometry;
// PHP must never deserialize executable model code or send config secrets.
if (array_key_exists('layer', $input)) {
    $pass = $input['layer'];
    $prior = $input['existing'] ?? [];
    if (!is_string($pass) ||
        !in_array($pass, ['structures','ground','vegetation','details'], true) ||
        !is_array($prior) || count($prior) > 72) {
        reject(400, 'Invalid environment pass');
    }
    $workerInput['layer'] = $pass;
    $workerInput['existing'] = $prior;
}
// Paid Argon background generation is opt-in and primary-subject only.
if ($action === 'argon_start') {
    if (($workerInput['profile'] ?? '') !== 'argon_previs' ||
        ($workerInput['mode'] ?? '') !== 'primary_subject' ||
        array_key_exists('layer', $workerInput))
        reject(400, 'Argon Previs requires Primary subject only');
    $active = $_SESSION['argon_job'] ?? null;
    if (is_array($active) && (int) ($active['created'] ?? 0) >= time() - 86400 &&
        in_array($active['status'] ?? '', ['queued','in_progress'], true))
        reject(409, 'An Argon job is already running. Resume it instead.');
    // One paid job is charged against the existing per-session generation quota.
    $_SESSION['ai_calls'] = (int) ($_SESSION['ai_calls'] ?? 0) + 1;
    $job = argon_worker_call($workerEndpoint, $secret, 'start', $workerInput);
    if (!is_string($job['jobId'] ?? null) ||
        !preg_match('/^[A-Za-z0-9_-]{8,160}$/', $job['jobId']) ||
        !in_array($job['status'] ?? '', ['queued','in_progress','completed','failed'], true))
        reject(502, 'Argon Worker returned invalid job');
    $_SESSION['argon_job'] = [
        'id' => $job['jobId'], 'shotId' => $shotId, 'created' => time(),
        'status' => $job['status']
    ];
    answer(200, ['ok' => true, 'status' => $job['status'], 'shotId' => $shotId]);
}
if (($workerInput['profile'] ?? '') === 'argon_previs')
    reject(400, 'Use the Argon background job endpoint');
// Medium may take longer; it is deliberately disallowed in the 4-pass mode.
if (($workerInput['profile'] ?? '') === 'g38_medium' &&
    (($workerInput['mode'] ?? '') !== 'primary_subject' ||
     array_key_exists('layer', $workerInput))) {
    reject(400, 'Medium thinking requires Primary subject only');
}
$body = json_encode($workerInput, JSON_UNESCAPED_SLASHES);
if (!is_string($body)) reject(400, 'Could not encode scene request');

$_SESSION['ai_calls'] = (int) ($_SESSION['ai_calls'] ?? 0) + 1;
session_write_close();
$ch = curl_init($workerEndpoint);
if (!$ch) reject(503, 'Could not open the Worker connection');
$response = '';
$tooLarge = false;
// PHP/cURL can wait longer ONLY for the explicit medium profile. The 50webs
// host may impose a stricter timeout; this is not a guarantee of 85s runtime.
$curlTimeout = (($workerInput['profile'] ?? '') === 'g38_medium') ? 85 : 55;
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json',
                            'Authorization: Bearer ' . $secret],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT => $curlTimeout,
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
if ($status < 200 || $status >= 300) reject(502, safe_worker_error($status, $response));
$result = json_decode($response, true);
if (!is_array($result) || json_last_error() !== JSON_ERROR_NONE) {
    reject(502, 'Worker response was not valid JSON');
}
answer(200, ['ok' => true, 'proposal' => $result]);
