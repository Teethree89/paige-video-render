"""Ensure deployment probe never outputs server secrets or CSRF."""
import contextlib
import importlib.util
import io
import json
import pathlib
import re
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "check_live_gateway.py"
spec = importlib.util.spec_from_file_location("check_live_gateway", path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GatewaySmokeTests(unittest.TestCase):
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

    def test_primary_mode_is_strictly_validated_and_forwarded_by_php(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("if (array_key_exists('mode', $input))", php)
        self.assertIn("$input['mode'] !== 'primary_subject'", php)
        self.assertIn("array_key_exists('layer', $input)", php)
        self.assertIn("$workerInput['mode'] = 'primary_subject';", php)
        self.assertIn("$workerInput = ['shotId' => $shotId, 'frames' => $validated];", php)

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
        self.assertIn("['lite_default', 'g38_low', 'g38_medium', 'argon_previs']", php)
        self.assertIn("reject(400, 'Unsupported AI profile')", php)
        self.assertIn("array_key_exists('model', $input)", php)
        self.assertIn("$workerInput['profile'] = $input['profile'];", php)
        self.assertIn("($workerInput['mode'] ?? '') !== 'primary_subject'", php)
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
        self.assertIn("($workerInput['profile'] ?? '') !== 'argon_previs'", php)
        self.assertIn("$_SESSION['ai_calls']", php)
        self.assertIn("'created' => time()", php)
        self.assertIn("'argonJob' => $active === null ? null", php)
        self.assertIn("if ($action !== 'generate' && $action !== 'argon_start')", php)
        self.assertNotIn("$input['jobId']", php)
        self.assertIn("CURLOPT_TIMEOUT => $action === 'start' ? 45 : 30", php)
        self.assertIn("CURLOPT_SSL_VERIFYPEER => true", php)

    def test_argon_model_check_requires_same_session_and_no_generation_quota(self):
        php = (pathlib.Path(__file__).resolve().parents[1] / "scene-proxy.php").read_text()
        self.assertIn("if ($action === 'argon_check')", php)
        self.assertIn("argon_worker_call($workerEndpoint, $secret, 'check', [])", php)
        self.assertIn("['start', 'status', 'check']", php)
        self.assertIn("'available' => $check['available']", php)
        self.assertIn("'502:Argon model metadata check unavailable'", php)
        self.assertLess(php.index("if (empty($_SESSION['authenticated']))"),
                        php.index("if ($action === 'argon_check')"))
        self.assertLess(php.index("if (!is_string($providedCsrf)"),
                        php.index("if ($action === 'argon_check')"))
        self.assertLess(php.index("if ($action === 'argon_check')"),
                        php.index("$_SESSION['ai_calls'] = 0"))

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
            "502:Argon rejected model configuration": "paid-tier Argon access",
            "502:Argon rejected Interactions request": "No job was created",

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
