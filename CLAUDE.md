# KUTT — Context for Claude Code

This is a live replay camera system for Kyiv United Table Tennis (kutt.online). Camera streams live to the site via RTMP→HLS with a 30-minute rolling buffer. Players scan a QR code on their phone, visit REPLAY STATION, scrub a filmstrip timeline to find their rally, and save the clip. Anonymous likes, public feed.

This file is the handoff from a chat-based Claude session that built most of the current implementation. Read it end-to-end before making changes — there's important infrastructure knowledge here that isn't obvious from the code.

## Architecture at a glance

```
[Camera (OBS/Lenovo monoblock at club)]
         │ RTMP push
         ▼
[MediaMTX on Hetzner VPS]  ── serves HLS from memory (no disk)
         │
         ├─ RTMP :1935
         └─ HLS  :8888  (LL-HLS, 30min buffer, master=index.m3u8, media=stream.m3u8)
                  │
                  ▼
         [Node API :3333]  ── clip cutting, feed, filmstrip
                  │
                  ▼
         [nginx :443]  ── TLS, static frontend, reverse proxy to :3333 and :8888
                  │
                  ▼
         [Browser]  ── index.html (single file, vanilla JS + hls.js)
```

Server: Hetzner VPS `77.42.76.62`, Ubuntu 24.04, domain `kutt.online`.
SSH: `root@77.42.76.62` (password auth — user is beginner at server admin, prefer full-file `scp` over `sed` edits).

## Key paths on the VPS

```
/opt/kutt/api/server.js           # Node API
/opt/kutt/clips/                  # saved mp4 clips
/opt/kutt/clips/thumbs/           # animated webp thumbnails
/opt/kutt/logos/kutt-watermark.png # burned into clips
/opt/kutt/mediamtx                # MediaMTX binary
/opt/kutt/mediamtx.yml            # MediaMTX config
/var/www/html/index.html          # frontend (will move to Netlify)
/etc/nginx/sites-available/kutt   # nginx vhost
/etc/systemd/system/kutt-api.service
/etc/systemd/system/mediamtx.service
/tmp/kutt-filmstrips/             # ffmpeg filmstrip cache (ephemeral)
```

## MediaMTX / HLS quirks (learned the hard way)

- **MediaMTX serves HLS purely from memory.** There is no `/opt/kutt/hls/` directory on disk. Segments live in RAM and are served over HTTP at `http://127.0.0.1:8888/table2/`.
- **There are two playlists**: `index.m3u8` (master) and `stream.m3u8` (media playlist). For ffmpeg direct reads with `-sseof`, you MUST use the inner `stream.m3u8` — `-sseof` on the master playlist silently fails or behaves weirdly.
- **`-sseof` is reliable for clip extraction** but slow for filmstrip frame sampling because ffmpeg downloads segments sequentially. Generating a 10-frame filmstrip from 60s of HLS takes ~40 seconds on this VPS. This is why filmstrips are cached and pre-warmed on startup (see `server.js`).
- **fMP4 warnings are normal**: you'll see `Found duplicated MOOV Atom. Skipped it` in ffmpeg stderr — harmless.

## The frontend in one paragraph

Single file `index.html`, vanilla JS, `hls.js` from CDN. Two tabs: **STREAM** (live feed + scrollable grid of past clips) and **REPLAY STATION** (filmstrip timeline editor). Two `<video>` elements: `#vid` for the live stream, `#vidR` for replay preview — they're stacked in the same container and toggled via `display`. The live HLS instance stays alive across tab switches; the replay HLS instance is created on entering REPLAY STATION and destroyed on leaving (prevents shared-element freezing bugs we had in v1). Clip bounds are stored as **absolute seconds-ago-from-live** (`sAgo`, `eAgo`), not as percentages of the zoom window — this means zoom in/out doesn't move the clip. Timeline background is a filmstrip JPEG fetched from `/api/filmstrip?seconds=<zoom>`. Handles: left handle, right handle, middle drag-whole-clip. Scrubbing any handle seeks `#vidR` to that position so the video area shows a frozen preview frame. Play button loops the selection on `#vidR` via `setInterval` checking `currentTime`.

## The backend in one paragraph

