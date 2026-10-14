#!/usr/bin/env python3
"""Unit tests for the private Zen scene adapter. No secret or network needed."""
import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts' / 'zen_scene.py'
SPEC = importlib.util.spec_from_file_location('zen_scene', MODULE)
zen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zen)


class ZenSceneTests(unittest.TestCase):
    def test_times_are_interior_and_ordered(self):
        self.assertEqual(zen.sample_times(4,12,3),[6.0,8.0,10.0])
        with self.assertRaises(ValueError):
            zen.sample_times(0,2,6)

    def test_image_payload_uses_responses_format_and_free_model(self):
        images = [bytes.fromhex('ffd8ff'),bytes.fromhex('ffd8ff')]
        p = zen.build_request('muse-spark-1.3-contributor-free','hall',[5,9],images)
        self.assertEqual(p['model'],'muse-spark-1.3-contributor-free')
        self.assertEqual(p['input'][0]['role'],'user')
        content=p['input'][0]['content']
        self.assertEqual([c['type'] for c in content].count('input_image'),2)
        self.assertTrue(content[2]['image_url'].startswith('data:image/jpeg;base64,'))
        self.assertNotIn('Authorization',str(p))
        with self.assertRaises(ValueError):
            zen.build_request('muse-spark-1.3','hall',[5],images[:1])

    def test_responses_output_parsing(self):
        body={'output':[{'type':'reasoning','content':[]},
                       {'type':'message','content':[{'type':'output_text','text':'{"schemaVersion":1}'}]}]}
        self.assertEqual(zen.response_text(body),'{"schemaVersion":1}')
        with self.assertRaises(ValueError):
            zen.response_text({'output':[]})

    def test_parses_only_requested_scene_and_max_object_cap(self):
        text='''```json
{"schemaVersion":1,"scenes":[{"shotId":"hall","objects":[]}]}
```'''
        parsed=zen.parse_scene(text,'hall')
        self.assertEqual(parsed['scenes'][0]['shotId'],'hall')
        with self.assertRaises(ValueError):
            zen.parse_scene(text,'laser')
        with self.assertRaises(ValueError):
            zen.parse_scene('{"schemaVersion":2,"scenes":[]}', 'hall')
        with self.assertRaises(ValueError):
            zen.parse_scene('{"schemaVersion":1,"scenes":[{"shotId":"hall","objects":['+
                            ','.join(['{}']*17)+']}]}', 'hall')

    def test_input_path_traversal_rejected(self):
        with self.assertRaises(ValueError):
            zen.project_file('../../tmp/secret.mp4',{'.mp4'})
        with self.assertRaises(ValueError):
            zen.project_file('scripts/zen_scene.py',{'.mp4'})

    def test_no_api_key_is_rejected_before_network(self):
        with self.assertRaisesRegex(ValueError,'zen_api'):
            zen.request_zen({},'')


if __name__ == '__main__':
    unittest.main(verbosity=2)
