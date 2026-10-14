#!/usr/bin/env python3
"""No-network checks for the multi-model free-tier benchmarking harness."""
import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from zen_scene import FREE_MODELS
from benchmark_zen_free import MODELS_TO_BENCHMARK,try_model,classification


class FreeModelBenchmarkTests(TestCase):
    def test_only_listed_free_models_in_matrix(self):
        self.assertEqual(len(MODELS_TO_BENCHMARK),4)
        self.assertTrue(all(name in FREE_MODELS for name in MODELS_TO_BENCHMARK))
        self.assertTrue(all("free" in name or name=="big-pickle" for name in MODELS_TO_BENCHMARK))

    def test_missing_secret_never_contacts_provider(self):
        with patch("benchmark_zen_free.run_opencode",side_effect=AssertionError("must not invoke")):
            item=try_model(MODELS_TO_BENCHMARK[0],"")
        self.assertEqual(item["diagnostic"],"MISSING_ZEN_SECRET")
        self.assertEqual(item["vision_json"],"NOT_RUN")

    def test_403_access_denial_skips_video_call(self):
        with patch("benchmark_zen_free.run_opencode",side_effect=RuntimeError(
            "Official OpenCode CLI failed (exit 1; category FREE_TIER_CLIENT_RESTRICTION)")):
            with patch("benchmark_zen_free.generate_scene",side_effect=AssertionError("no image calls")):
                item=try_model(MODELS_TO_BENCHMARK[1],"pretend-secret")
        self.assertEqual(item["text_access"],"FAILED")
        self.assertEqual(item["vision_json"],"NOT_RUN")
        self.assertEqual(item["diagnostic"],"FREE_TIER_CLIENT_RESTRICTION")

    def test_sanitizer_never_repeats_exception_content(self):
        err=RuntimeError("sensitive video prompt with error")
        self.assertEqual(classification(err),"OTHER_TEST_FAILURE")
        self.assertNotIn("sensitive",classification(err))

    def test_unapproved_model_never_runs(self):
        with self.assertRaisesRegex(ValueError,"allowlist"):
            try_model("gpt-6-pro","example-secret")


if __name__=="__main__":
    unittest.main()
