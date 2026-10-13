#!/usr/bin/env bash
# A hub reached through a gateway by its branchr key (relay-key.spec): the gateway takes
# passes from the test branchr ID (:18070), and the hub's api (:18280, RELAY=1) runs the
# connector itself. Media goes to its sfu (:18290, UDP 51500+) directly.
set -euo pipefail
cd "$(dirname "$0")/../.."
D="${E2E_RELAY_KEY_DIR:?}"
rm -rf "$D/hub"; mkdir -p "$D/hub"
trap 'kill 0' EXIT
cargo build -q -p api -p sfu -p relay
RELAY_DIR="$D/gateway" RELAY_QUIC=127.0.0.1:17543 RELAY_HTTP=127.0.0.1:18900 RELAY_ID_URL=http://localhost:18070 RELAY_REQUIRE_CLAIMED=0 RELAY_MEDIA=off target/debug/branchr-relay serve &
SFU_BIND=127.0.0.1:18290 SFU_UDP_PORT=51500 SFU_WORKERS=2 SFU_PUBLIC_IP=127.0.0.1 VOICE_SECRET=e2e-key target/debug/sfu &
DATABASE_URL="sqlite://$D/hub/db.sqlite" UPLOAD_DIR="$D/hub/up" API_BIND=127.0.0.1:18280 SFU_URLS=ws://127.0.0.1:18290/ws VOICE_SECRET=e2e-key \
  AUTH_MODE=both BRANCHR_ID_URL=http://localhost:18070 INSTANCE_NAME="e2e relayed" RELAY=1 TRUST_PROXY=1 BRANCHR_POLL_SECS=1 CLAIM_FILE="$D/hub/claim.txt" \
  target/debug/api &
wait
