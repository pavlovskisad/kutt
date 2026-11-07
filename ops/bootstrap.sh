#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 server into a KUTT box: packages, MediaMTX,
# configs, systemd units, nginx vhost, Node deps, directories.
#
# You never run this by hand. .github/scripts/remote-deploy.sh runs it on
# every deploy where the server is new or anything in ops/ changed. It is
# idempotent: re-running it on a working server changes nothing that's live
# (MediaMTX is only restarted when its binary or config actually changed,
# since a restart drops the 30-minute buffer and makes OBS reconnect).
#
# Expects the deploy upload in /tmp/kutt-deploy (ops/ files + package.json).
set -euo pipefail
D=/tmp/kutt-deploy
MTX_VERSION=v1.15.3
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -q </dev/null
apt-get install -y -q nginx ffmpeg nodejs npm certbot python3-certbot-nginx curl ca-certificates openssl </dev/null
node --version

echo "== swap (keeps an encode spike from OOM-killing MediaMTX and its buffer)"
if ! swapon --show | grep -q .; then
  if [ -f /swapfile ] || fallocate -l 2G /swapfile; then
    chmod 600 /swapfile
    { mkswap /swapfile >/dev/null && swapon /swapfile \
        && { grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; } \
        && echo "2G swapfile added"; } || echo "swap not enabled (non-fatal)"
  fi
fi

echo "== directories"
mkdir -p /opt/kutt/api /opt/kutt/clips/thumbs /opt/kutt/logos /var/www/html/app /var/www/html/fonts

echo "== mediamtx $MTX_VERSION"
MTX_CHANGED=
case "$(uname -m)" in
  x86_64)  ARCH=amd64; SHA=cddc98d17f23689848d5a935151264e117cfb27cee2db87b5079b19572e4b48d ;;
  aarch64) ARCH=arm64; SHA=5f3cb84ef42952a82b1ff5764fd06dc13697d21b06eb179d83663ec55d15ed0c ;;
  *) echo "unsupported CPU: $(uname -m)"; exit 1 ;;
esac
if [ "$(cat /opt/kutt/.mediamtx-version 2>/dev/null || true)" != "$MTX_VERSION" ] || [ ! -x /opt/kutt/mediamtx ]; then
  T=$(mktemp -d)
  curl -fsSL -o "$T/m.tgz" "https://github.com/bluenviron/mediamtx/releases/download/$MTX_VERSION/mediamtx_${MTX_VERSION}_linux_$ARCH.tar.gz"
  echo "$SHA  $T/m.tgz" | sha256sum -c - >/dev/null
  tar -xzf "$T/m.tgz" -C "$T" mediamtx
  install -m 755 "$T/mediamtx" /opt/kutt/mediamtx
  echo "$MTX_VERSION" > /opt/kutt/.mediamtx-version
  rm -rf "$T"
  MTX_CHANGED=1
  echo "installed"
fi
if ! cmp -s "$D/ops/mediamtx.yml" /opt/kutt/mediamtx.yml; then
  install -m 644 "$D/ops/mediamtx.yml" /opt/kutt/mediamtx.yml
  MTX_CHANGED=1
  echo "config updated"
fi

echo "== watermark"
# Never overwrite an existing one: on a restored/older box it's the original
# artwork, and the repo copy is only a rebuild of it.
if [ ! -f /opt/kutt/logos/kutt-watermark.png ]; then
  install -m 644 "$D/ops/kutt-watermark.png" /opt/kutt/logos/kutt-watermark.png
  echo "installed"
fi

echo "== systemd units"
install -m 644 "$D/ops/mediamtx.service" /etc/systemd/system/mediamtx.service
install -m 644 "$D/ops/kutt-api.service" /etc/systemd/system/kutt-api.service
systemctl daemon-reload
systemctl enable mediamtx kutt-api 2>/dev/null
if [ -n "$MTX_CHANGED" ] || ! systemctl is-active --quiet mediamtx; then
  systemctl restart mediamtx
  echo "mediamtx (re)started"
fi

echo "== nginx"
# Once certbot has added the TLS lines, the live vhost is certbot's — leave it.
if ! grep -q 'managed by Certbot' /etc/nginx/sites-available/kutt 2>/dev/null; then
  install -m 644 "$D/ops/nginx-kutt.conf" /etc/nginx/sites-available/kutt
  echo "vhost installed"
else
  echo "vhost has certbot TLS lines — left as is"
fi
ln -sf /etc/nginx/sites-available/kutt /etc/nginx/sites-enabled/kutt
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx 2>/dev/null
systemctl reload nginx 2>/dev/null || systemctl restart nginx

echo "== bootstrap done"
