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

# Host report. Clips are never auto-deleted, so disk headroom is the number
# that eventually bites — worth seeing on every deploy.
echo "--- host ---"
echo "cpu:    $(nproc) cores — $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
echo "load:   $(cut -d' ' -f1-3 /proc/loadavg)"
free -h | awk '/^Mem:/{print "mem:    "$3" used / "$2" total ("$7" available)"}'
df -h / | awk 'NR==2{print "disk:   "$3" used / "$2" ("$5" full, "$4" free)"}'
echo "clips:  $(ls /opt/kutt/clips/*.mp4 2>/dev/null | wc -l) files, $(du -sh /opt/kutt/clips 2>/dev/null | cut -f1) total"
echo "ring:   $(ls /tmp/kutt-filmstrips/ring/*.jpg 2>/dev/null | wc -l) frames, $(du -sh /tmp/kutt-filmstrips 2>/dev/null | cut -f1)"
echo "top rss:"
ps -eo rss,comm --sort=-rss | awk 'NR>1 && NR<=6 {printf "        %6.0f MB  %s\n", $1/1024, $2}'
echo "hls buffer config:"
grep -E "hlsSegment(Count|Duration|MaxSize)|hlsPartDuration|hlsVariant" /opt/kutt/mediamtx.yml 2>/dev/null | sed 's/^/        /' || echo "        (defaults)"

# TEMP: verify the motion-score filter chain against this box's ffmpeg build.
# NOTE: this script arrives on stdin (ssh 'bash -s'), and ffmpeg reads stdin —
# without </dev/null it swallows the rest of the script and the deploy dies with
# a bogus "command not found". Every ffmpeg call here must redirect stdin.
echo "--- motion score self-check ---"
MS() { ffmpeg -v error -i "$1" -i "$2" -filter_complex '[0][1]blend=all_mode=difference,format=gray,scale=1:1:flags=area' -frames:v 1 -f rawvideo - </dev/null 2>/dev/null | od -An -tu1 | tr -d ' \n'; }
ffmpeg -v error -f lavfi -i color=c=black:s=107x80 -frames:v 1 -y /tmp/ms_a.jpg </dev/null >/dev/null 2>&1 || true
ffmpeg -v error -f lavfi -i color=c=gray:s=107x80  -frames:v 1 -y /tmp/ms_b.jpg </dev/null >/dev/null 2>&1 || true
echo "  identical=[$(MS /tmp/ms_a.jpg /tmp/ms_a.jpg)] (expect 0)  black-vs-gray=[$(MS /tmp/ms_a.jpg /tmp/ms_b.jpg)] (expect ~128)"
rm -f /tmp/ms_a.jpg /tmp/ms_b.jpg
