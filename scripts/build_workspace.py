#!/usr/bin/env python3
"""Prepare a reproducible, deployable source/workspace bundle.

Usage: python scripts/build_workspace.py --output dist

This intentionally excludes secrets, local caches, and Git internals. The deployed
`current/` directory contains the live editor as well as downloads/workspace.zip.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "index.html", "render.html", "403.html", "private-denied.html", "styles.css", "app.js", "world.js", "render.js",
    "model-tools.js", "ae-package-export.js", "ae-package-plan.js", "zip-utils.js", "shot-analysis.js", "video-import.js", "single-video-source.js",
    "draft-world.js", "chapter-analysis.js", "primitive-schema.js", "primitive-cleanup.js",
    "primitive-world.js", "render-diagnostics.js", "primitive-editor.js", "workspace-controls.js", "workspace-reset.js", "timeline-operations.js", "timeline-tools.js", "animation-curves.js", "animation-graph.js", "camera-motion-sync.js", "accepted-camera-sync.js", "scene-asset-catalog.js", "radial-create.js", "spotlight-controls.js", "scene-effects.js", "scene-units.js", "scene-effects-panel.js", "scene-object-edit.js", "scene-selection-panel.js", "scene-object-operations.js", "array-prototype.js", "array-prototype-editor.js", "array-assembly-templates.js", "assembly-library.js", "scene-group-selection.js",
    "ai-scene-editor.js", "primitive-preview.js", "environment-generation.js", "video-camera-motion.js",
    "argon-detail.js", "scene-generation-compose.js", "chapter-workflow.js", "camera-track-solver.js", "local-media-store.js", "feature-tracker.js", "camera-track-pipeline.js", "camera-track-worker.js", "camera-track-ui.js", "camera-resection.js", "camera-anchor.js", "camera-track-wizard.js", "viewport-tools.js", "ai-generation-overlay.js", "generation-sounds.js",
    "reference-sequence.js", "reference-builder.js", "reference-builder-ui.js", "reference-frames.js", "portable-reference.js", "reference-builder.css", "help-toggles.js",
    "scene-proxy.php", "wrangler.toml", "timeline.json", "README.md", "AGENTS.md",
    "EXTERNAL_MODELS.md", "VIDEO_AND_AFTER_EFFECTS.md",
    "start.sh", "convert_to_mp4.sh", "convert_to_mp4.bat",
    ".gitignore", ".env.example", "GITHUB_AND_FTP.md",
]
FOLDERS = ("assets", "AfterEffects", "exports", "scripts", "tests", ".github", "docs", "worker")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()


def git_revision():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT,
                                       stderr=subprocess.DEVNULL, text=True).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return os.environ.get("GITHUB_SHA", "local")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="dist")
    args = parser.parse_args()
    out = (ROOT / args.output).resolve()
    if out == ROOT or ROOT not in out.parents:
        raise SystemExit("Output must be a subdirectory of the workspace")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in FILES:
        source = ROOT / name
        if not source.is_file():
            raise SystemExit(f"Required file missing: {name}")
        shutil.copy2(source, out / name)
    for name in FOLDERS:
        source = ROOT / name
        if not source.is_dir():
            raise SystemExit(f"Required folder missing: {name}")
        shutil.copytree(source, out / name)
    # Reassemble the preview in fresh GitHub checkouts, where only 1MB chunks are tracked.
    from reconstruct_media import reconstruct
    reconstruct(out)
    build = {"project":"paige-video-render", "commit":git_revision(), "files":{}}
    for p in sorted(out.rglob("*")):
        if p.is_file():
            path = p.relative_to(out).as_posix()
            build["files"][path] = {"size": p.stat().st_size, "sha256": sha(p)}
    (out / "build-manifest.json").write_text(json.dumps(build,indent=2)+"\n", encoding="utf-8")
    downloads = out / "downloads"
    downloads.mkdir()
    with zipfile.ZipFile(downloads / "paige-video-render-workspace.zip", "w",
                         compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(out.rglob("*")):
            if p.is_file() and "downloads" not in p.relative_to(out).parts:
                z.write(p, p.relative_to(out).as_posix())
    print(f"Staged {len(build['files'])} files at {out.relative_to(ROOT)}; "
          f"workspace ZIP { (downloads / 'paige-video-render-workspace.zip').stat().st_size:,} bytes")


if __name__ == "__main__":
    main()

