#!/usr/bin/env bash
set -euo pipefail

# Only uploads into <FTP_REMOTE_DIR>/current; never the whole FTP account root.
: "${FTP_HOST:?FTP_HOST secret required}"
: "${FTP_USER:?FTP_USER secret required}"
: "${FTP_PASSWORD:?FTP_PASSWORD secret required}"
: "${FTP_REMOTE_DIR:?FTP_REMOTE_DIR secret required}"
FTP_PROTOCOL="${FTP_PROTOCOL:-sftp}"

if [[ "$FTP_PROTOCOL" != 'sftp' && "$FTP_PROTOCOL" != 'ftps' ]]; then
  echo 'Only encrypted sftp or ftps are permitted' >&2; exit 2
fi
if [[ ! "$FTP_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; then
  echo 'FTP_HOST must be hostname or IP only' >&2; exit 2
fi
if [[ ! "$FTP_REMOTE_DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]] || [[ "$FTP_REMOTE_DIR" == '/' ]] || \
   [[ "$FTP_REMOTE_DIR" == *'..'* ]] || [[ "$FTP_REMOTE_DIR" == *'//'* ]]; then
  echo 'FTP_REMOTE_DIR must be an absolute, dedicated non-root folder without traversal' >&2; exit 2
fi
if [[ ! "${FTP_PORT:-}" =~ ^[0-9]*$ ]]; then
  echo 'FTP_PORT must contain digits only' >&2; exit 2
fi
REMOTE="${FTP_REMOTE_DIR%/}/current"
PORT="${FTP_PORT:-}"

if [[ "$FTP_PROTOCOL" == 'sftp' ]]; then
  : "${FTP_KNOWN_HOSTS:?Set FTP_KNOWN_HOSTS to a VERIFIED known_hosts line for SFTP host key pinning}"
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  printf '%s\n' "$FTP_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
  chmod 600 "$HOME/.ssh/known_hosts"
  PORT="${PORT:-22}"
  export LFTP_CONNECT_PROGRAM="ssh -a -x -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
else
  PORT="${PORT:-21}"
fi

# Avoid shell history and command-argument exposure of credentials.
# `mirror --reverse --delete` is restricted to a dedicated `current` folder.
# lftp's FTP/SFTP variables are configured over standard input.
if [[ "$FTP_PROTOCOL" == 'ftps' ]]; then
  lftp <<LFTP
set cmd:fail-exit yes
set net:max-retries 2
set net:timeout 30
set ssl:verify-certificate yes
set ftp:ssl-force yes
set ftp:ssl-protect-data yes
open --user "$FTP_USER" --password "$FTP_PASSWORD" --port "$PORT" ftp://$FTP_HOST
mkdir -p "$REMOTE"
mirror --reverse --delete --verbose=0 --parallel=3 dist "$REMOTE"
bye
LFTP
else
  lftp <<LFTP
set cmd:fail-exit yes
set net:max-retries 2
set net:timeout 30
set sftp:connect-program "$LFTP_CONNECT_PROGRAM"
open --user "$FTP_USER" --password "$FTP_PASSWORD" --port "$PORT" sftp://$FTP_HOST
mkdir -p "$REMOTE"
mirror --reverse --delete --verbose=0 --parallel=3 dist "$REMOTE"
bye
LFTP
fi

echo "Published workspace into $REMOTE (via $FTP_PROTOCOL)"
