#!/usr/bin/env bash
# A branch reached only through branchr-relay, for relay-gateway.spec: its api (:18180) and
# sfu (:18190, UDP 51200+) sit behind a gateway (http :18800, quic :17443, public UDP 51300+)
# and a connector, the way a home server sits behind branchr.us.
set -euo pipefail
cd "$(dirname "$0")/../.."
D="${E2E_DATA:-/tmp/branchr-e2e}/relay-$(date +%s%N)"
mkdir -p "$D"
trap 'kill 0' EXIT
cargo build -q -p api -p sfu -p relay
DATABASE_URL="sqlite://$D/db.sqlite" UPLOAD_DIR="$D/up" API_BIND=127.0.0.1:18180 SFU_URLS=ws://relayed.localhost:18800/sfu/ws TRUST_PROXY=1 VOICE_SECRET=e2e-relay target/debug/api &
SFU_BIND=127.0.0.1:18190 SFU_UDP_PORT=51200 SFU_WORKERS=2 SFU_PUBLIC_IP=127.0.0.1 SFU_PUBLIC_UDP_PORT=51300 VOICE_SECRET=e2e-relay target/debug/sfu &
TOKEN=$(RELAY_DIR="$D/gateway" RELAY_PUBLIC=127.0.0.1:17443 target/debug/branchr-relay add relayed relayed.localhost 51300 2 2>/dev/null)
RELAY_DIR="$D/gateway" RELAY_QUIC=127.0.0.1:17443 RELAY_HTTP=127.0.0.1:18800 target/debug/branchr-relay serve &
RELAY_TOKEN="$TOKEN" RELAY_API=http://127.0.0.1:18180 RELAY_SFU=http://127.0.0.1:18190 RELAY_SFU_UDP=127.0.0.1:51200 target/debug/branchr-relay connect &
wait