Express app on port 3333. Endpoints: `GET /api/clips?limit&offset` (paginated clip list), `POST /api/clip {startSecondsAgo, endSecondsAgo}` (cuts a new clip with ffmpeg + burns watermark), `GET /api/filmstrip?seconds=<zoom>` (returns cached JPEG sprite sheet of video frames), `POST /api/like/:id` (per-IP toggle likes, in-memory only — lost on restart, TODO persist), `GET /health`, `GET /api/buffer-info`. Clips are never auto-deleted (disk will fill eventually — TODO migrate to object storage). Thumbnails are animated webp, full clip length, 360px wide, 12fps, quality 75 — generated on clip creation and backfilled for existing clips on startup via `generateMissingThumbs()`. Rate limit: one clip per IP per 10 seconds. The filmstrip cache is per-zoom (`60`, `120`, `300`, `1800`) stored under `/tmp/kutt-filmstrips/strip_<zoom>.jpg`; requests serve cached files instantly and trigger async regeneration if >10s stale; on startup all four zoom levels are pre-warmed sequentially (~3 minutes total); the `60` cache is also refreshed every 15s via a timer.

## Deployment workflow

**Frontend**: currently served from `/var/www/html/index.html` on the VPS via nginx. Moving to Netlify — see `netlify.toml` which proxies `/api/*`, `/clips/*`, `/thumbs/*`, `/hls/*` back to the VPS so the frontend keeps using same-origin relative URLs.

**Backend**: manual scp for now. User's preferred workflow:
```bash
scp server/server.js root@77.42.76.62:/opt/kutt/api/server.js
ssh root@77.42.76.62 "systemctl restart kutt-api"
```
nginx reload when editing vhost:
```bash
scp docs/nginx-kutt.conf root@77.42.76.62:/etc/nginx/sites-available/kutt
ssh root@77.42.76.62 "nginx -t && systemctl reload nginx"
```

**CI/CD wishlist**: GitHub Action that deploys `server/server.js` to VPS on push to main. Secrets: VPS SSH key. Not yet set up.

## Workflow notes from prior sessions

- **User is on macOS.** Their zsh treats `!` as history expansion — avoid `!` in SSH commands or quote carefully.
- **Avoid `sed` edits on the server via SSH.** Past attempts repeatedly corrupted files due to escaping issues with quotes, special chars, and multi-step pipelines in zsh. Full-file `scp` is the reliable path.
- **User is a designer/builder, not a sysadmin.** Give exact copy-pasteable commands. Explain *why* alongside *what*. Prefer one-shot commands that deploy + test + show logs over multi-step sequences.
- **User appreciates architectural discussion before code on big changes.** For patches, just ship the fix.

## Known issues / TODO

- **Likes are in-memory only** — reset on API restart. Move to SQLite or JSON file.
- **Clips never auto-delete** — disk will fill. Need retention policy or object storage migration (R2/B2).
- **No auth / user accounts** — anonymous only. Wishlist: Google/Instagram OAuth login for per-user clip history.
- **30m zoom filmstrip is slow** — warming on startup may hit the 120s timeout. May need a different strategy (background frame extractor that dumps one frame every N seconds to disk continuously, then composites on demand).
- **GoPro Hero 5 Session can't stream** — currently using a Lenovo monoblock at the club with OBS. Need a USB webcam long-term.
- **Multi-club support** (\"KUTT TV\" network of venues) — future.
- **Frontend has big embedded base64 logos** in `index.html` — could be extracted to real files but works fine inline.

## File inventory

```
├── index.html              # frontend, single file, deploys to Netlify
├── netlify.toml            # Netlify config + proxy redirects to VPS API
├── README.md               # brief public-facing readme
├── CLAUDE.md               # this file
├── .gitignore
└── server/
    ├── server.js           # Node API (Express)
    ├── package.json        # deps: express, cors
    ├── kutt-api.service    # systemd unit reference
    ├── nginx-kutt.conf     # nginx vhost reference
    └── deploy.sh           # shortcut deploy script
```

## Brand constants

- Yellow `#FFE135`, Blue `#1A8FCC`
- Fonts: Space Grotesk (display), JetBrains Mono (body)
- STREAM tab = blue background, yellow accents. REPLAY STATION = inverted.

## Starting point for your session

The current code in this repo reflects the end state of the chat session that built the Replay Station rebuild. Everything should be working. When you start, a good first move is to verify the live deployment matches the repo:

```bash
ssh root@77.42.76.62 "diff <(cat /opt/kutt/api/server.js) <(curl -s https://raw.githubusercontent.com/<user>/<repo>/main/server/server.js) | head -20"
```

Or just redeploy to be sure. Then ask the user what they want to build next.
