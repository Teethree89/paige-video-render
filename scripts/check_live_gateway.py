#!/usr/bin/env python3
"""Post-deploy public HTTPS checks; never print private response bodies or tokens.

The 50webs PHP proxy may return a CSRF value; it is parsed but NEVER logged.
The protected paiver.php URL is requested ONLY to inspect HTTP status;
its response body is NEVER read (even if the host accidentally exposes it).
"""
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

EDITOR = "https://paige-lighthouse.50webs.org/Indium/paiver/"
WORKER = "https://paige-video-render.ivaniscreative.workers.dev/health"
MAX_PUBLIC_BODY = 16000


def fetch(url, *, inspect_body=False):
    request = Request(url, headers={
        "User-Agent": "PaigeSceneDeploymentCheck/1.0",
        "Accept": "application/json,text/plain,*/*",
        "Cache-Control": "no-store",
    })
    try:
        with urlopen(request, timeout=18) as response:
            status = response.status
            body = response.read(MAX_PUBLIC_BODY) if inspect_body else b""
            return status, body, None
    except HTTPError as error:
        status = error.code
        body = error.read(MAX_PUBLIC_BODY) if inspect_body else b""
        error.close()
        return status, body, None
    except (URLError, TimeoutError, OSError) as error:
        # Some networking exceptions embed internal proxy hostnames. Do not print them.
        return None, b"", type(error).__name__


def bool_from_json(body, key):
    try:
        value = json.loads(body)
        if isinstance(value, dict) and isinstance(value.get(key), bool):
            return value[key]
    except (ValueError, UnicodeDecodeError):
        pass
    return None


def proxy_error_category(body):
    """Return a fixed, safe diagnostic category, never the actual response text."""
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return "not-json"
    if not isinstance(payload, dict):
        return "invalid-shape"
    error = payload.get("error")
    known = {
        "Private server configuration is not available": "private-file-not-readable",
        "Private server configuration could not be loaded": "private-file-load-failed",
        "Private server configuration is invalid": "private-file-invalid-return",
        "Private server configuration needs valid values": "private-config-values-invalid",
        "Worker endpoint must be an HTTPS workers.dev /api/scene URL": "worker-url-invalid",
        "PHP cURL extension is required": "php-curl-unavailable",
        "PHP sessions are required": "php-sessions-unavailable",
        "Could not start a private PHP session": "php-session-start-failed",
        "HTTPS is required": "php-https-unavailable",
    }
    return known.get(error, "other")


def run():
    entries = []
    problems = []

    def record(name, status, detail="", failure=False):
        entries.append(f"{name}: HTTP {status if status is not None else 'unreachable'}"
                       + (f" — {detail}" if detail else ""))
        if failure:
            problems.append(name)

    status, body, error = fetch(WORKER, inspect_body=True)
    worker_ready = bool_from_json(body, "ready")
    record("Cloudflare Worker /health", status, f"ready={worker_ready}",
           failure=(status != 200 or worker_ready is not True))

    probe = EDITOR + ".private/deny-check.txt"
    status, body, error = fetch(probe, inspect_body=True)
    text = body.decode("utf-8", "replace")
    path_exposed = any(marker in text.lower() for marker in (
        "/services/users/", "ah01630", "/home/www/", "/www/paige-lighthouse",
    ))
    record("Private guard harmless file", status,
           f"internal_path_disclosed={str(path_exposed).lower()}",
           failure=(status != 403 or path_exposed))

    # Never inspect, print or otherwise persist the contents of this response.
    status, _, error = fetch(EDITOR + ".private/paiver.php", inspect_body=False)
    record("Secret PHP direct URL (status only)", status, "body_not_read=true",
           failure=(status != 403))

    status, body, error = fetch(EDITOR + "scene-proxy.php", inspect_body=True)
    ok = bool_from_json(body, "ok")
    authenticated = bool_from_json(body, "authenticated")
    # Do not echo the PHP JSON: GET responses include a private CSRF value.
    reason = proxy_error_category(body) if status != 200 else "none"
    record("PHP proxy session GET", status,
           f"ok={ok} authenticated={authenticated} diagnostic={reason}; credentials_not_logged=true",
           failure=(status != 200 or ok is not True or authenticated is not False))

    output = "\n".join(entries + [
        "",
        "RESULT: " + ("FAIL (" + ", ".join(problems) + ")" if problems else "PASS"),
        "No tokens, passwords, paths, cookies, CSRF values, or private response bodies were logged.",
    ])
    print(output)
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("### Public gateway deployment checks\n\n")
            for entry in entries:
                handle.write("- " + entry + "\n")
            handle.write("\n**" + ("PASS" if not problems else "CHECK REQUIRED") + "**\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(run())
