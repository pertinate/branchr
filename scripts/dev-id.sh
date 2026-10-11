#!/usr/bin/env bash
# Runs branchr ID locally against real Discord, for trying sign-in from the dev web app
# (http://localhost:5173) or the desktop app.
#
# Reads ~/.config/branchr/id.env (DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DATABASE_URL);
# keep that file outside the repo. Discord must allow the redirect
# http://localhost:8070/auth/discord/callback (Developer Portal → OAuth2 → Redirects).
set -euo pipefail
ENV_FILE="${BRANCHR_ID_ENV:-$HOME/.config/branchr/id.env}"
[[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
# Taken literally: no shell expansion of the values.
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  export "$key=$value"
done < "$ENV_FILE"
export ID_BIND="${ID_BIND:-127.0.0.1:8070}"
export PUBLIC_URL="${PUBLIC_URL:-http://localhost:8070}"
export ALLOWED_REDIRECTS="${ALLOWED_REDIRECTS:-branchr://auth/callback,http://localhost:5173/}"
cd "$(dirname "$0")/.."
exec cargo run -q -p id --bin branchr-id
