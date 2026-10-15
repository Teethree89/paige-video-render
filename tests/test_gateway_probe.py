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
                return 200, b'{"ready":true}', None
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
        self.assertIn("Secure PHP cookie sessions are required", script[:start])
        self.assertEqual(
            probe.proxy_error_category(
                b'{"ok":false,"error":"Secure PHP cookie sessions are required"}'),
            "php-cookie-sessions-unavailable"
        )

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
