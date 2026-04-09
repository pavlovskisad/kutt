# KUTT

Live replay camera system for Kyiv United Table Tennis — kutt.online

Stream a ping pong table, let players scan a QR code and save their best rallies from the last 30 minutes.

## What's in here

- `index.html` — frontend (single file, vanilla JS + hls.js). Deployed via Netlify.
- `server/` — Node/Express API for clip cutting, filmstrip generation, and the public feed. Runs on a VPS behind nginx with MediaMTX handling RTMP ingest and HLS.
- `CLAUDE.md` — full project context, architecture notes, deployment workflow, and hard-won infrastructure lessons. Read this before making changes.

## Stack

- **Ingest**: OBS → MediaMTX (RTMP)
- **Delivery**: MediaMTX LL-HLS, 30-minute rolling buffer
- **API**: Node.js + Express + ffmpeg
- **Frontend**: Vanilla HTML/JS + hls.js
- **Infra**: Hetzner VPS, nginx, Let's Encrypt, systemd

## Deploy

Frontend auto-deploys via Netlify on push to main.
Backend: `./server/deploy.sh` (scp + systemctl restart).

See `CLAUDE.md` for the full story.
