#!/usr/bin/env bash
# Runs ON the VPS, piped over SSH by .github/workflows/deploy.yml.
#  1. Provisions the server (ops/bootstrap.sh) when it's brand new or ops/ changed.
#  2. Installs the frontend.
#  3. Installs server.js and restarts the API only when it (or package.json)
#     changed — a restart re-warms all filmstrip caches, so frontend-only
#     deploys skip it.
#  4. Gets/extends the TLS certificate once DNS points at this server.
#
# This script arrives on stdin: anything in it that reads stdin (ffmpeg, apt,
# npm, certbot…) must get </dev/null or it swallows the rest of the script.
set -e
D=/tmp/kutt-deploy

OPS_HASH=$(cat "$D"/ops/* | sha256sum | cut -d' ' -f1)
if [ "$(cat /opt/kutt/.ops-hash 2>/dev/null || true)" != "$OPS_HASH" ]; then
  echo "--- provisioning (new server, or ops/ changed) ---"
  bash "$D/ops/bootstrap.sh" </dev/null
  echo "$OPS_HASH" > /opt/kutt/.ops-hash
fi

cp "$D/index.html" /var/www/html/index.html          # onboarding landing
mkdir -p /var/www/html/app /var/www/html/fonts
cp "$D/app.html" /var/www/html/app/index.html        # the app, served at /app/
cp "$D/overview.html" /var/www/html/overview.html
cp "$D/og.png" /var/www/html/og.png
for w in 400 500 700 900; do
  cp "$D/diatype-$w.woff2" "/var/www/html/fonts/diatype-$w.woff2"
done
echo "frontend installed"

API=/opt/kutt/api
RESTART=
if ! cmp -s "$D/package.json" "$API/package.json" || [ ! -d "$API/node_modules" ]; then
  cp "$D/package.json" "$API/package.json"
  (cd "$API" && npm install --omit=dev --no-audit --no-fund --loglevel=error </dev/null)
  echo "node deps installed"
  RESTART=1
fi
if ! cmp -s "$D/server.js" "$API/server.js"; then
  cp "$D/server.js" "$API/server.js"
  RESTART=1
fi
if [ -n "$RESTART" ]; then
  systemctl restart kutt-api
  sleep 2
  systemctl is-active kutt-api
  echo "server.js changed — kutt-api restarted"
else
  systemctl is-active --quiet kutt-api || systemctl start kutt-api
  echo "server.js unchanged — no restart"
fi

echo "--- tls ---"
# Only ask Let's Encrypt for names that already resolve here: a failed
# challenge counts against its rate limit. Deploys retry until DNS catches up.
CERT=/etc/letsencrypt/live/kutt.cam/cert.pem
has_name() { [ -f "$CERT" ] && openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:$1"; }
WANT=""; MISSING=""
for n in kutt.cam kutt.online; do
  ip=$(getent ahostsv4 "$n" | awk 'NR==1{print $1}')
  if [ -n "$ip" ] && hostname -I | tr ' ' '\n' | grep -qx "$ip"; then
    WANT="$WANT -d $n"
    if has_name "$n"; then echo "$n: certificate OK"; else MISSING=1; fi
  else
    echo "$n -> ${ip:-nothing}: DNS doesn't point here yet"
  fi
done
if [ -n "$MISSING" ] && echo "$WANT" | grep -q 'kutt.cam'; then
  certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email \
    --redirect --expand --cert-name kutt.cam $WANT </dev/null \
    && echo "certificate issued for:$WANT" \
    || echo "certbot failed — site still answers on http; next deploy retries"
fi

rm -rf "$D"

# Host report. Clips are never auto-deleted, so disk headroom is the number
# that eventually bites — worth seeing on every deploy.
echo "--- host ---"
echo "cpu:    $(nproc) cores — $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
echo "load:   $(cut -d' ' -f1-3 /proc/loadavg)"
free -h | awk '/^Mem:/{print "mem:    "$3" used / "$2" total ("$7" available)"}'
df -h / | awk 'NR==2{print "disk:   "$3" used / "$2" ("$5" full, "$4" free)"}'
echo "clips:  $(ls /opt/kutt/clips/*.mp4 2>/dev/null | wc -l) files, $(du -sh /opt/kutt/clips 2>/dev/null | cut -f1) total"
echo "ring:   $(ls /tmp/kutt-filmstrips/ring/*.jpg 2>/dev/null | wc -l) frames, $(du -sh /tmp/kutt-filmstrips 2>/dev/null | cut -f1)"
echo "stream: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8888/table2/index.m3u8) (200 = OBS is live)"
echo "top rss:"
ps -eo rss,comm --sort=-rss | awk 'NR>1 && NR<=6 {printf "        %6.0f MB  %s\n", $1/1024, $2}'
