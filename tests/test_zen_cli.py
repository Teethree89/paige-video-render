#!/usr/bin/env python3
"""Offline tests of JSON event extraction in the official OpenCode CLI adapter."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from zen_cli_scene import opencode_text, run_opencode, classify_cli_failure


class ZenCliTests(unittest.TestCase):
    def test_json_text_events(self):
        events='''{"type":"step_start","part":{}}
{"type":"text","part":{"type":"text","text":"{\\"schemaVersion\\":1,"}}
{"type":"text","part":{"type":"text","text":"\\"scenes\\":[]}"}}
{"type":"step_finish","part":{}}
'''
        self.assertEqual(opencode_text(events),'{"schemaVersion":1,"scenes":[]}')

    def test_event_stream_without_text_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no text"):
            opencode_text('{"type":"step_finish","part":{}}')

    def test_secret_is_required(self):
        with self.assertRaisesRegex(ValueError,"zen_api"):
            run_opencode("muse-spark-1.3-contributor-free","hall",[],[],"")
        with self.assertRaisesRegex(ValueError,"free"):
            run_opencode("muse-spark-1.3","hall",[],[],"example-key")



    def test_safe_failure_categories(self):
        self.assertEqual(classify_cli_failure('', '403 FreeTierError'), 'FREE_TIER_CLIENT_RESTRICTION')
        self.assertEqual(classify_cli_failure('', 'RegionError: not available in your country'), 'MODEL_REGION_RESTRICTION')
        self.assertEqual(classify_cli_failure('{"error":"Invalid API key"}', ''), 'INVALID_OR_UNAUTHORIZED_ZEN_KEY')
        self.assertEqual(classify_cli_failure('private content with no error', ''), 'OTHER_CLI_OR_PROVIDER_ERROR')

if __name__ == "__main__":
    unittest.main()
