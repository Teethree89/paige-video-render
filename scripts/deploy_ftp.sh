#!/usr/bin/env bash
set -euo pipefail

# Match the proven APPARANYX/grasstex 50webs login command.
# This FTP account starts in the requested web directory.
: "${FTP_HOST:?FTP_HOST missing}"
: "${FTP_USER:?FTP_USER missing}"
: "${FTP_PASSWORD:?Set repository secret FTP_PASS or FTP_PASSWORD}"

if [[ ! "$FTP_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo 'FTP_HOST must be a hostname only' >&2; exit 2
fi
if [[ ! -s ftp-public/index.html || ! -s ftp-public/downloads/paige-video-render-workspace.zip ]]; then
  echo 'Deployment payload missing; build workspace first' >&2; exit 2
fi

# FTP without TLS as requested. The username/password are passed using
# the same lftp -u syntax as the working Grasstex deployment.
# Never enable shell tracing here; password is masked by GitHub Actions.
lftp -u "$FTP_USER","$FTP_PASSWORD" "$FTP_HOST" <<'LFTP'
set cmd:fail-exit yes
set net:max-retries 2
set net:timeout 30
set ftp:ssl-allow no
set ftp:passive-mode true
mirror -R --verbose=1 ftp-public .
bye
LFTP

echo 'Paige workspace published to the FTP account login directory.'
