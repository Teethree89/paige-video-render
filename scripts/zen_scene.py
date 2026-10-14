#!/usr/bin/env python3
"""Generate a *proposal* of editable 3D primitives from a video shot.

Runs ONLY in GitHub Actions or locally with a private ZEN_API_KEY. Never call
this from the public static editor and never commit a secret or source frames.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ZEN_RESPONSES_ENDPOINT = "https://opencode.ai/zen/v1/responses"
# Paid variants are intentionally excluded. Add other *tested* free vision
# providers in a separate adapter, not by changing this allowlist implicitly.
FREE_MODELS = ("muse-spark-1.3-contributor-free",)
MAX_VIDEO_BYTES = 250 * 1024 * 1024
SHOT_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


def project_file(value: str, extensions: set[str]) -> Path:
    candidate = (ROOT / value).resolve()
    if not candidate.is_relative_to(ROOT):
        raise ValueError("Input path must remain inside the checked-out repository")
    if candidate.suffix.lower() not in extensions:
        raise ValueError("Unsupported input file extension")
    if not candidate.is_file():
        raise ValueError("Input file is missing from the checkout")
    if candidate.stat().st_size > MAX_VIDEO_BYTES:
        raise ValueError("Video file exceeds 250 MiB safety limit")
    return candidate


def load_shot(timeline: Path, shot_id: str) -> tuple[dict, dict]:
    doc = json.loads(timeline.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("shots"), list):
        raise ValueError("Invalid timeline: expected shots array")
    shot = next((shot for shot in doc["shots"]
                 if isinstance(shot, dict) and shot.get("id") == shot_id), None)
    if shot is None:
        raise ValueError("Shot not found in timeline: " + shot_id)
    start, end = shot.get("start"), shot.get("end")
    duration = doc.get("duration")
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in (start, end, duration)):
        raise ValueError("Invalid shot timing")
    if not (0 <= start < end <= duration and end - start >= 0.2):
        raise ValueError("Invalid shot bounds")
    return doc, shot


def sample_times(start: float, end: float, count: int = 3) -> list[float]:
    if not 1 <= count <= 5:
        raise ValueError("Only 1–5 sampled frames permitted")
    duration = end - start
    return [round(start + duration * (i + 1) / (count + 1), 3) for i in range(count)]


def extract_jpegs(video: Path, times: list[float]) -> list[bytes]:
    images = []
    for at in times:
        try:
            process = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error",
                 "-ss", f"{at:.3f}", "-i", str(video), "-frames:v", "1",
                 "-vf", "scale=640:-2", "-q:v", "5", "-f", "image2pipe",
                 "-vcodec", "mjpeg", "-"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                check=True, timeout=40
            )
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            raise RuntimeError("Could not decode one of the source video frames") from None
        if not process.stdout.startswith(b"\\xff\\xd8") or len(process.stdout) > 500000:
            raise RuntimeError("Extracted frame was not a valid small JPEG")
        images.append(process.stdout)
    return images


PROMPT = """You are reconstructing a cinematic VIDEO shot as an EDITABLE THREE.JS 3D BLOCKOUT.
Study the provided frames in chronological order. Use only objects visible or strongly
supported by these frames. Do not invent hidden geometry or claim exact recovered depth.
Return ONLY one valid JSON document, with this exact root format:
{
  "schemaVersion": 1,
  "scenes": [{
    "shotId": "SHOT_ID_PLACEHOLDER",
    "objects": [
      {
        "id": "object_1",
        "name": "Descriptive object",
        "primitive": "box",
        "position": [0, 2, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 4, 2],
        "material": {
          "color": "#56778a",
          "metalness": 0.25,
          "roughness": 0.7
        }
      }
    ]
  }]
}
Allowed primitive types: box, cylinder, sphere, plane, torus.
All ids must be distinct short ASCII names matching [a-zA-Z0-9_-].
Positions/rotations/scales are numeric triplets; rotations are RADIANS;
all scale values must be 0.01 to 500, colors #RRGGBB, and material coefficients 0–1.
Coordinate system: +Y up; ground plane around Y=0; camera roughly at Z=+20,
looking toward -Z. Favor a coherent approximate scene visible from that viewpoint.
Be economical: maximum 16 objects. Use repetition when visually warranted, but do
not hallucinate copies. Reserve usable space for camera movement.
Do NOT output any scripts, markdown fences, or comments. Exact JSON only.
If there is insufficient visual evidence for objects, return objects: [].
"""


def build_request(model: str, shot_id: str, times: list[float], jpegs: list[bytes]) -> dict:
    if model not in FREE_MODELS:
        raise ValueError("Only explicitly approved free model variants are allowed")
    if len(times) != len(jpegs):
        raise ValueError("Frame timestamp/image mismatch")
    content = [{"type": "input_text", "text": PROMPT.replace("SHOT_ID_PLACEHOLDER", shot_id)}]
    for at, jpeg in zip(times, jpegs):
        content.append({"type": "input_text", "text": f"Reference frame at {at:.3f} seconds:"})
        content.append({"type": "input_image",
                        "image_url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")})
    return {"model": model, "input": [{"role": "user", "content": content}],
            "max_output_tokens": 3500}


def response_text(body: dict) -> str:
    if isinstance(body.get("output_text"), str):
        return body["output_text"]
    chunks = []
    for item in body.get("output", []):
        if not isinstance(item, dict):
            continue
        for part in item.get("content", []):
            if isinstance(part, dict) and part.get("type") == "output_text":
                chunks.append(part.get("text", ""))
    if not chunks:
        raise ValueError("OpenCode response contained no output text")
    return "".join(chunks)


def parse_scene(response: str, shot_id: str) -> dict:
    text = response.strip()
    # A subset of models still include a markdown JSON fence.
    if text.startswith("```"):
        text = re.sub(r"^\x60{3}(?:json)?\s*", "", text, count=1, flags=re.IGNORECASE)
        text = re.sub(r"\s*\x60{3}$", "", text, count=1)
    proposal = json.loads(text)
    if not isinstance(proposal, dict) or proposal.get("schemaVersion") != 1:
        raise ValueError("Model output is not a version 1 primitive document")
    scenes = proposal.get("scenes")
    if not isinstance(scenes, list) or len(scenes) != 1 or scenes[0].get("shotId") != shot_id:
        raise ValueError("Model output must contain one scene for the requested shot")
    objects = scenes[0].get("objects")
    if not isinstance(objects, list) or len(objects) > 16:
        raise ValueError("Model proposed more than 16 objects, or invalid objects array")
    return {"schemaVersion": 1, "scenes": [{"shotId": shot_id, "objects": objects}]}


def request_zen(payload: dict, api_key: str) -> dict:
    if not api_key:
        raise ValueError("Repository secret zen_api is not accessible in this workflow")
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        ZEN_RESPONSES_ENDPOINT, data=raw, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "Authorization": "Bearer " + api_key}
    )
    try:
        with urllib.request.urlopen(request, timeout=150) as response:
            return json.loads(response.read(4_000_000))
    except urllib.error.HTTPError as exc:
        # Do not print response bodies: gateway errors may reflect prompts.
        raise RuntimeError(f"Zen API returned HTTP {exc.code}; check model availability and account permissions") from None
    except urllib.error.URLError:
        raise RuntimeError("Zen API connection failed; network or provider unavailable") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeline", default="timeline.json")
    parser.add_argument("--video", default="assets/reference.mp4")
    parser.add_argument("--shot", default="hall")
    parser.add_argument("--model", default=FREE_MODELS[0], choices=FREE_MODELS)
    parser.add_argument("--frames", type=int, default=3, choices=range(1, 6))
    parser.add_argument("--output", default="ai-proposals/muse-hall.json")
    args = parser.parse_args(argv)

    if not SHOT_ID_PATTERN.fullmatch(args.shot):
        raise ValueError("Invalid shot identifier")
    timeline = project_file(args.timeline, {".json"})
    video = project_file(args.video, {".mp4", ".mov", ".webm"})
    _, shot = load_shot(timeline, args.shot)
    times = sample_times(shot["start"], shot["end"], args.frames)
    frames = extract_jpegs(video, times)
    # Images are intentionally not persisted and never printed to CI logs.
    payload = build_request(args.model, args.shot, times, frames)
    result = request_zen(payload, os.environ.get("ZEN_API_KEY", ""))
    proposal = parse_scene(response_text(result), args.shot)

    # A standalone JS runner applies the exact same validator as the editor.
    # Only validated documents can leave CI as downloadable artifacts.
    output = Path(args.output).resolve()
    if not output.is_relative_to(ROOT) or output.suffix != ".json":
        raise ValueError("Output must be a JSON file within the checkout")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".json.tmp")
    try:
        temporary.write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf-8")
        subprocess.run(["node", "scripts/validate_zen_scene.mjs", str(temporary), args.shot],
                       cwd=ROOT, timeout=20, check=True)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Generated validated primitive proposal for {args.shot}: "
          f"{len(proposal['scenes'][0]['objects'])} objects; "
          f"{len(times)} private reference frames used.")
    print(f"Download GitHub Actions artifact, then import {output.name} in Primitive Scene Editor.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Scene generation failed: {exc}", file=sys.stderr)
        sys.exit(1)
