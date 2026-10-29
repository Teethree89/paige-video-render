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
        '400:Invalid Argon check request' => 'The Argon model check was rejected before reaching Google. Verify that PHP sends an empty JSON object to the Worker.',
        '400:Invalid Argon diagnostic request' => 'The Argon diagnostic payload was rejected before Google was called.',
        '504:Argon diagnostic request timed out' => 'Argon did not answer the small synchronous test within 30 seconds. This is inconclusive; no automatic retry was made.',
        '502:Argon reference analysis unavailable' => 'Argon reference analysis did not complete. No background job was submitted and no automatic retry was made.',
        '502:Argon reference analysis invalid' => 'Argon did not return a usable visual description. No background job was submitted and no automatic retry was made.',
        '502:Argon provider redirect blocked' => 'Google returned a redirect that the Worker correctly refused to follow. No redirected request was sent.',
        '503:Argon direct job storage is not configured' => 'The Worker is missing its ARGON_JOBS Durable Object binding. Redeploy it with wrangler.toml; no paid request was made.',
        '502:Argon direct job could not be created' => 'Cloudflare could not create the direct-image job. No paid request was made.',
        '502:Argon direct job status unavailable' => 'Cloudflare could not read the direct-image job status. No new paid request was made; use Resume to check again.',


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
        '502:Argon rejected model configuration' => 'Argon identified the model field as invalid. This alone does not establish a billing or entitlement problem.',
        '502:Argon model metadata check unavailable' => 'Google model metadata could not be checked right now. No generation request was made.',

        '502:Argon rejected Interactions request' => 'Google rejected the Argon request (HTTP 400). No job was created and nothing was retried; see the provider diagnostic in the activity log.',
        '502:Argon rejected interaction status request' => 'Google rejected the Argon status request (HTTP 400) after the job was created. No new paid request was made; see the provider diagnostic in the activity log.',

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

/**
 * Re-validate the Worker's provider diagnostic against fixed vocabulary. It is
 * Google's error-type code plus recognized message classes, never provider
 * prose, prompts, file references, keys or image data. Anything else is dropped.
 * Returns array|null. Production runs PHP 7.0, which has no nullable types.
 */
