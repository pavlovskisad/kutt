#!/usr/bin/env bash
# Runs ON the VPS, piped over SSH by .github/workflows/deploy.yml.
# Installs uploaded files from /tmp/kutt-deploy and restarts the API
# only when server.js actually changed (a restart re-warms all filmstrip
# caches, ~3 min — skip it for frontend-only deploys).
set -e

cp /tmp/kutt-deploy/index.html /var/www/html/index.html          # onboarding landing
mkdir -p /var/www/html/app
cp /tmp/kutt-deploy/app.html /var/www/html/app/index.html        # the app, served at /app/
cp /tmp/kutt-deploy/overview.html /var/www/html/overview.html
cp /tmp/kutt-deploy/og.png /var/www/html/og.png
mkdir -p /var/www/html/fonts
cp /tmp/kutt-deploy/unbounded.woff2 /var/www/html/fonts/unbounded.woff2
cp /tmp/kutt-deploy/martianmono.woff2 /var/www/html/fonts/martianmono.woff2
echo "frontend installed"

if ! cmp -s /tmp/kutt-deploy/server.js /opt/kutt/api/server.js; then
  cp /tmp/kutt-deploy/server.js /opt/kutt/api/server.js
  systemctl restart kutt-api
  sleep 1
  systemctl is-active kutt-api
  echo "server.js changed — kutt-api restarted"
else
  echo "server.js unchanged — no restart"
fi

rm -rf /tmp/kutt-deploy
