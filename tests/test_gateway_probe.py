"""Ensure deployment probe never outputs server secrets or CSRF."""
import contextlib
import importlib.util
import io
import json
import pathlib
import re
import shutil
import subprocess
import unittest
import tomllib
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "check_live_gateway.py"
spec = importlib.util.spec_from_file_location("check_live_gateway", path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GatewaySmokeTests(unittest.TestCase):
    def test_cloudflare_observability_persists_across_git_deploys(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        with (root / "wrangler.toml").open("rb") as config:
            worker = tomllib.load(config)
        self.assertEqual(worker["name"], "paige-video-render")
        self.assertEqual(worker["main"], "worker/scene-worker.mjs")
        # Direct-image jobs need a SQLite-backed Durable Object: the only kind
        # the Workers Free plan offers.
        self.assertEqual(worker["durable_objects"]["bindings"],
                         [{"name": "ARGON_JOBS", "class_name": "ArgonJob"}])
        self.assertEqual(worker["migrations"], [{"tag": "v1", "new_sqlite_classes": ["ArgonJob"]}])
        self.assertIn("export class ArgonJob",
                      (root / "worker" / "scene-worker.mjs").read_text())
        self.assertEqual(worker["observability"]["logs"], {
            "enabled": True,
            "invocation_logs": True,
            "persist": True,
        })

    def test_private_url_rules_match_real_paths_and_keep_denial_mandatory(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        editor_rules = (root / ".htaccess").read_text()
        private_rules = (root / "public-private-guard" / ".htaccess").read_text()

        # These are the exact .htaccess files staged by the FTP publisher.
        self.assertIn("Require all denied", private_rules.splitlines())
        self.assertIn(
            "ErrorDocument 403 https://paige-lighthouse.50webs.org/Indium/paiver/",
            private_rules.splitlines(),
        )
        native_line = next(line for line in editor_rules.splitlines()
                           if line.startswith("RedirectMatch 302 "))
        rewrite_line = next(line for line in editor_rules.splitlines()
                            if line.startswith("RewriteRule "))
        native_pattern = native_line.split()[2]
        rewrite_pattern = rewrite_line.split()[1]
        for route in ("/Indium/paiver/.private/paiver.php",
                      "/Indium/paiver/.private/deny-check.txt",
                      "/Indium/paiver/.private/"):
            self.assertIsNotNone(re.search(native_pattern, route), route)
        self.assertIsNotNone(re.search(rewrite_pattern, ".private/paiver.php"))
        for route in ("/Indium/paiver/.privacy/file",
                      "/Indium/paiver/public.html"):
            self.assertIsNone(re.search(native_pattern, route), route)
        self.assertEqual(native_line.split()[3], "/Indium/paiver/")
        self.assertEqual(rewrite_line.split()[2], "/Indium/paiver/")

    def test_safe_success_logs_only_status_and_flags(self):
        token = "PRIVATE_NEVER_LOG_123456"
        csrf = "CSRF_NEVER_LOG_7654321"

        def fake_get(url, inspect_body=False):
            if url.endswith("/health"):
                return 200, b'{"ready":true,"model":"gemini-3.5-flash-lite","generationProfile":"layered-environment-v1"}', None
            if url.endswith("/403.html"):
                return 200, b"<html>Access denied. Return to editor.</html>", None
            if url.endswith("/.private/deny-check.txt"):
                return 403, b"Forbidden", None
            if url.endswith("/.private/paiver.php"):
                self.assertFalse(inspect_body)
                return 403, b"", None
            if url.endswith("/scene-proxy.php"):
                return 200, json.dumps({"ok": True, "authenticated": False,
                                        "csrf": csrf, "password": token}).encode(), None
            self.fail(f"Unexpected URL: {url}")

        def fake_protected(url, inspect_body=False):
            if url.endswith("/.private/deny-check.txt"):
                return 302, b"", probe.EDITOR
            if url.endswith("/.private/paiver.php"):
                self.assertFalse(inspect_body)
                return 302, b"", probe.EDITOR
            self.fail(f"Unexpected protected URL: {url}")

        output = io.StringIO()
        with patch.object(probe, "fetch", side_effect=fake_get), \
             patch.object(probe, "fetch_protected", side_effect=fake_protected), \
             patch.object(probe, "check_session_continuity", return_value=(True, True, "ok", 200)):
            with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(probe.run(), 0)
        self.assertIn("model_current=true", output.getvalue())
        self.assertIn("detail_profile_live=true", output.getvalue())
        self.assertIn("RESULT: PASS", output.getvalue())
        self.assertNotIn(token, output.getvalue())
        self.assertNotIn(csrf, output.getvalue())

    def test_session_continuity_uses_only_in_memory_csrf_comparison(self):
        from types import SimpleNamespace

        csrf = "NOT_FOR_LOGGING_" + "x" * 48
        # Exactly 64 bytes, so the diagnostic validates the response shape.
        csrf = csrf[:64]
        jar = [SimpleNamespace(name="__Host-paiver-scene", secure=True, path="/")]
        class FakeResponse:
            status = 200
            def __init__(self, value):
                self.value = value
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, amount):
                return json.dumps({"ok": True, "authenticated": False,
                                   "csrf": self.value}).encode()
        class FakeOpener:
            def __init__(self): self.calls = 0
            def open(self, request, timeout=18):
                self.calls += 1
                return FakeResponse(csrf)
        opener = FakeOpener()
        with patch.object(probe, "CookieJar", return_value=jar), \
             patch.object(probe, "build_opener", return_value=opener):
            self.assertEqual(probe.check_session_continuity(), (True, True, "ok", 200))
            self.assertEqual(opener.calls, 2)

        class RotatedOpener(FakeOpener):
            def open(self, request, timeout=18):
                self.calls += 1
                return FakeResponse(csrf if self.calls == 1 else "y" * 64)
        with patch.object(probe, "CookieJar", return_value=jar), \
             patch.object(probe, "build_opener", return_value=RotatedOpener()):
            self.assertEqual(probe.check_session_continuity(), (True, False, "server-session-rotated", 200))

    def test_php_proxy_uses_only_syntax_the_production_php_70_host_parses(self):
        # The live host reports X-Powered-By: PHP/7.0.33, but CI's php -l uses
        # a newer PHP. A 7.1+ construct is a parse error in production, so
        # every request becomes an empty HTTP 500 (regression from PR #74).
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        forbidden = {
            "nullable parameter type": r"[(,]\s*\?\s*[A-Za-z_\\]\w*\s+&?(?:\.\.\.)?\$",
            "nullable return type": r"\)\s*:\s*\?\s*[A-Za-z_\\]",
            "closure return type": r"\bfunction\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?:",
            "null coalescing assignment": r"\?\?=",
            "arrow function": r"\bfn\s*\(",
            "nullsafe operator": r"\?->",
            "match expression": r"\bmatch\s*\(",
        }
        for name, pattern in forbidden.items():
            with self.subTest(construct=name):
                self.assertIsNone(re.search(pattern, php), name)
        # In PHP 7.0, "void" is just a class name. It is only safe on the two
        # helpers that always exit and therefore never return a value.
        self.assertEqual(
            sorted(re.findall(r"\bfunction\s+(\w+)\s*\([^)]*\)\s*:\s*void\b", php)),
            ["answer", "reject"])

    def test_php_requires_secure_cookie_only_sessions_before_start(self):
        script = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        start = script.index("if (!session_start())")
        for setting, value in (("session.use_cookies", "1"),
                               ("session.use_only_cookies", "1"),
                               ("session.use_trans_sid", "0"),
                               ("session.use_strict_mode", "1")):
            declaration = f"ini_set('{setting}', '{value}');"
            self.assertIn(declaration, script[:start])
        self.assertIn("'httponly' => true", script[:start])
        self.assertIn("'secure' => true", script[:start])
        self.assertIn("'samesite' => 'Strict'", script[:start])
        self.assertIn("Secure PHP cookie policy is unavailable", script[:start])
        self.assertIn("'domain' => ''", script[:start])
        self.assertEqual(
            probe.proxy_error_category(
                b'{"ok":false,"error":"Secure PHP cookie sessions are required"}'),
            "php-cookie-sessions-unavailable"
        )

    def test_php_legacy_cookie_handling_has_fixed_samesite_suffix(self):
        script = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("PHP_VERSION_ID >= 70300", script)
        self.assertIn("'/; SameSite=Strict'", script)
        self.assertIn("session_set_cookie_params(0, $cookiePath, '', true, true);", script)
        self.assertIn("'samesite' => 'Strict'", script)
        self.assertIn("($modernCookieApi && strcasecmp(", script)

    @unittest.skipUnless(shutil.which("php"), "PHP CLI required (available in CI)")
    def test_generation_scope_is_strictly_validated_and_forwarded_by_php(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        # The real profile, model, scope, pass and Argon-start checks, up to
        # the session/slot logic, run against each request below.
        start = php.index("$workerInput = ['shotId' => $shotId, 'frames' => $validated];")
        end = php.index("    $active = $_SESSION['argon_job'] ?? null;")
        harness = '''<?php
$case = json_decode(stream_get_contents(STDIN), true);
$input = $case['input']; $action = $case['action']; $shotId = 'draft_001'; $validated = [];
function reject($status, $message) { echo json_encode(['status' => $status, 'error' => $message]); exit; }
function forwarded() { global $workerInput; echo json_encode(['status' => 200, 'worker' => $workerInput]); exit; }
''' + php[start:end] + "forwarded(); }\nforwarded();\n"
        cases = [
            ('generate', {'mode': 'primary_subject'}, 200, 'primary_subject'),
            ('generate', {'profile': 'g38_medium', 'mode': 'primary_subject'}, 200, 'primary_subject'),
            ('generate', {}, 200, None),
            ('argon_start', {'profile': 'argon_direct', 'mode': 'full_scene'}, 200, 'full_scene'),
            ('argon_start', {'profile': 'argon_direct', 'mode': 'primary_subject'}, 200, 'primary_subject'),
            ('argon_start', {'profile': 'argon_previs', 'mode': 'primary_subject'}, 200, 'primary_subject'),
            # Full scene is ONE Argon Direct image call, nothing else.
            ('argon_start', {'profile': 'argon_previs', 'mode': 'full_scene'}, 400, None),
            ('generate', {'profile': 'argon_direct', 'mode': 'full_scene'}, 400, None),
            ('generate', {'profile': 'g38_low', 'mode': 'full_scene'}, 400, None),
            ('generate', {'mode': 'full_scene'}, 400, None),
            ('argon_start', {'profile': 'argon_direct'}, 400, None),
            ('argon_start', {'profile': 'argon_direct', 'mode': 'environment'}, 400, None),
            ('argon_start', {'profile': 'argon_direct', 'mode': 'full_scene', 'layer': 'structures'}, 400, None),
            ('generate', {'mode': 'primary_subject', 'layer': 'structures'}, 400, None),
            ('generate', {'mode': ['full_scene']}, 400, None),
        ]
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            script = pathlib.Path(folder) / "scope.php"
            script.write_text(harness)
            for action, extra, status, mode in cases:
                with self.subTest(action=action, input=extra):
                    result = subprocess.run(["php", str(script)],
                        input=json.dumps({'action': action, 'input': extra}),
                        text=True, capture_output=True, check=True)
                    value = json.loads(result.stdout)
                    self.assertEqual(value['status'], status, value)
                    if status == 200:
                        self.assertEqual(value['worker'].get('mode'), mode)
                        self.assertEqual(value['worker']['shotId'], 'draft_001')

    def test_gemini_model_selection_is_explicit_and_server_allowlisted(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("if (array_key_exists('model', $input))", php)
        self.assertIn("'gemini-3.5-flash-lite', 'gemini-3.8-flash'", php)
        self.assertIn("reject(400, 'Unsupported AI model')", php)
        self.assertIn("$workerInput['model'] = $input['model'];", php)
        self.assertNotIn("$workerInput['model'] = $_GET", php)

    def test_gemini_thinking_profiles_are_whitelisted_and_medium_has_bounded_timeout(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("if (array_key_exists('profile', $input))", php)
        self.assertIn("['lite_default', 'g38_low', 'g38_medium', 'argon_previs', 'argon_direct']", php)
        self.assertIn("reject(400, 'Unsupported AI profile')", php)
        self.assertIn("array_key_exists('model', $input)", php)
        self.assertIn("$workerInput['profile'] = $input['profile'];", php)
        self.assertIn("!in_array($workerInput['mode'] ?? '', $argonModes, true)", php)
        self.assertIn("array_key_exists('layer', $workerInput)", php)
        self.assertIn("$curlTimeout = (($workerInput['profile'] ?? '') === 'g38_medium') ? 85 : 55;", php)
        self.assertIn("CURLOPT_TIMEOUT => $curlTimeout", php)
        self.assertIn("'504:AI provider extended request timed out'", php)

    def test_paid_argon_jobs_are_bound_to_authenticated_php_session(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("if ($action === 'argon_status')", php)
        self.assertIn("$_SESSION['argon_job']", php)
        self.assertIn("['jobId' => $job['id'], 'shotId' => $job['shotId']]", php)
        self.assertIn("if ($action === 'argon_start')", php)
        self.assertIn("!in_array($workerInput['profile'] ?? '', $argonProfiles, true)", php)
        self.assertIn("$argonProfiles = ['argon_previs', 'argon_direct'];", php)
        self.assertIn("$_SESSION['ai_calls']", php)
        self.assertIn("'created' => time()", php)
        self.assertIn("'argonJob' => $active === null ? null", php)
        self.assertIn("if ($action !== 'generate' && $action !== 'argon_start')", php)
        self.assertNotIn("$input['jobId']", php)
        self.assertIn("CURLOPT_TIMEOUT => in_array($action, ['start','direct-start','diagnostic'], true) ? 45 : 30", php)
        self.assertIn("CURLOPT_SSL_VERIFYPEER => true", php)

    @unittest.skipUnless(shutil.which("php"), "PHP CLI required (available in CI)")
    def test_argon_reserves_two_slots_before_worker_call_and_preserves_running_job(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        start = php.index("$argonProfiles = ['argon_previs', 'argon_direct'];")
        end = php.index("if (in_array($workerInput['profile'] ?? '', $argonProfiles, true))", start)
        # Exercise the actual production start route with transport/response
        # stubs. No web server, private config, credentials or network is used.
        route = php[start:end]
        # The real reply helpers, so forwarded token usage is checked too.
        helpers = php[php.index("function safe_worker_diagnostic("):
                      php.index("/** Fixed-target Argon background job transport")]
        harness = "<?php\n" + helpers + '''
$case = json_decode(stream_get_contents(STDIN), true);
$_SESSION = ['ai_calls' => $case['used']];
if ($case['active']) $_SESSION['argon_job'] = [
    'created' => time(), 'status' => 'in_progress', 'id' => 'existing_job_123'];
$action = 'argon_start'; $workerEndpoint = 'unused'; $secret = 'unused';
$workerInput = ['profile' => $case['profile'], 'mode' => 'primary_subject'];
$shotId = 'draft_001'; $calls = 0;
function answer($status, $body) {
    global $calls;
    echo json_encode(['status' => $status, 'used' => $_SESSION['ai_calls'],
        'calls' => $calls, 'job' => $_SESSION['argon_job'] ?? null, 'body' => $body]);
    exit;
}
function reject($status, $message) { answer($status, []); }
function argon_worker_call($endpoint, $secret, $action, $body) {
    global $calls, $case;
    $calls++;
    $slots = $case['profile'] === 'argon_direct' ? 1 : 2;
    if ($_SESSION['ai_calls'] !== $case['used'] + $slots) reject(500, 'unreserved');
    // Direct image is started in the Worker's Durable Object route.
    if ($action !== ($case['profile'] === 'argon_direct' ? 'direct-start' : 'start'))
        reject(500, 'wrong worker route');
    if ($case['fail']) reject(502, 'analysis failed');
    return ['jobId' => 'new_job_123456', 'status' => 'queued',
        'usage' => ['input' => 5210, 'output' => 812, 'private' => 'PRIVATE']];
}
'''
        cases = [
            ('argon_previs', 0, False, False, 200, 2, 1),
            ('argon_previs', 8, False, False, 200, 10, 1),
            ('argon_previs', 9, False, False, 429, 9, 0),
            ('argon_previs', 10, False, False, 429, 10, 0),
            ('argon_previs', 0, True, False, 409, 0, 0),
            ('argon_previs', 8, False, True, 502, 10, 1),
            # Direct image makes one paid call, so it reserves one slot.
            ('argon_direct', 0, False, False, 200, 1, 1),
            ('argon_direct', 9, False, False, 200, 10, 1),
            ('argon_direct', 10, False, False, 429, 10, 0),
            ('argon_direct', 0, True, False, 409, 0, 0),
            ('argon_direct', 9, False, True, 502, 10, 1),
        ]
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            script = pathlib.Path(folder) / "argon-route.php"
            script.write_text(harness + route)
            for profile, used, active, fail, status, reserved, calls in cases:
                with self.subTest(profile=profile, used=used, active=active, fail=fail):
                    result = subprocess.run(["php", str(script)], input=json.dumps({
                        'profile': profile, 'used': used, 'active': active, 'fail': fail}),
                        text=True, capture_output=True, check=True)
                    value = json.loads(result.stdout)
                    self.assertEqual((value['status'], value['used'], value['calls']),
                                     (status, reserved, calls))
                    if active:
                        self.assertEqual(value['job']['id'], 'existing_job_123')
                    if status == 200:
                        self.assertEqual(value['body'], {'ok': True, 'status': 'queued',
                            'shotId': 'draft_001', 'usage': {'input': 5210, 'output': 812}})

    @unittest.skipUnless(shutil.which("php"), "PHP CLI required (available in CI)")
    def test_php_forwards_only_revalidated_provider_diagnostics(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        helpers = php[php.index("function safe_worker_diagnostic("):
                      php.index("/** Fixed-target Argon background job transport")]
        # Worker rejections forward only re-validated tokens, after the hook.
        transport = php[php.index("function argon_worker_call("):php.index("function is_https()")]
        self.assertIn("if ($onRejected !== null) $onRejected($error);", transport)
        self.assertIn("['ok' => false, 'error' => safe_worker_error($status, $response)], $value));",
                      transport)
        harness = "<?php\n" + helpers + '''
$cases = json_decode(stream_get_contents(STDIN), true);
echo json_encode(array_map(static function ($value) {
    return with_diagnostic(['ok' => false], $value);
}, $cases));
'''
        valid = {"phase": "create", "http": 400, "status": None, "reason": "media_input_rejected",
                 "codes": ["invalid_request", "INVALID_ARGUMENT"], "fields": ["model", "background"],
                 "terms": ["image", "cannot"]}
        legacy = {key: value for key, value in valid.items() if key != "terms"}
        cases = [
            {"diagnostic": valid},
            {"diagnostic": {**valid, "message": "PRIVATE provider prose", "raw": "PRIVATE"}},
            {"diagnostic": {**valid, "phase": "job", "http": None, "status": "incomplete"}},
            {"diagnostic": legacy},
            {"diagnostic": {**valid, "codes": ["AIzaSyPRIVATEmixedCaseKey"]}},
            {"diagnostic": {**valid, "codes": ["invalid_request"] * 5}},
            {"diagnostic": {**valid, "fields": ["PRIVATE_FIELD"]}},
            {"diagnostic": {**valid, "terms": ["PRIVATE"]}},
            {"diagnostic": {**valid, "terms": "image"}},
            {"diagnostic": {**valid, "reason": "PRIVATE prose reason"}},
            {"diagnostic": {**valid, "phase": "upload"}},
            {"diagnostic": {**valid, "http": 500}},
            {"diagnostic": {**valid, "status": "PRIVATE"}},
            {"diagnostic": "PRIVATE string"},
            {"error": "no diagnostic"},
            "PRIVATE scalar",
        ]
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            script = pathlib.Path(folder) / "diagnostic.php"
            script.write_text(harness)
            result = subprocess.run(["php", str(script)], input=json.dumps(cases),
                                    text=True, capture_output=True, check=True)
        output = json.loads(result.stdout)
        self.assertEqual(output[0], {"ok": False, "diagnostic": valid})
        self.assertEqual(output[1], {"ok": False, "diagnostic": valid}, "extra keys dropped")
        self.assertEqual(output[2]["diagnostic"]["status"], "incomplete")
        # Workers before argon-diagnostic-terms-v1 send no terms.
        self.assertEqual(output[3], {"ok": False, "diagnostic": {**legacy, "terms": []}})
        for rejected in output[4:]:
            self.assertEqual(rejected, {"ok": False})
        self.assertNotIn("PRIVATE", result.stdout)

    @unittest.skipUnless(shutil.which("php"), "PHP CLI required (available in CI)")
    def test_php_forwards_only_numeric_token_usage(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        php = (root / "scene-proxy.php").read_text()
        worker = (root / "worker" / "scene-worker.mjs").read_text()
        helpers = php[php.index("function safe_worker_diagnostic("):
                      php.index("/** Fixed-target Argon background job transport")]
        keys = lambda pattern, text: re.findall(r"'([A-Za-z]+)'", re.search(pattern, text, re.S).group(1))
        self.assertEqual(keys(r"foreach \(\[(.*?)\] as \$key\)", helpers),
                         keys(r"const USAGE_KEYS=Object\.freeze\(\[(.*?)\]\);", worker))
        # Start, status and Worker rejections all pass usage through the allowlist.
        start = php[php.index("if ($action === 'argon_start')"):]
        status = php[php.index("if ($action === 'argon_status')"):php.index("if ($action !== 'generate'")]
        self.assertIn("'shotId' => $shotId], $job));", start)
        self.assertIn("with_diagnostic(['ok' => true, 'status' => $value['status'],", status)
        harness = "<?php\n" + helpers + '''
$cases = json_decode(stream_get_contents(STDIN), true);
echo json_encode(array_map(static function ($value) {
    return with_diagnostic(['ok' => true], $value);
}, $cases));
'''
        counts = {"input": 1800, "inputImage": 1200, "cached": 0, "thinking": 9120,
                  "output": 11204, "total": 22124, "cap": 32768}
        cases = [
            {"usage": counts},
            {"usage": {**counts, "private": "PRIVATE", "modalities": [{"PRIVATE": 1}]}},
            {"usage": {"input": "1800", "output": -1, "total": 1.5, "thinking": 100000001, "cached": True}},
            {"usage": "PRIVATE string"},
            {"usage": {}},
            {"status": "in_progress"},
        ]
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            script = pathlib.Path(folder) / "usage.php"
            script.write_text(harness)
            result = subprocess.run(["php", str(script)], input=json.dumps(cases),
                                    text=True, capture_output=True, check=True)
        output = json.loads(result.stdout)
        self.assertEqual(output[0], {"ok": True, "usage": counts})
        self.assertEqual(output[1], {"ok": True, "usage": counts}, "extra keys dropped")
        for rejected in output[2:]:
            self.assertEqual(rejected, {"ok": True})
        self.assertNotIn("PRIVATE", result.stdout)

    def test_php_and_worker_diagnostic_vocabularies_match(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        php = (root / "scene-proxy.php").read_text()
        worker = (root / "worker" / "scene-worker.mjs").read_text()
        def words(pattern, text):
            return re.findall(r"'([a-z0-9_]+)'", re.search(pattern, text, re.S).group(1))
        # PHP drops any token outside its own copy, so a drifted list would
        # silently hide diagnostics instead of failing loudly.
        self.assertEqual(words(r"\$known = \[(.*?)\];", php),
                         words(r"const ARGON_DIAG_FIELDS=Object\.freeze\(\[(.*?)\]\);", worker))
        self.assertEqual(words(r"\$knownTerms = \[(.*?)\];", php),
                         words(r"const ARGON_DIAG_TERMS=Object\.freeze\(\[(.*?)\]\);", worker))

    @unittest.skipUnless(shutil.which("php"), "PHP CLI required (available in CI)")
    def test_rejected_diagnostic_poll_unlocks_explicit_retry_without_resubmitting(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        route = php[php.index("if ($action === 'argon_diag_poll')"):
                    php.index("if ($action === 'argon_diag_step')")]
        helpers = php[php.index("function safe_worker_diagnostic("):
                      php.index("/** Fixed-target Argon background job transport")]
        harness = "<?php\n" + helpers + '''
$case = json_decode(stream_get_contents(STDIN), true);
$argonSmokeStages = ['text','thinking','image','json','background','background_image','background_combo'];
$_SESSION = ['argon_smoke' => ['step' => 5, 'state' => 'running', 'id' => 'v1_running_job']];
$action = 'argon_diag_poll'; $workerEndpoint = 'unused'; $secret = 'unused'; $calls = 0;
function answer($status, $body) {
    global $calls;
    echo json_encode(['status' => $status, 'body' => $body, 'calls' => $calls,
        'smoke' => $_SESSION['argon_smoke']]);
    exit;
}
function reject($status, $message) { answer($status, ['ok' => false, 'error' => $message]); }
function argon_worker_call($endpoint, $secret, $action, $body, $onRejected = null) {
    global $calls, $case;
    $calls++;
    if ($action !== 'diagnostic-status' || $body['id'] !== 'v1_running_job') reject(500, 'wrong call');
    if ($onRejected !== null) $onRejected($case['error']);
    answer(502, ['ok' => false, 'error' => 'mapped']);
}
'''
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            script = pathlib.Path(folder) / "poll.php"
            script.write_text(harness + route)
            for error, state in (("Argon rejected interaction status request", "failed"),
                                 ("AI provider network connection failed", "running"),
                                 ("AI provider temporarily unavailable", "running")):
                with self.subTest(error=error):
                    result = subprocess.run(["php", str(script)], input=json.dumps({"error": error}),
                                            text=True, capture_output=True, check=True)
                    value = json.loads(result.stdout)
                    # Only Google's definitive GET rejection releases the lock;
                    # transient failures keep the job resumable. Never resubmits.
                    self.assertEqual((value["status"], value["calls"], value["smoke"]["state"]),
                                     (502, 1, state))
                    self.assertEqual(value["smoke"]["step"], 5)

    def test_argon_model_check_requires_same_session_and_no_generation_quota(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("if ($action === 'argon_check')", php)
        self.assertIn("argon_worker_call($workerEndpoint, $secret, 'check', [])", php)
        # PHP encodes [] as "[]", but the Worker intentionally accepts only
        # a JSON object ("{}") for the zero-input metadata probe.
        self.assertIn("$action === 'check' ? (object) [] : $body", php)
        import subprocess
        php_json = subprocess.run(
            ["php", "-r", "echo json_encode((object) [], JSON_UNESCAPED_SLASHES);"],
            capture_output=True, text=True, check=True
        )
        self.assertEqual(php_json.stdout, "{}")
        php_array = subprocess.run(
            ["php", "-r", "echo json_encode([], JSON_UNESCAPED_SLASHES);"],
            capture_output=True, text=True, check=True
        )
        self.assertEqual(php_array.stdout, "[]")
        self.assertIn("'400:Invalid Argon check request'", php)
        self.assertIn("['start', 'direct-start', 'status', 'check', 'diagnostic', 'diagnostic-status']", php)
        self.assertIn("'available' => $check['available']", php)
        self.assertIn("'502:Argon model metadata check unavailable'", php)
        self.assertLess(php.index("if (empty($_SESSION['authenticated']))"),
                        php.index("if ($action === 'argon_check')"))
        self.assertLess(php.index("if (!is_string($providedCsrf)"),
                        php.index("if ($action === 'argon_check')"))
        self.assertLess(php.index("if ($action === 'argon_check')"),
                        php.index("$_SESSION['ai_calls'] = 0"))

    def test_paid_argon_diagnostics_are_sequential_private_and_capped(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        for expression in (
            "if ($action === 'argon_diag_reset')",
            "if ($action === 'argon_diag_step')",
            "if ($action === 'argon_diag_poll')",
            "$argonSmokeStages = ['text','thinking','image','json','background','background_image','background_combo'];",
            "['step' => $step, 'state' => 'failed']",
            "$retry = ($input['retry'] ?? null) === true;",
            "(($state === 'failed') !== $retry)",
            "['idle','passed','failed']",
            "count(array_diff(array_keys($input), ['action','csrf','step','retry'])) > 0",
            "$smoke['step'] < 4 || $smoke['step'] >= count($argonSmokeStages)",
            "['id' => $smoke['id'], 'stage' => $argonSmokeStages[$smoke['step']]]",
            "$next === count($argonSmokeStages) ? 'done' : 'passed'",
            "if ((int) ($_SESSION['argon_diag_calls'] ?? 0) >= 10)",
            "argon_worker_call($workerEndpoint, $secret, 'diagnostic',",
            "argon_worker_call($workerEndpoint, $secret, 'diagnostic-status',",
            "'argonSmoke' => [",
            "'400:Invalid Argon diagnostic request'",
            "'504:Argon diagnostic request timed out'",
            "with_diagnostic(\n        ['ok' => true, 'step' => $smoke['step'], 'state' => 'failed', 'passed' => false], $result)",
            "with_diagnostic(\n        ['ok' => true, 'step' => $step, 'state' => 'failed', 'passed' => false], $result)"
        ):
            self.assertIn(expression, php)
        self.assertLess(php.index("if (empty($_SESSION['authenticated']))"),
                        php.index("if ($action === 'argon_diag_step')"))
        self.assertLess(php.index("if ($action === 'argon_diag_step')"),
                        php.index("// Protect upstream quota;"))

    def test_php_only_maps_fixed_worker_failure_messages(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("function safe_worker_error(int $status, string $body): string", php)
        self.assertIn("json_decode($body, true)", php)
        self.assertIn("isset($allowed[$key])", php)
        self.assertIn("safe_worker_error($status, $response)", php)
        self.assertNotIn("reject(502, $response)", php)
        expected = {
            "401:Unauthorized": "Worker rejected the PHP access token",
            "400:Invalid image request": "Worker rejected the sampled video frames",
            "504:AI provider request timed out": "Gemini took longer than 45 seconds",
            "504:AI provider extended request timed out": "Gemini 3.8 Medium took longer than 70 seconds",
            "502:AI provider network connection failed": "Cloudflare Worker could not reach Gemini",
            "502:AI provider authentication or permission failed": "Gemini rejected the provider API credentials",
            "502:Requested AI model is unavailable": "configured Gemini model is not available",
            "502:AI provider rejected request format": "Gemini rejected the submitted frame",
            "502:Argon rejected output format configuration": "corrected response schema",
            "502:Argon rejected generation configuration": "thinking level or token budget",
            "502:Argon rejected image input configuration": "inline reference image format",
            "502:Argon rejected background execution configuration": "background job settings",
            "502:Argon rejected model configuration": "does not establish a billing or entitlement problem",
            "502:Argon reference analysis unavailable": "No background job was submitted",
            "502:Argon reference analysis invalid": "usable visual description",
            "502:Argon provider redirect blocked": "correctly refused to follow",
            "502:Argon rejected Interactions request": "No job was created",
            "502:Argon rejected interaction status request": "after the job was created",
            "503:Argon direct job storage is not configured": "ARGON_JOBS Durable Object binding",
            "502:Argon direct job could not be created": "No paid request was made",
            "502:Argon direct job status unavailable": "No new paid request was made",

            "502:AI provider capacity unavailable": "Gemini is overloaded (upstream 503)",
            "502:AI provider temporarily unavailable": "temporary server error (upstream 5xx)",
            "502:Provider scene did not match the editor schema": "failed scene validation"
        }
        for worker_key, category_text in expected.items():
            with self.subTest(code=worker_key):
                self.assertIn(worker_key, php)
                self.assertIn(category_text, php)

    def test_only_exact_editor_redirect_is_considered_safe(self):
        self.assertTrue(probe.is_safe_denial(403, "", path_exposed=False))
        self.assertTrue(probe.is_safe_denial(302, probe.EDITOR, path_exposed=False))
        self.assertFalse(probe.is_safe_denial(302, "https://attacker.example/", path_exposed=False))
        self.assertFalse(probe.is_safe_denial(200, "", path_exposed=False))
        self.assertFalse(probe.is_safe_denial(403, "", path_exposed=True))

    def test_php_error_mapping_is_fixed_and_never_echoes_remote_error(self):
        self.assertEqual(
            probe.proxy_error_category(b'{"ok":false,"error":"Private server configuration needs valid values"}'),
            "private-config-values-invalid",
        )
        self.assertEqual(
            probe.proxy_error_category(b'{"ok":false,"error":"super-sensitive-passphrase-would-be-here"}'),
            "other",
        )

    def test_leaked_host_path_or_public_secret_url_fails_closed(self):
        def fake_get(url, inspect_body=False):
            if url.endswith("/health"):
                return 200, b'{"ready":true}', None
            if url.endswith("/403.html"):
                return 200, b"<html>Access denied. Return to editor.</html>", None
            if url.endswith("/.private/deny-check.txt"):
                return 403, b"AH01630: /services/users/PRIVATEACCOUNT/file", None
            if url.endswith("/.private/paiver.php"):
                self.assertFalse(inspect_body)
                return 200, b"", None
            return 503, b'{"ok":false,"error":"Private server configuration is not available"}', None

        def fake_protected(url, inspect_body=False):
            if url.endswith("/.private/deny-check.txt"):
                return 403, b"AH01630: /services/users/PRIVATEACCOUNT/file", ""
            if url.endswith("/.private/paiver.php"):
                self.assertFalse(inspect_body)
                return 200, b"", ""
            self.fail(f"Unexpected protected URL: {url}")

        output = io.StringIO()
        with patch.object(probe, "fetch", side_effect=fake_get), \
             patch.object(probe, "fetch_protected", side_effect=fake_protected), \
             patch.object(probe, "check_session_continuity", return_value=(True, True, "ok", 200)):
            with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(probe.run(), 1)
        self.assertIn("internal_path_disclosed=true", output.getvalue())
        self.assertIn("Secret PHP direct URL (status only): HTTP 200", output.getvalue())
        self.assertNotIn("/services/users/PRIVATEACCOUNT", output.getvalue())


if __name__ == "__main__":
    unittest.main()