function safe_worker_diagnostic($value) {
    if (!is_array($value)) return null;
    $known = ['model', 'input', 'background', 'store', 'system_instruction',
        'generation_config', 'thinking_level', 'max_output_tokens', 'response_format',
        'mime_type', 'schema', 'data', 'uri', 'resolution', 'previous_interaction_id',
        'service_tier', 'user_input'];
    // Must match ARGON_DIAG_TERMS in the Worker (tested).
    $knownTerms = [
        'image', 'images', 'media', 'multimodal', 'inline', 'base64', 'jpeg', 'bytes',
        'encoding', 'decode', 'corrupt', 'file', 'content', 'contents', 'part', 'parts',
        'step', 'steps', 'turn', 'role', 'type', 'item', 'items', 'array', 'list',
        'string', 'object', 'oneof', 'value', 'field', 'format', 'text', 'modality',
        'size', 'limit', 'maximum', 'minimum', 'exceed', 'exceeds', 'exceeded', 'too',
        'large', 'long', 'many', 'count', 'number', 'empty', 'missing', 'required',
        'duplicate', 'only', 'one', 'single', 'multiple', 'invalid', 'unsupported',
        'supported', 'not', 'allowed', 'cannot', 'unknown', 'expected', 'must', 'parse',
        'malformed', 'unrecognized', 'permitted', 'stored', 'stateless', 'streaming',
        'interaction', 'interactions', 'mode', 'agent', 'token', 'tokens', 'first',
        'order', 'mixed', 'combination'];
    $codes = $value['codes'] ?? null;
    $fields = $value['fields'] ?? null;
    // Workers older than argon-diagnostic-terms-v1 send no terms.
    $terms = $value['terms'] ?? [];
    $reason = $value['reason'] ?? null;
    $http = $value['http'] ?? null;
    if (!in_array($value['phase'] ?? null, ['create', 'poll', 'job'], true) ||
        ($http !== null && (!is_int($http) || $http < 400 || $http > 599)) ||
        !in_array($value['status'] ?? null, [null, 'failed', 'cancelled', 'incomplete',
            'requires_action', 'budget_exceeded'], true) ||
        !is_string($reason) || !preg_match('/^[a-z][a-z_]{0,47}$/D', $reason) ||
        !is_array($codes) || count($codes) > 4 ||
        !is_array($fields) || count($fields) > count($known) ||
        !is_array($terms) || count($terms) > count($knownTerms))
        return null;
    foreach ($codes as $code)
        if (!is_string($code) ||
            !preg_match('/^(?:[a-z][a-z0-9_]{0,47}|[A-Z][A-Z0-9_]{0,47})$/D', $code)) return null;
    foreach ($fields as $field)
        if (!in_array($field, $known, true)) return null;
    foreach ($terms as $term)
        if (!in_array($term, $knownTerms, true)) return null;
    return ['phase' => $value['phase'], 'http' => $value['http'] ?? null,
        'status' => $value['status'] ?? null, 'reason' => $reason,
        'codes' => array_values($codes), 'fields' => array_values($fields),
        'terms' => array_values($terms)];
}
/** Adds the Worker's sanitized diagnostic, token usage and repair counts, when it sent them. */
function with_diagnostic(array $payload, $workerValue): array {
    $diagnostic = safe_worker_diagnostic(is_array($workerValue) ? ($workerValue['diagnostic'] ?? null) : null);
    $usage = safe_worker_usage(is_array($workerValue) ? ($workerValue['usage'] ?? null) : null);
    $repairs = safe_worker_repairs(is_array($workerValue) ? ($workerValue['repairs'] ?? null) : null);
    if ($diagnostic !== null) $payload += ['diagnostic' => $diagnostic];
    if ($repairs !== null) $payload += ['repairs' => $repairs];
    return $usage === null ? $payload : $payload + ['usage' => $usage];
}
/** Counts of Argon output parts the Worker dropped or fixed. Must match ARGON_REPAIR_CODES (tested). */
function safe_worker_repairs($value) {
    if (!is_array($value)) return null;
    $repairs = [];
    foreach (['json', 'truncated', 'scene', 'empty', 'shot_id', 'scenes_merged', 'object_cap', 'object', 'id',
        'duplicate_id', 'primitive', 'transform', 'scale', 'material', 'repeat', 'footprint',
        'name', 'scene_copies', 'light', 'light_cap', 'camera', 'other'] as $code) {
        if (isset($value[$code]) && is_int($value[$code]) && $value[$code] > 0 && $value[$code] <= 100000)
            $repairs[$code] = $value[$code];
    }
    return $repairs ? $repairs : null;
}
/** Token counts only: these keys, non-negative integers. Must match the Worker's USAGE_KEYS (tested). */
function safe_worker_usage($value) {
    if (!is_array($value)) return null;
    $usage = [];
    foreach (['input', 'inputImage', 'cached', 'thinking', 'output', 'total', 'cap'] as $key) {
        if (isset($value[$key]) && is_int($value[$key]) && $value[$key] >= 0 && $value[$key] <= 100000000)
            $usage[$key] = $value[$key];
    }
    return $usage ? $usage : null;
}

