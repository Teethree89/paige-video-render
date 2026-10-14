#!/usr/bin/env python3
"""Limited, safe benchmarking of free Zen models on a *public example video*.

Two stages: a text-only access probe and (only if accepted) a three-frame scene
proposal. Records a sanitized, explicit per-model outcome for GitHub artifacts.
Does not print prompts, provider output, video data, or secret values.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from zen_scene import FREE_MODELS
from zen_cli_scene import run_opencode, main as generate_scene


MODELS_TO_BENCHMARK = (
    "mimo-v2.6-flash-free", "mimo-v2.5-free",
    "nemotron-3.5-lightning-free", "big-pickle"
)


def classification(error: Exception) -> str:
    # No exception messages ever leave this function.
    text = str(error)
    for category in (
        "FREE_TIER_CLIENT_RESTRICTION", "MODEL_REGION_RESTRICTION",
        "INVALID_OR_UNAUTHORIZED_ZEN_KEY", "MODEL_NOT_AVAILABLE_IN_CLI",
        "PROVIDER_CONFIGURATION_ERROR", "MODEL_DISABLED_FOR_WORKSPACE",
        "OPENCODE_PERMISSION_REJECTION", "MODEL_RATE_LIMIT",
        "OTHER_CLI_OR_PROVIDER_ERROR", "CLI_EXIT_WITHOUT_DIAGNOSTIC",
    ):
        if category in text:
            return category
    if isinstance(error, TimeoutError) or "timed out" in text.lower():
        return "REQUEST_TIMEOUT"
    if "no text events" in text.lower():
        return "MODEL_RETURNED_NO_TEXT"
    if "api key" in text.lower() or "zen_api" in text.lower():
        return "MISSING_ZEN_SECRET"
    if "ffmpeg" in text.lower() or "video frames" in text.lower():
        return "FRAME_EXTRACTION_FAILED"
    if isinstance(error, (ValueError, json.JSONDecodeError)):
        return "MODEL_RESPONSE_INVALID_JSON_OR_SCHEMA"
    return "OTHER_TEST_FAILURE"


def try_model(model: str, secret: str, *, shot="hall") -> dict:
    if model not in MODELS_TO_BENCHMARK or model not in FREE_MODELS:
        raise ValueError("Model is not in the approved free benchmark allowlist")
    outcome = {"model": model, "cost_class": "Zen-listed-free",
               "text_access": "NOT_RUN", "vision_json": "NOT_RUN",
               "diagnostic": "NOT_RUN", "geometry_count": None}
    if not secret:
        outcome.update({"text_access":"BLOCKED", "diagnostic":"MISSING_ZEN_SECRET"})
        return outcome
    try:
        # A small text-only call distinguishes API/free-tier restrictions from
        # problems caused by attaching reference images to the prompt.
        run_opencode(model, shot, [], [], secret)
    except Exception as error:
        outcome.update({"text_access":"FAILED",
                        "diagnostic": classification(error)})
        return outcome
    outcome["text_access"] = "PASSED"

    try:
        from pathlib import Path
        output = f"ai-proposals/{shot}-{model}-primitives.json"
        generate_scene(["--timeline","timeline.json",
                        "--video","assets/reference.mp4",
                        "--shot",shot,"--model",model,
                        "--frames","3","--output",output])
        payload = json.loads(Path(output).read_text(encoding="utf-8"))
        outcome.update({"vision_json":"PASSED",
                        "diagnostic":"VALIDATED_PRIMITIVE_JSON",
                        "geometry_count":len(payload["scenes"][0]["objects"])})
    except Exception as error:
        outcome.update({"vision_json":"FAILED",
                        "diagnostic":classification(error)})
    return outcome


def main() -> int:
    p=argparse.ArgumentParser()
    p.add_argument("--model",choices=MODELS_TO_BENCHMARK,required=True)
    p.add_argument("--shot",default="hall")
    p.add_argument("--report",default="ai-proposals/benchmark-result.json")
    args=p.parse_args()
    output=Path(args.report).resolve()
    if not output.is_relative_to(Path.cwd().resolve()) or output.suffix!=".json":
        raise ValueError("Report path must be JSON inside checkout")
    report=try_model(args.model,os.environ.get("ZEN_API_KEY",""),shot=args.shot)
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(f"Model: {report['model']}")
    print(f"Text-only API: {report['text_access']}")
    print(f"Three-frame geometry: {report['vision_json']}")
    print(f"Diagnostic: {report['diagnostic']}")
    if report["geometry_count"] is not None:
        print(f"Editable primitives: {report['geometry_count']}")
    # Successful benchmark execution != successful model inference.
    return 0


if __name__=="__main__":
    raise SystemExit(main())
