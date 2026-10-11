#!/usr/bin/env bash
# Build and (re)start the api + sfu containers on a remote Docker host over SSH.
# Works on any Docker host (e.g. Unraid), no compose plugin needed.
#
#   PUBLIC_IP=203.0.113.10 scripts/deploy-docker.sh root@your-server
#
# Env: PUBLIC_IP (required, address clients send media to), API_PORT (8740), SFU_PORT (8741),
#      UDP_PORT (51000), SFU_WORKERS (8), APPDIR (/mnt/user/appdata/discord-clone),
#      SFU_URL (default ws://PUBLIC_IP:SFU_PORT/ws; use wss://... behind a TLS proxy).
set -euo pipefail
HOST=${1:?usage: deploy-docker.sh user@host}
: "${PUBLIC_IP:?set PUBLIC_IP}"
API_PORT=${API_PORT:-8740}
SFU_PORT=${SFU_PORT:-8741}
UDP_PORT=${UDP_PORT:-51000}
SFU_WORKERS=${SFU_WORKERS:-8}
APPDIR=${APPDIR:-/mnt/user/appdata/discord-clone}
SFU_URL=${SFU_URL:-ws://$PUBLIC_IP:$SFU_PORT/ws}
UDP_END=$((UDP_PORT + SFU_WORKERS - 1))

cd "$(dirname "$0")/.."
ssh "$HOST" "mkdir -p $APPDIR/src $APPDIR/data"
rsync -az --delete --exclude target --exclude node_modules --exclude 'apps/*/dist' \
  --exclude apps/desktop/release --exclude apps/desktop/web --exclude .git --exclude 'tests/e2e/test-results' \
  ./ "$HOST:$APPDIR/src/"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $APPDIR
DOCKER_BUILDKIT=1 docker build -q -t discord-clone:latest src
[ -f .env ] || printf "VOICE_SECRET=%s\n" "\$(openssl rand -hex 32)" > .env
chmod 600 .env; . ./.env
docker rm -f discord-clone-api discord-clone-sfu >/dev/null 2>&1 || true
docker run -d --name discord-clone-api --restart unless-stopped \
  -e API_BIND=0.0.0.0:8080 -e VOICE_SECRET=\$VOICE_SECRET -e SFU_URLS=$SFU_URL \
  -v $APPDIR/data:/data -p $API_PORT:8080 discord-clone:latest api >/dev/null
docker run -d --name discord-clone-sfu --restart unless-stopped \
  -e SFU_BIND=0.0.0.0:8090 -e VOICE_SECRET=\$VOICE_SECRET -e SFU_PUBLIC_IP=$PUBLIC_IP \
  -e SFU_UDP_PORT=$UDP_PORT -e SFU_WORKERS=$SFU_WORKERS \
  -p $SFU_PORT:8090 -p $UDP_PORT-$UDP_END:$UDP_PORT-$UDP_END/udp discord-clone:latest sfu >/dev/null
docker image prune -f >/dev/null
REMOTE
echo "deployed: http://$PUBLIC_IP:$API_PORT (sfu $SFU_URL, udp $UDP_PORT-$UDP_END)"
