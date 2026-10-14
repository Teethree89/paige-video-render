#!/usr/bin/env python3
"""Run scene inference inside the *official* OpenCode CLI, not a generic free-tier API client.

OpenCode documents the noninteractive CLI as a supported way of accessing free
Zen models. The API key is passed through env expansion, never printed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from zen_scene import (
    ROOT, FREE_MODELS, SHOT_ID_PATTERN, extract_jpegs,
    load_shot, parse_scene, project_file, sample_times, PROMPT,
)


def opencode_text(stdout: str) -> str:
    """Extract assistant text from OpenCode --format json newline events."""
    chunks: list[str] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "text":
            continue
        part = event.get("part") or {}
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            chunks.append(part["text"])
    if chunks:
        return "".join(chunks)
    # Do not guess if the CLI's JSON event format changes.
    raise ValueError("Official OpenCode CLI returned no text events; check CLI version")


def classify_cli_failure(stdout: str, stderr: str) -> str:
    """Report a coarse error category, never provider response bodies or prompts."""
    # Match only hardcoded classification labels; never echo content from the CLI.
    data = (stdout + "\\n" + stderr).lower()
    if "freetiererror" in data or "free tier can only be used" in data:
        return "FREE_TIER_CLIENT_RESTRICTION"
    if "regionerror" in data or "not available in your country" in data:
        return "MODEL_REGION_RESTRICTION"
    if "invalid api key" in data or "unauthorized" in data or "http 401" in data:
        return "INVALID_OR_UNAUTHORIZED_ZEN_KEY"
    if "model" in data and ("not found" in data or "unknown" in data or "does not exist" in data):
        return "MODEL_NOT_AVAILABLE_IN_CLI"
    if "provider" in data and ("not found" in data or "not configured" in data):
        return "PROVIDER_CONFIGURATION_ERROR"
    if "model access" in data or "model is disabled" in data or "does not have access" in data:
        return "MODEL_DISABLED_FOR_WORKSPACE"
    if "permission" in data or "denied" in data:
        return "OPENCODE_PERMISSION_REJECTION"
    if "rate limit" in data or "429" in data:
        return "MODEL_RATE_LIMIT"
    if "error" in data or "failed" in data:
        return "OTHER_CLI_OR_PROVIDER_ERROR"
    return "CLI_EXIT_WITHOUT_DIAGNOSTIC"


def run_opencode(model: str, shot_id: str, paths: list[Path], seconds: list[float], api_key: str) -> str:
    if model not in FREE_MODELS:
        raise ValueError("Only explicitly approved free models may be used")
    if not api_key:
        raise ValueError("Secret zen_api is not available")
    # Use the built-in OpenCode Zen provider, with its official client identity.
    # Key substitution is resolved by OpenCode in the subprocess.
    config = {
        "$schema": "https://opencode.ai/config.json",
        "provider": {"opencode": {"options": {"apiKey": "{env:ZEN_API_KEY}"}}},
        "permission": {"*": "deny"},
        "share": "disabled",
    }
    env = os.environ.copy()
    env["ZEN_API_KEY"] = api_key
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    env["OPENCODE_DISABLE_AUTOUPDATE"] = "true"
    env["CI"] = "true"
    timestamp_notes = ", ".join(f"{s:.2f}s" for s in seconds)
    prompt = (PROMPT.replace("SHOT_ID_PLACEHOLDER", shot_id)
              + "\nThese reference images are chronological samples at: "
              + timestamp_notes
              + "\nRespond with a single JSON object only. Do not call tools.")
    cmd = ["opencode", "run", "--standalone",
           "--model", "opencode/" + model,
           "--format", "json"]
    for path in paths:
        cmd.extend(["--file", str(path)])
    cmd.append(prompt)
    try:
        done = subprocess.run(
            cmd, cwd=ROOT, env=env, text=True, encoding="utf-8",
            capture_output=True, timeout=185, check=False
        )
    except FileNotFoundError:
        raise RuntimeError("Official OpenCode CLI is not installed") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError("Official OpenCode CLI timed out") from None
    if done.returncode:
        label = classify_cli_failure(done.stdout, done.stderr)
        raise RuntimeError(f"Official OpenCode CLI failed (exit {done.returncode}; "
                           f"category {label}). No provider logs or secrets were printed.")
    return opencode_text(done.stdout)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--timeline", default="timeline.json")
    p.add_argument("--video", default="assets/reference.mp4")
    p.add_argument("--shot", default="hall")
    p.add_argument("--model", choices=FREE_MODELS, default=FREE_MODELS[0])
    p.add_argument("--frames", type=int, choices=range(1, 6), default=3)
    p.add_argument("--output", default="ai-proposals/hall-primitives.json")
    args = p.parse_args(argv)
    if not SHOT_ID_PATTERN.fullmatch(args.shot):
        raise ValueError("Invalid shot id")
    timeline = project_file(args.timeline, {".json"})
    video = project_file(args.video, {".mp4", ".mov", ".webm"})
    _, shot = load_shot(timeline, args.shot)
    times = sample_times(shot["start"], shot["end"], args.frames)
    images = extract_jpegs(video, times)

    with tempfile.TemporaryDirectory(prefix="paige-zen-") as tmp:
        frames: list[Path] = []
        for i, frame in enumerate(images):
            path = Path(tmp) / f"frame-{i}.jpg"
            path.write_bytes(frame)
            frames.append(path)
        raw_text = run_opencode(args.model, args.shot, frames, times, os.environ.get("ZEN_API_KEY", ""))
    scene = parse_scene(raw_text, args.shot)

    output = Path(args.output).resolve()
    if not output.is_relative_to(ROOT) or output.suffix != ".json":
        raise ValueError("Output must be a JSON file inside the repository")
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(scene, indent=2)+"\n", encoding="utf-8")
        subprocess.run(["node", "scripts/validate_zen_scene.mjs", str(tmp), args.shot],
                       cwd=ROOT, timeout=20, check=True)
        tmp.replace(output)
    finally:
        tmp.unlink(missing_ok=True)
    print(f"Official OpenCode output validated: {len(scene['scenes'][0]['objects'])} editable objects.")
    return 0


if __name__=="__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print("OpenCode scene proposal failed: "+str(exc),file=sys.stderr)
        sys.exit(1)
