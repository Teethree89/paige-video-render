#!/usr/bin/env bash
set -euo pipefail

# The FTP account already logs in to its intended web directory.
# Publish relative to that login directory, not an absolute filesystem path.
: "${FTP_HOST:?FTP_HOST repository secret required}"
: "${FTP_USER:?FTP_USER repository secret required}"
: "${FTP_PASSWORD:?FTP_PASSWORD repository secret required}"

if [[ ! "$FTP_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; then
  echo 'FTP_HOST must be a hostname' >&2
  exit 2
fi
if [[ ! -s ftp-public/index.html || ! -s ftp-public/downloads/paige-video-render-workspace.zip ]]; then
  echo 'FTP payload missing. Build and stage the workspace first.' >&2
  exit 2
fi

# Plain FTP over port 21, as explicitly requested. Credentials and files are
# transmitted without encryption. Password is not placed in CLI arguments.
export LFTP_PASSWORD="$FTP_PASSWORD"
lftp <<LFTP
set cmd:fail-exit yes
set net:max-retries 2
set net:timeout 30
set ftp:ssl-allow no
set ftp:ssl-force no
set ftp:ssl-protect-data no
set ftp:passive-mode yes
open --user "$FTP_USER" --env-password --port 21 ftp://$FTP_HOST
mirror --reverse --verbose=0 --parallel=3 ftp-public .
bye
LFTP

echo 'Published the public workspace to the FTP login directory over standard FTP.'
