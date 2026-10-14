#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 scripts/reconstruct_media.py
python3 -m http.server 8000
