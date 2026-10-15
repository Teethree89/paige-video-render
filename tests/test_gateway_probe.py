"""Ensure deployment probe never outputs server secrets or CSRF."""
import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "check_live_gateway.py"
spec = importlib.util.spec_from_file_location("check_live_gateway", path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GatewaySmokeTests(unittest.TestCase):
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
             patch.object(probe, "fetch_protected", side_effect=fake_protected):
            with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(probe.run(), 0)
        self.assertIn("RESULT: PASS", output.getvalue())
        self.assertNotIn(token, output.getvalue())
        self.assertNotIn(csrf, output.getvalue())

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
             patch.object(probe, "fetch_protected", side_effect=fake_protected):
            with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(probe.run(), 1)
        self.assertIn("internal_path_disclosed=true", output.getvalue())
        self.assertIn("Secret PHP direct URL (status only): HTTP 200", output.getvalue())
        self.assertNotIn("/services/users/PRIVATEACCOUNT", output.getvalue())


if __name__ == "__main__":
    unittest.main()
