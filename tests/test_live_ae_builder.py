"""Unit tests for the live After Effects builder smoke verification."""
import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "check_live_ae_builder.py"
spec = importlib.util.spec_from_file_location("check_live_ae_builder", MODULE)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class Response:
    status = 200
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def read(self, count): return self.data[:count]


class AfterEffectsLiveBuilderTests(unittest.TestCase):
    def test_matching_public_builder_is_accepted(self):
        requested = []
        def fetcher(req, timeout):
            requested.append(req.full_url)
            return Response(checker.BUILDER.read_bytes())
        ok, status = checker.verify(fetcher=fetcher, attempts=1)
        self.assertTrue(ok)
        self.assertIn("HTTP 200", status)
        self.assertIn("/AfterEffects/BUILD_EDITABLE_PROJECT.jsx", requested[0])

    def test_outdated_public_builder_is_rejected(self):
        def fetcher(req, timeout):
            return Response(b"stale builder, previously cached")
        ok, status = checker.verify(fetcher=fetcher, attempts=1)
        self.assertFalse(ok)
        self.assertIn("content-matches=false", status)


if __name__ == "__main__":
    unittest.main()
