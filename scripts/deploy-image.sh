#!/usr/bin/env bash
# Roll a prebuilt image out to a host provisioned by deploy-vps.sh (used by CI).
#
#   IMAGE=ghcr.io/owner/branchr:<sha> scripts/deploy-image.sh root@<host>
#
# Env: REGISTRY_USER / REGISTRY_TOKEN to authenticate the pull (optional for public images).
# Keeps the host's .env (DOMAIN, VOICE_SECRET, ...) and data; only compose files and the
# image change. Fails if the API doesn't come back healthy.
set -euo pipefail
HOST=${1:?usage: deploy-image.sh user@host}
: "${IMAGE:?set IMAGE}"
APPDIR=/opt/branchr

cd "$(dirname "$0")/.."
ssh "$HOST" "test -f $APPDIR/.env || { echo 'no $APPDIR/.env; provision with scripts/deploy-vps.sh first' >&2; exit 1; }; mkdir -p $APPDIR/deploy"
scp -q docker-compose.yml "$HOST:$APPDIR/"
scp -q deploy/Caddyfile deploy/docker-compose.public.yml deploy/docker-compose.image.yml "$HOST:$APPDIR/deploy/"

if [ -n "${REGISTRY_TOKEN:-}" ]; then
  # Token goes over stdin, never on a command line.
  printf '%s' "$REGISTRY_TOKEN" | ssh "$HOST" "docker login ${IMAGE%%/*} -u '${REGISTRY_USER:?set REGISTRY_USER}' --password-stdin >/dev/null"
  trap 'ssh "$HOST" "docker logout ${IMAGE%%/*} >/dev/null" || true' EXIT
fi

ssh "$HOST" "IMAGE='$IMAGE' APPDIR='$APPDIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APPDIR"
grep -q '^IMAGE=' .env && sed -i "s|^IMAGE=.*|IMAGE=$IMAGE|" .env || echo "IMAGE=$IMAGE" >> .env
compose="docker compose -f docker-compose.yml -f deploy/docker-compose.public.yml -f deploy/docker-compose.image.yml"
$compose pull --quiet
$compose up -d --remove-orphans
for i in $(seq 1 30); do
  if $compose exec -T caddy wget -qO- http://api:8080/api/health >/dev/null 2>&1; then
    docker image prune -f >/dev/null
    echo "healthy: $IMAGE"
    exit 0
  fi
  sleep 2
done
echo "api did not become healthy" >&2
$compose logs --tail 50 api sfu >&2
exit 1
REMOTE
