#!/usr/bin/env bash
# Build and (re)start the api + sfu containers on a remote Docker host over SSH.
# Works on any Docker host (e.g. Unraid), no compose plugin needed.
#
#   PUBLIC_IP=203.0.113.10 scripts/deploy-docker.sh root@your-server
#
# Env: PUBLIC_IP (required: the address clients send media to, or "auto" for a hub at home,
#      which then finds it and opens its ports on the router itself), API_PORT (8740), SFU_PORT (8741),
#      UDP_PORT (51000), SFU_WORKERS (8), APPDIR (/mnt/user/appdata/branchr),
#      SFU_URL (default ws://PUBLIC_IP:SFU_PORT/ws; use wss://... behind a TLS proxy),
#      SFU_PUBLIC_UDP_PORT (ports advertised for media, when a relay forwards others to ours).
# The host's $APPDIR/.env goes to the api too (e.g. PUBLIC_URL, AUTH_MODE, BRANCHR_ID_URL,
# INSTANCE_NAME, TRUST_PROXY). With $APPDIR/relay.env (RELAY_TOKEN=...), a branchr-relay
# connector runs next to them, so the hub is reached through a gateway (see the README).
# A hub at home: PUBLIC_IP=auto with RELAY=1 and TRUST_PROXY=1 in .env (no relay.env).
set -euo pipefail
HOST=${1:?usage: deploy-docker.sh user@host}
: "${PUBLIC_IP:?set PUBLIC_IP}"
API_PORT=${API_PORT:-8740}
SFU_PORT=${SFU_PORT:-8741}
UDP_PORT=${UDP_PORT:-51000}
SFU_WORKERS=${SFU_WORKERS:-8}
APPDIR=${APPDIR:-/mnt/user/appdata/branchr}
SFU_URL=${SFU_URL:-ws://$PUBLIC_IP:$SFU_PORT/ws}
UDP_END=$((UDP_PORT + SFU_WORKERS - 1))
SFU_PUBLIC_UDP_PORT=${SFU_PUBLIC_UDP_PORT:-$UDP_PORT}

cd "$(dirname "$0")/.."
ssh "$HOST" "mkdir -p $APPDIR/src $APPDIR/data"
rsync -az --delete --exclude target --exclude node_modules --exclude 'apps/*/dist' \
  --exclude apps/desktop/release --exclude apps/desktop/web --exclude .git --exclude 'tests/e2e/test-results' \
  ./ "$HOST:$APPDIR/src/"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $APPDIR
DOCKER_BUILDKIT=1 docker build -q -t branchr:latest src
[ -f .env ] || printf "VOICE_SECRET=%s\n" "\$(openssl rand -hex 32)" > .env
chmod 600 .env; . ./.env
docker rm -f branchr-api branchr-sfu branchr-relay >/dev/null 2>&1 || true
if [ "$PUBLIC_IP" = auto ]; then
  # A hub at home (with RELAY=1 in .env, reached through branchr.us): the api dials the
  # gateway and hands it voice signaling, so it reaches the sfu on localhost.
  docker run -d --name branchr-api --restart unless-stopped --ulimit nofile=1048576 --network host --env-file .env \
    -e API_BIND=0.0.0.0:$API_PORT -e VOICE_SECRET=\$VOICE_SECRET -e SFU_URLS=ws://127.0.0.1:$SFU_PORT/ws \
    -v $APPDIR/data:/data branchr:latest api >/dev/null
  # Host networking: it sees its LAN address and can talk UPnP to the router.
  docker run -d --name branchr-sfu --restart unless-stopped --ulimit nofile=1048576 --network host \
    -e SFU_BIND=0.0.0.0:$SFU_PORT -e VOICE_SECRET=\$VOICE_SECRET -e SFU_PUBLIC_IP=auto \
    -e SFU_UDP_PORT=$UDP_PORT -e SFU_WORKERS=$SFU_WORKERS branchr:latest sfu >/dev/null
else
  docker run -d --name branchr-api --restart unless-stopped --ulimit nofile=1048576 --env-file .env \
    -e API_BIND=0.0.0.0:8080 -e VOICE_SECRET=\$VOICE_SECRET -e SFU_URLS=$SFU_URL \
    -v $APPDIR/data:/data -p $API_PORT:8080 branchr:latest api >/dev/null
  docker run -d --name branchr-sfu --restart unless-stopped --ulimit nofile=1048576 \
    -e SFU_BIND=0.0.0.0:8090 -e VOICE_SECRET=\$VOICE_SECRET -e SFU_PUBLIC_IP=$PUBLIC_IP \
    -e SFU_UDP_PORT=$UDP_PORT -e SFU_PUBLIC_UDP_PORT=$SFU_PUBLIC_UDP_PORT -e SFU_WORKERS=$SFU_WORKERS \
    -p $SFU_PORT:8090 -p $UDP_PORT-$UDP_END:$UDP_PORT-$UDP_END/udp branchr:latest sfu >/dev/null
fi
if [ -f relay.env ]; then
  # Host networking: it reaches the api, the sfu and its UDP ports on localhost.
  docker run -d --name branchr-relay --restart unless-stopped --network host --env-file relay.env \
    -e RELAY_API=http://127.0.0.1:$API_PORT -e RELAY_SFU=http://127.0.0.1:$SFU_PORT -e RELAY_SFU_UDP=127.0.0.1:$UDP_PORT \
    branchr:latest branchr-relay connect >/dev/null
fi
docker image prune -f >/dev/null
REMOTE
echo "deployed: api :$API_PORT, sfu :$SFU_PORT ($SFU_URL), media on udp $UDP_PORT-$UDP_END (public address: $PUBLIC_IP)"