/** Fixed words for a Worker reply that never arrived; never cURL's own text. */
function argon_transport_reason($errno, $received) {
    if ($received) return 'size';
    $reasons = [6 => 'dns', 7 => 'connect', 28 => 'timeout', 35 => 'tls', 51 => 'tls',
        58 => 'tls', 60 => 'tls', 52 => 'reset', 55 => 'reset', 56 => 'reset'];
    return isset($reasons[$errno]) ? $reasons[$errno] : 'other';
}
/** Fixed-target Argon background job transport (only after session+CSRF). */
function argon_worker_call(string $endpoint, string $secret, string $action, array $body,
                           $onRejected = null, array $headers = [], $onLost = null): array {
    if (!in_array($action, ['start', 'direct-start', 'status', 'output', 'clear', 'check', 'diagnostic', 'diagnostic-status'], true)) reject(400, 'Invalid Argon action');
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
        CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json',
            'Authorization: Bearer ' . $secret], $headers),
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => in_array($action, ['start','direct-start','diagnostic'], true) ? 45 : 30,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_RETURNTRANSFER => true
    ]);
    if (defined('CURLOPT_PROTOCOLS')) curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $errno = curl_errno($ch);
    curl_close($ch);
    if (!is_string($response) || strlen($response) > 1500000) {
        if ($onLost !== null) $onLost(argon_transport_reason($errno, is_string($response)));
        reject(502, 'Could not retrieve Argon Worker response');
    }
    $value = json_decode($response, true);
    if ($status < 200 || $status >= 300) {
        $error = is_array($value) && is_string($value['error'] ?? null) ? $value['error'] : '';
        if ($action === 'output' && $status === 404 && $error === 'No saved Argon output')
            reject(404, 'This job has no saved original output: it was cut off before any output was saved, or it ran before outputs were kept.');
        if ($onRejected !== null) $onRejected($error, $status);
        answer($status === 429 ? 429 : 502, with_diagnostic(
            ['ok' => false, 'error' => safe_worker_error($status, $response)], $value));
    }
    if (!is_array($value) || ($value['ok'] ?? false) !== true) {
        if ($onLost !== null) $onLost('invalid');
        reject(502, 'Invalid Argon Worker response');
    }
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
                    'shotId' => $active['shotId'], 'status' => $active['status']],
                 'argonSmoke' => [
                    'step' => min(7, max(0, (int) ($_SESSION['argon_smoke']['step'] ?? 0))),
                    'state' => (string) ($_SESSION['argon_smoke']['state'] ?? 'idle')]]);
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
// Clear only this authenticated session's workspace state. Keep rate limits,
// authentication and CSRF intact so resetting cannot replenish paid quota.
if ($action === 'workspace_clear') {
    if (count(array_diff(array_keys($input), ['action','csrf'])) > 0)
        reject(400, 'Invalid workspace clear request');
    $job = $_SESSION['argon_job'] ?? null;
    if (is_array($job) && (int) ($job['created'] ?? 0) >= time() - 86400 &&
        in_array($job['status'] ?? '', ['queued','in_progress'], true))
        reject(409, 'Finish the active Argon job before clearing the workspace');
    if (($_SESSION['argon_smoke']['state'] ?? '') === 'running')
        reject(409, 'Finish the active diagnostic before clearing the workspace');
    // Direct-image results live in private Worker Durable Object storage.
    // Never forget the session pointer until deletion was confirmed there.
    if (is_array($job) && is_string($job['id'] ?? null) &&
        preg_match('/^(?:dk_|do_)[0-9a-f]{64}$/', $job['id'])) {
        argon_worker_call($workerEndpoint, $secret, 'clear',
            ['jobId' => $job['id'], 'shotId' => $job['shotId']]);
    }
    // Older Previs interactions are stored by Google; unlink this PHP session
    // but do not imply deletion of the provider's independently held records.
    unset($_SESSION['argon_job'], $_SESSION['argon_smoke']);
    answer(200, ['ok' => true, 'cleared' => true]);
}
// Five explicit, fixed-input, potentially billable Argon tests.
// Only one manually confirmed diagnostic submission at a time. Earlier
// successful stages remain completed; a retry must match the failed stage.
$argonSmokeStages = ['text','thinking','image','json','background','background_image','background_combo'];
if ($action === 'argon_diag_reset') {
    if (($_SESSION['argon_smoke']['state'] ?? '') === 'running')
        reject(409, 'An Argon diagnostic is still running; finish polling it first');
    $_SESSION['argon_smoke'] = ['step' => 0, 'state' => 'idle'];
    answer(200, ['ok' => true, 'step' => 0, 'state' => 'idle']);
}
if ($action === 'argon_diag_poll') {
    $smoke = $_SESSION['argon_smoke'] ?? null;
    if (!is_array($smoke) || ($smoke['state'] ?? '') !== 'running' ||
        !is_int($smoke['step'] ?? null) ||
        $smoke['step'] < 4 || $smoke['step'] >= count($argonSmokeStages) ||
        !is_string($smoke['id'] ?? null) ||
        !preg_match('/^[A-Za-z0-9_-]{8,160}$/', $smoke['id']))
        reject(400, 'No background diagnostic is running');
    $result = argon_worker_call($workerEndpoint, $secret, 'diagnostic-status',
        ['id' => $smoke['id'], 'stage' => $argonSmokeStages[$smoke['step']]],
        static function (string $error) use ($smoke) {
            // Google rejected the GET itself. Without this the stage stays
            // "running" forever and blocks both retry and reset. Nothing is
            // resubmitted; a retry still needs explicit paid confirmation.
            if ($error === 'Argon rejected interaction status request')
                $_SESSION['argon_smoke'] = ['step' => $smoke['step'], 'state' => 'failed'];
        });
    $state = $result['status'] ?? '';
    if (in_array($state, ['queued','in_progress'], true))
        answer(200, ['ok' => true, 'step' => $smoke['step'], 'state' => 'running']);
    if ($state === 'completed' && ($result['passed'] ?? false) === true) {
        $next = $smoke['step'] + 1;
        $_SESSION['argon_smoke'] = [
            'step' => $next,
            'state' => $next === count($argonSmokeStages) ? 'done' : 'passed'
        ];
        answer(200, ['ok' => true, 'step' => $next,
            'state' => $_SESSION['argon_smoke']['state'], 'passed' => true]);
    }
    $_SESSION['argon_smoke'] = ['step' => $smoke['step'], 'state' => 'failed'];
    answer(200, with_diagnostic(
        ['ok' => true, 'step' => $smoke['step'], 'state' => 'failed', 'passed' => false], $result));
}
if ($action === 'argon_diag_step') {
    $step = $_SESSION['argon_smoke']['step'] ?? 0;
    $state = $_SESSION['argon_smoke']['state'] ?? 'idle';
    $retry = ($input['retry'] ?? null) === true;
    if (!is_int($step) || $step < 0 || $step >= count($argonSmokeStages) ||
        !is_int($input['step'] ?? null) || $input['step'] !== $step ||
        count(array_diff(array_keys($input), ['action','csrf','step','retry'])) > 0 ||
        (($state === 'failed') !== $retry) ||
        !in_array($state, ['idle','passed','failed'], true))
        reject(409, 'Finish or explicitly retry the current Argon diagnostic step first');
    $window = (int) ($_SESSION['argon_diag_window'] ?? 0);
    if ($window < time() - 86400) {
        $_SESSION['argon_diag_window'] = time();
        $_SESSION['argon_diag_calls'] = 0;
    }
    // Three isolated background requests can now follow the four completed
    // stages. Ten/day still limits paid diagnostic spend per PHP session.
    if ((int) ($_SESSION['argon_diag_calls'] ?? 0) >= 10)
        reject(429, 'Argon diagnostic daily submission limit reached');
    $_SESSION['argon_diag_calls'] = (int) ($_SESSION['argon_diag_calls'] ?? 0) + 1;
    $_SESSION['argon_smoke'] = ['step' => $step, 'state' => 'failed'];
    $result = argon_worker_call($workerEndpoint, $secret, 'diagnostic',
        ['stage' => $argonSmokeStages[$step]]);
    if (($result['status'] ?? '') === 'in_progress' && $step >= 4 &&
        is_string($result['id'] ?? null) &&
        preg_match('/^[A-Za-z0-9_-]{8,160}$/', $result['id'])) {
        $_SESSION['argon_smoke'] = ['step' => $step, 'state' => 'running', 'id' => $result['id']];
        answer(200, ['ok' => true, 'step' => $step, 'state' => 'running']);
    }
    if (($result['status'] ?? '') === 'completed' && ($result['passed'] ?? false) === true) {
        $_SESSION['argon_smoke'] = ['step' => $step + 1,
            'state' => $step === count($argonSmokeStages)-1 ? 'done' : 'passed'];
        answer(200, ['ok' => true, 'step' => $step + 1,
            'state' => $_SESSION['argon_smoke']['state'], 'passed' => true]);
    }
    answer(200, with_diagnostic(
        ['ok' => true, 'step' => $step, 'state' => 'failed', 'passed' => false], $result));
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
// Raw output is an explicit authenticated download, never part of normal polls.
if ($action === 'argon_output') {
    if (count(array_diff(array_keys($input), ['action','csrf'])) > 0)
        reject(400, 'Invalid Argon output request');
    $job = $_SESSION['argon_job'] ?? null;
    if (!is_array($job) || (int) ($job['created'] ?? 0) < time() - 86400)
        reject(404, 'No resumable Argon job in this session');
    if (!preg_match('/^[A-Za-z0-9_-]{8,160}$/', (string) ($job['id'] ?? '')))
        reject(400, 'Invalid Argon job');
    $value = argon_worker_call($workerEndpoint, $secret, 'output',
        ['jobId' => $job['id'], 'shotId' => $job['shotId']]);
    // 280k JS characters can occupy up to 1120k UTF-8 bytes. Nothing else from
    // the provider is forwarded: only model_output text, never steps or inputs.
    if (!is_string($value['output'] ?? null) || strlen($value['output']) === 0 ||
        strlen($value['output']) > 1120000 || !is_bool($value['partial'] ?? null))
        reject(502, 'Invalid Argon output response');
    answer(200, ['ok' => true, 'shotId' => $job['shotId'],
        'output' => $value['output'], 'partial' => $value['partial']]);
}
if ($action === 'argon_status') {
    $job = $_SESSION['argon_job'] ?? null;
    if (!is_array($job) || (int) ($job['created'] ?? 0) < time() - 86400)
        reject(404, 'No resumable Argon job in this session');
    if (!preg_match('/^[A-Za-z0-9_-]{8,160}$/', (string) ($job['id'] ?? '')))
        reject(400, 'Invalid Argon job');
    // A direct-image start whose reply was lost: until the Worker has the job,
    // it is still queued. After 90 seconds no copy of that start can still be
    // arriving, so the poll seals the job: a late start is then refused.
    $unconfirmed = !empty($job['unconfirmed']);
    $seal = $unconfirmed && (int) $job['created'] <= time() - 90;
    $value = argon_worker_call($workerEndpoint, $secret, 'status',
        ['jobId' => $job['id'], 'shotId' => $job['shotId']] + ($seal ? ['seal' => true] : []),
        $unconfirmed ? function ($error, $status) use ($job) {
            if ($status === 404 && $error === 'No resumable Argon job')
                answer(200, ['ok' => true, 'status' => 'queued', 'shotId' => $job['shotId']]);
        } : null);
    if (!in_array($value['status'] ?? '', ['queued','in_progress','completed','failed'], true))
        reject(502, 'Invalid Argon job status');
    unset($_SESSION['argon_job']['unconfirmed']);
    $_SESSION['argon_job']['status'] = $value['status'];
    $phase = $value['phase'] ?? null;
    $elapsed = $value['elapsedSeconds'] ?? null;
    $progress = in_array($phase, ['waiting','reasoning','geometry','validating'], true) &&
        is_int($elapsed) && $elapsed >= 0 && $elapsed <= 1800
        ? ['phase' => $phase, 'elapsedSeconds' => $elapsed] : [];
    answer(200, with_diagnostic(['ok' => true, 'status' => $value['status'],
        'shotId' => $job['shotId']] + $progress +
        (($value['status'] === 'completed' && isset($value['proposal'])) ?
          ['proposal' => $value['proposal']] : []), $value));
}
if ($action !== 'generate' && $action !== 'argon_start')
    reject(400, 'Unsupported action');

// Protect upstream quota; Argon reserves both paid calls before either is sent.
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
        !in_array($input['profile'], ['lite_default', 'g38_low', 'g38_medium', 'argon_previs', 'argon_direct'], true)) {
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
// Whitelist the generation scope explicitly. Never trust a model selector or
// arbitrary prompt sent by the browser. Full scene is only the single Argon
// Direct image call; every other profile is primary subject or passes.
if (array_key_exists('mode', $input)) {
    $mode = $input['mode'];
    if (!in_array($mode, ['primary_subject', 'full_scene'], true) || array_key_exists('layer', $input) ||
        ($mode === 'full_scene' &&
         (($workerInput['profile'] ?? '') !== 'argon_direct' || $action !== 'argon_start'))) {
        reject(400, 'Invalid generation mode');
    }
    $workerInput['mode'] = $mode;
}
// Argon thinking level and detail: fixed allowlists, on Argon starts only.
foreach (['thinking' => ['minimal', 'low', 'medium', 'high'],
          'detail' => ['standard', 'high', 'max']] as $setting => $allowed) {
    if (!array_key_exists($setting, $input)) continue;
    if ($action !== 'argon_start' || !in_array($input[$setting], $allowed, true))
        reject(400, 'Invalid Argon setting');
    $workerInput[$setting] = $input[$setting];
}
// Only the explicit direct-image experiment can request the larger synchronous
// allowance. This remains an allowlist, not a caller-controlled provider setting.
if (array_key_exists('tokenBudget', $input)) {
    if ($action !== 'argon_start' || ($workerInput['profile'] ?? '') !== 'argon_direct' ||
        !in_array($input['tokenBudget'], [32768, 65536], true))
        reject(400, 'Invalid Argon token budget');
    $workerInput['tokenBudget'] = $input['tokenBudget'];
}
// Add Detail is a new paid direct-image call, not a provider continuation.
// Restrict this to a small geometry index and two fixed pass numbers. The
// Worker revalidates each index entry before making any billable request.
if (array_key_exists('detailPass', $input) || array_key_exists('existing', $input)) {
    $prior = $input['existing'] ?? null;
    if ($action !== 'argon_start' || ($workerInput['profile'] ?? '') !== 'argon_direct' ||
        ($workerInput['mode'] ?? '') !== 'full_scene' ||
        !in_array($input['detailPass'] ?? null, [1, 2], true) ||
        !is_array($prior) || count($prior) < 1 || count($prior) >= 240 ||
        strlen((string) json_encode($prior)) > 60000)
        reject(400, 'Invalid Argon detail pass');
    $workerInput['detailPass'] = $input['detailPass'];
    $workerInput['existing'] = $prior;
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
// Paid Argon generation is opt-in: Previs is primary subject only, Direct
// image is primary subject or full scene, never layered passes.
$argonProfiles = ['argon_previs', 'argon_direct'];
if ($action === 'argon_start') {
    $argonModes = ($workerInput['profile'] ?? '') === 'argon_direct'
        ? ['primary_subject', 'full_scene'] : ['primary_subject'];
    if (!in_array($workerInput['profile'] ?? '', $argonProfiles, true) ||
        !in_array($workerInput['mode'] ?? '', $argonModes, true) ||
        array_key_exists('layer', $workerInput))
        reject(400, 'Argon Previs requires Primary subject only');
    $active = $_SESSION['argon_job'] ?? null;
    if (is_array($active) && (int) ($active['created'] ?? 0) >= time() - 86400 &&
        in_array($active['status'] ?? '', ['queued','in_progress'], true))
        reject(409, 'An Argon job is already running. Resume it instead.');
    // Previs: the analysis and background generation each consume a slot.
    // Direct image: one background call, one slot. Reserve before any call;
    // uncertain paid calls are not refunded.
    $slots = $workerInput['profile'] === 'argon_direct' ? 1 : 2;
    if ((int) ($_SESSION['ai_calls'] ?? 0) + $slots > 10)
        reject(429, 'Session AI limit reached');
    $_SESSION['ai_calls'] = (int) ($_SESSION['ai_calls'] ?? 0) + $slots;
    // Direct image runs in the Worker's ARGON_JOBS Durable Object, which holds
    // the long synchronous Gemini call; PHP only starts it and polls. PHP names
    // that job before calling, so a lost reply can still be found by polling
    // and a repeated start of the same job is refused. Only a 4xx answer
    // proves no job was created.
    $direct = $workerInput['profile'] === 'argon_direct';
    $key = $direct ? bin2hex(random_bytes(32)) : '';
    $unconfirmed = function ($reason, $http) use ($shotId) {
        answer(200, ['ok' => true, 'status' => 'queued', 'shotId' => $shotId,
            'startUnconfirmed' => ['reason' => $reason, 'http' => $http]]);
    };
    if ($direct) $_SESSION['argon_job'] = ['id' => 'dk_' . $key, 'shotId' => $shotId,
        'created' => time(), 'status' => 'queued', 'unconfirmed' => true];
    $job = argon_worker_call($workerEndpoint, $secret, $direct ? 'direct-start' : 'start', $workerInput,
        $direct ? function ($error, $status) use ($unconfirmed) {
            if ($status >= 500) $unconfirmed('http', $status);
            unset($_SESSION['argon_job']);
        } : null,
        $direct ? ['X-Argon-Job-Key: ' . $key] : [],
        $direct ? function ($reason) use ($unconfirmed) { $unconfirmed($reason, null); } : null);
    if (!is_string($job['jobId'] ?? null) ||
        !preg_match('/^[A-Za-z0-9_-]{8,160}$/', $job['jobId']) ||
        !in_array($job['status'] ?? '', ['queued','in_progress','completed','failed'], true)) {
        if ($direct) $unconfirmed('invalid', null);
        reject(502, 'Argon Worker returned invalid job');
    }
    $_SESSION['argon_job'] = [
        'id' => $job['jobId'], 'shotId' => $shotId, 'created' => time(),
        'status' => $job['status']
    ];
    answer(200, with_diagnostic(['ok' => true, 'status' => $job['status'], 'shotId' => $shotId], $job));
}
if (in_array($workerInput['profile'] ?? '', $argonProfiles, true))
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
