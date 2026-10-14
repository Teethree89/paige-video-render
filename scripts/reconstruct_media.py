#!/usr/bin/env python3
"""Restore the original full-size MP4 from checksum-verified 1MB git objects.

The split media chunks work around GitHub connector upload limits. The editor
runs without this MP4; this is the shareable offline draft preview.
"""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / 'exports/media-parts'


def reconstruct(dest_root=ROOT):
    manifest=json.loads((PARTS/'manifest.json').read_text())
    target=Path(dest_root)/manifest['target']
    if target.is_file() and target.stat().st_size == manifest['size'] and hashlib.sha256(target.read_bytes()).hexdigest()==manifest['sha256']:
        return target
    target.parent.mkdir(parents=True,exist_ok=True)
    tmp=target.with_suffix('.mp4.part')
    h=hashlib.sha256()
    size=0
    try:
        with tmp.open('wb') as output:
            for p in manifest['parts']:
                b=(PARTS/p['file']).read_bytes()
                if len(b)!=p['size'] or hashlib.sha256(b).hexdigest()!=p['sha256']:
                    raise ValueError('Corrupt media part: '+p['file'])
                output.write(b)
                h.update(b); size+=len(b)
        if size!=manifest['size'] or h.hexdigest()!=manifest['sha256']:
            raise ValueError('Combined media checksum mismatch')
        tmp.replace(target)
    finally:
        tmp.unlink(missing_ok=True)
    return target

if __name__=='__main__':
    result=reconstruct()
    print(f'Restored {result} ({result.stat().st_size:,} bytes)')
