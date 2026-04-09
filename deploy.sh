#!/usr/bin/env bash
# Deploy server.js to the VPS and restart the API.
# Usage: ./server/deploy.sh
set -e

HOST="root@77.42.76.62"
REMOTE="/opt/kutt/api/server.js"
LOCAL="$(dirname "$0")/server.js"

echo "→ uploading server.js..."
scp "$LOCAL" "$HOST:$REMOTE"

echo "→ restarting kutt-api..."
ssh "$HOST" "systemctl restart kutt-api && sleep 1 && systemctl is-active kutt-api"

echo "→ recent logs:"
ssh "$HOST" "journalctl -u kutt-api -n 10 --no-pager"

echo "✓ done"
