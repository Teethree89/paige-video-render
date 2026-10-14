#!/usr/bin/env python3
import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WorkspaceTests(unittest.TestCase):
    def test_timeline(self):
        data = json.loads((ROOT/'timeline.json').read_text())
        self.assertGreater(data['duration'], 56)
        self.assertGreaterEqual(len(data['camera']), 20)
        self.assertGreaterEqual(len(data['text']), 10)
        self.assertTrue(all(0 <= c['at'] <= data['duration'] for c in data['camera']))

    def test_models_and_manifest(self):
        doc = json.loads((ROOT/'assets/models/manifest.json').read_text())
        self.assertEqual(len(doc['models']), 7)
        for name, entry in doc['models'].items():
            with self.subTest(model=name):
                path = ROOT / entry['url']
                self.assertTrue(path.is_file())
                with path.open('rb') as f:
                    head = f.read(12)
                magic, ver, size = struct.unpack('<4sII', head)
                self.assertEqual(magic,b'glTF')
                self.assertEqual(ver,2)
                self.assertEqual(size,path.stat().st_size)

    def test_source_files(self):
        for f in ('index.html','app.js','world.js','render.html','render.js',
                  'AfterEffects/BUILD_EDITABLE_PROJECT.jsx'):
            self.assertGreater((ROOT/f).stat().st_size, 100)


if __name__ == '__main__':
    unittest.main(verbosity=2)
