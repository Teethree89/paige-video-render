#!/usr/bin/env python3
"""Verify browser-fetched AE builder is exactly the version staged by FTP.

The builder is public, but don't log arbitrary response bodies or server paths.
Called after FTP publication; deployment should not count as healthy if the
editor's mandatory After Effects source returns 404 or stale bytes.
"""
import hashlib
from pathlib import Path
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "AfterEffects" / "BUILD_EDITABLE_PROJECT.jsx"
URL = "https://paige-lighthouse.50webs.org/Indium/paiver/AfterEffects/BUILD_EDITABLE_PROJECT.jsx"


def verify(fetcher=urlopen, attempts=4, pause=time.sleep):
    expected = BUILDER.read_bytes()
    if len(expected) < 100 or b"function addCameraKeys" not in expected or b"aeOrigin" not in expected:
        raise RuntimeError("Local builder is missing or invalid")
    expected_sha = hashlib.sha256(expected).digest()
    last = "not attempted"
    for n in range(attempts):
        try:
            # Cache-bust to prevent old 404 responses or stale JSX from validating.
            request = Request(URL + "?version=" + os.getenv("GITHUB_SHA", "current"),
                              headers={"Cache-Control": "no-cache",
                                       "User-Agent": "PaigeAEExportSmokeTest/1.0"})
            with fetcher(request, timeout=20) as response:
                code = response.status
                remote = response.read(len(expected) + 1)
            if code == 200 and len(remote) == len(expected) and hashlib.sha256(remote).digest() == expected_sha:
                return True, "HTTP 200, exact builder bytes verified"
            last = f"HTTP {code}, content-matches={str(len(remote) == len(expected) and hashlib.sha256(remote).digest() == expected_sha).lower()}"
        except HTTPError as error:
            last = f"HTTP {error.code}"
            error.close()
        except (URLError, TimeoutError, OSError) as error:
            last = "connection failure (" + type(error).__name__ + ")"
        if n + 1 < attempts:
            pause(4)
    return False, last


if __name__ == "__main__":
    ok, result = verify()
    print("Live AE builder:", result)
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("\n### After Effects browser export asset\n\n")
            handle.write(("✅ " if ok else "❌ ") + result + "\n")
    sys.exit(0 if ok else 1)
