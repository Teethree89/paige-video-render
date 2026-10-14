#!/usr/bin/env bash
# Convert a browser-produced WebM to an After Effects / Premiere compatible H.264 MP4.
set -euo pipefail
if [ $# -lt 1 ]; then echo 'Usage: ./convert_to_mp4.sh input.webm [output.mp4]'; exit 1; fi
if ! command -v ffmpeg >/dev/null; then echo 'Install FFmpeg first: https://ffmpeg.org/download.html'; exit 1; fi
input="$1";output="${2:-${input%.*}.mp4}"
ffmpeg -y -i "$input" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart -an "$output"
echo "Created: $output"
