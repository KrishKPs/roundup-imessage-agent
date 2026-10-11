#!/bin/sh
# Server start: put the Photon CLI login (a Fly secret) where the CLI looks for it, then run the bot.
set -e
if [ -n "$PHOTON_CREDENTIALS_B64" ]; then
  mkdir -p "$HOME/.config/photon/credentials"
  echo "$PHOTON_CREDENTIALS_B64" | base64 -d > "$HOME/.config/photon/credentials/production.json"
  chmod 600 "$HOME/.config/photon/credentials/production.json"
fi
mkdir -p "$(dirname "${STATE_FILE:-data/state.json}")"
exec npx tsx src/index.ts
