#!/usr/bin/env bash
# Provision a fresh Ubuntu VPS (e.g. a DigitalOcean droplet) and deploy with HTTPS.
#
#   DOMAIN=chat.example.com scripts/deploy-vps.sh root@<vps-ip>
#
# Before running: point an A record for DOMAIN at the droplet (DNS only / not proxied).
# Env: SFU_WORKERS (default 2; opens UDP 50000..50000+workers-1).
set -euo pipefail
HOST=${1:?usage: deploy-vps.sh user@host}
: "${DOMAIN:?set DOMAIN}"
SFU_WORKERS=${SFU_WORKERS:-2}
UDP_END=$((50000 + SFU_WORKERS - 1))
APPDIR=/opt/discord-clone

cd "$(dirname "$0")/.."
ssh "$HOST" "command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh); mkdir -p $APPDIR"
rsync -az --delete --exclude target --exclude node_modules --exclude 'apps/*/dist' \
  --exclude apps/desktop/release --exclude apps/desktop/web --exclude .git --exclude 'tests/e2e/test-results' \
  --exclude data --exclude .env ./ "$HOST:$APPDIR/"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $APPDIR
PUBLIC_IP=\$(curl -fsS https://api.ipify.org)
[ -f .env ] || printf "VOICE_SECRET=%s\n" "\$(openssl rand -hex 32)" > .env
grep -q '^DOMAIN=' .env && sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env || echo "DOMAIN=$DOMAIN" >> .env
grep -q '^PUBLIC_IP=' .env && sed -i "s/^PUBLIC_IP=.*/PUBLIC_IP=\$PUBLIC_IP/" .env || echo "PUBLIC_IP=\$PUBLIC_IP" >> .env
grep -q '^SFU_WORKERS=' .env && sed -i "s/^SFU_WORKERS=.*/SFU_WORKERS=$SFU_WORKERS/" .env || echo "SFU_WORKERS=$SFU_WORKERS" >> .env
grep -q '^SFU_UDP_END=' .env && sed -i "s/^SFU_UDP_END=.*/SFU_UDP_END=$UDP_END/" .env || echo "SFU_UDP_END=$UDP_END" >> .env
chmod 600 .env
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
  ufw allow 50000:$UDP_END/udp >/dev/null; ufw --force enable >/dev/null
fi
docker compose -f docker-compose.yml -f deploy/docker-compose.public.yml up -d --build
docker image prune -f >/dev/null
REMOTE
echo "deployed: https://$DOMAIN (sfu wss://$DOMAIN/sfu/ws, udp 50000-$UDP_END)"
