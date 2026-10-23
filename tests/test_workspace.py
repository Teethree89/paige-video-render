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

    def test_split_mp4_preview(self):
        import hashlib
        bundle = ROOT / "exports/media-parts"
        if not bundle.is_dir():
            self.fail("Missing preview media chunks")
        manifest = json.loads((bundle / "manifest.json").read_text())
        digest = hashlib.sha256()
        total = 0
        for part in manifest["parts"]:
            b = (bundle / part["file"]).read_bytes()
            self.assertEqual(len(b), part["size"])
            self.assertEqual(hashlib.sha256(b).hexdigest(), part["sha256"])
            digest.update(b)
            total += len(b)
        self.assertEqual(total, manifest["size"])
        self.assertEqual(digest.hexdigest(), manifest["sha256"])

    def test_aftereffects_builder_is_staged_for_live_browser_export(self):
        # The AE package exporter fetches the JSX *over HTTP* before creating
        # the ZIP. Having it only in the downloadable workspace ZIP is not enough.
        builder = ROOT / 'AfterEffects/BUILD_EDITABLE_PROJECT.jsx'
        self.assertTrue(builder.is_file())
        source = (ROOT / 'ae-package-export.js').read_text()
        self.assertIn("fetch('./AfterEffects/BUILD_EDITABLE_PROJECT.jsx'", source)
        publish = (ROOT / '.github/workflows/publish-ftp.yml').read_text()
        self.assertIn('cp -a dist/AfterEffects ftp-public/AfterEffects', publish)
        self.assertIn('test -s ftp-public/AfterEffects/BUILD_EDITABLE_PROJECT.jsx', publish)
        self.assertIn('cmp dist/AfterEffects/BUILD_EDITABLE_PROJECT.jsx ftp-public/AfterEffects/BUILD_EDITABLE_PROJECT.jsx', publish)

    def test_source_files(self):
        for f in ('index.html','app.js','world.js','render.html','render.js',
                  'ae-package-export.js','ae-package-plan.js',
                  'AfterEffects/BUILD_EDITABLE_PROJECT.jsx'):
            self.assertGreater((ROOT/f).stat().st_size, 100)
        publish_manifest=(ROOT/'scripts/build_workspace.py').read_text()
        for entry in ('ae-package-export.js','ae-package-plan.js'):
            self.assertIn('"'+entry+'"',publish_manifest,
                          f'{entry} must ship with the FTP/ZIP workspace')

    def test_browser_module_imports_are_in_workspace_manifest(self):
        # FTP publishes root JavaScript only from dist, and dist is populated
        # by build_workspace.FILES. Catch new ES module imports before deploy.
        import re
        import runpy
        manifest = set(runpy.run_path(str(ROOT / 'scripts/build_workspace.py'))['FILES'])
        for required in ('argon-detail.js', 'ai-generation-overlay.js',
                         'scene-object-edit.js', 'scene-object-operations.js'):
            self.assertIn(required, manifest)
        dependency_pattern = re.compile(
            r"""(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([.]/[^'"]+\.js)['"]"""
        )
        for filename in sorted(manifest):
            if not filename.endswith('.js'):
                continue
            content = (ROOT / filename).read_text(encoding='utf-8')
            for path in dependency_pattern.findall(content):
                dependency = (Path(filename).parent / path).as_posix()
                self.assertIn(dependency, manifest,
                              f'{filename} imports {path} but {dependency} is absent from the FTP/ZIP workspace manifest')


if __name__ == '__main__':
    unittest.main(verbosity=2)
