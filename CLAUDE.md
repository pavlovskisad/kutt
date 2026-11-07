# KUTT — Context for Claude Code

This is a live replay camera system for Kyiv United Table Tennis (kutt.cam). Camera streams live to the site via RTMP→HLS with a 30-minute rolling buffer. Players scan a QR code on their phone, visit REPLAY STATION, scrub a filmstrip timeline to find their rally, and save the clip. Anonymous likes, public feed.

This file is the handoff from a chat-based Claude session that built most of the current implementation. Read it end-to-end before making changes — there's important infrastructure knowledge here that isn't obvious from the code.

## Architecture at a glance

```
[Camera (OBS/Lenovo monoblock at club)]
         │ RTMP push
         ▼
[MediaMTX on Hetzner VPS]  ── serves HLS from memory (no disk)
         │
         ├─ RTMP :1935
         └─ HLS  :8888  (LL-HLS, 30min buffer, master=index.m3u8 → media playlist(s))
                  │
                  ▼
         [Node API :3333]  ── clip cutting, feed, filmstrip
                  │
                  ▼
         [nginx :443]  ── TLS, static frontend, reverse proxy to :3333 and :8888
                  │
                  ▼
         [Browser]  ── app.html (single file, vanilla JS + hls.js)
```

Server: Hetzner VPS, Ubuntu 24.04 — its IP lives in **`ops/host`** (one line; every workflow reads it). Domain `kutt.cam` (kutt.online redirects there).
The whole server is reproducible from this repo: `ops/` holds MediaMTX config, systemd units, nginx vhost, watermark and `bootstrap.sh`. (History: the first VPS, 77.42.76.62, was deleted by Hetzner in Nov 2026 over missed billing notices — every clip on it was lost. That's why the box is now rebuilt by script, not by hand.)

## Key paths on the VPS

```
/opt/kutt/api/server.js           # Node API
/opt/kutt/clips/                  # saved mp4 clips
/opt/kutt/clips/thumbs/           # animated webp thumbnails
/opt/kutt/logos/kutt-watermark.png # burned into clips
/opt/kutt/mediamtx                # MediaMTX binary
/opt/kutt/mediamtx.yml            # MediaMTX config
/var/www/html/index.html          # onboarding landing (repo: index.html)
/var/www/html/app/index.html      # the app (repo: app.html), served at /app/
/var/www/html/overview.html       # product deck
/etc/nginx/sites-available/kutt   # nginx vhost
/etc/systemd/system/kutt-api.service
/etc/systemd/system/mediamtx.service
/tmp/kutt-filmstrips/             # ffmpeg filmstrip cache (ephemeral)
```

## MediaMTX / HLS quirks (learned the hard way)

- **MediaMTX serves HLS purely from memory.** There is no `/opt/kutt/hls/` directory on disk. Segments live in RAM and are served over HTTP at `http://127.0.0.1:8888/table2/`.
- **Media playlist names depend on the MediaMTX version.** Old builds: `index.m3u8` → `stream.m3u8` (muxed). v1.15.3 (pinned in `ops/bootstrap.sh`): `index.m3u8` → `video1_stream.m3u8` + `audio2_stream.m3u8` (separate renditions). `server.js` resolves them from the master (`resolveStream()`), never hardcode one.
- **ffmpeg cannot seek a live HLS playlist.** `-sseof` needs a known duration and live HLS has none: ffmpeg logs `Cannot use -sseof, file duration not known` and silently starts near the live edge instead. Verified with ffmpeg 6.1.1 (Ubuntu 24.04). What works: `server.js` `locate()` parses the media playlist, finds the segment holding the moment, starts ffmpeg there with `-live_start_index <negative>`, and trims the rest with an output-side `-ss`. Tested to the second against a wall-clock-stamped stream. "Seconds ago" is measured from the playlist end incl. LL-HLS parts — the same point the player's buffered end sits at.
- Reading backwards through the buffer still costs ~0.7s per second of footage (segments are fetched sequentially), which is why filmstrips come from the frame ring, not from reading the window.
- **fMP4 warnings are normal**: you'll see `Found duplicated MOOV Atom. Skipped it` in ffmpeg stderr — harmless.

## URL map

| URL | File (repo) | What |
|---|---|---|
| `kutt.cam/` | `index.html` | Onboarding landing — first-person rally: tap → ball flies into the screen, impact splat-reveals the next content beat (6 beats, UA default + EN toggle via `data-uk`/`data-en`, lang persisted in `localStorage.kutt_lang`). CTAs → `/app/`. Canvas 2D engine, zero deps. `prefers-reduced-motion`/no-JS → static stacked page. |
| `kutt.cam/app/` | `app.html` | The app (STREAM + REPLAY STATION). Served from `/var/www/html/app/index.html` — no nginx change needed (`try_files $uri $uri/`). Its "?" header button links back to `/`. |
| `kutt.cam/overview.html` | `overview.html` | Product/investor deck. |

QR codes point at `kutt.cam/` → new players get onboarding first, by design.

## The app in one paragraph

Single file `app.html`, vanilla JS, `hls.js` from CDN. Two tabs: **STREAM** (live feed + scrollable grid of past clips) and **REPLAY STATION** (filmstrip timeline editor). Two `<video>` elements: `#vid` for the live stream, `#vidR` for replay preview — they're stacked in the same container and toggled via `display`. The live HLS instance stays alive across tab switches; the replay HLS instance is created on entering REPLAY STATION and destroyed on leaving (prevents shared-element freezing bugs we had in v1). Clip bounds are stored as **absolute seconds-ago-from-live** (`sAgo`, `eAgo`), not as percentages of the zoom window — this means zoom in/out doesn't move the clip. Timeline background is a filmstrip JPEG fetched from `/api/filmstrip?seconds=<zoom>`. Handles: left handle, right handle, middle drag-whole-clip. Scrubbing any handle seeks `#vidR` to that position so the video area shows a frozen preview frame. Play button loops the selection on `#vidR` via `setInterval` checking `currentTime`.

## The backend in one paragraph

Express app on port 3333. Endpoints: `GET /api/clips?limit&offset` (paginated clip list), `POST /api/clip {startSecondsAgo, endSecondsAgo}` (cuts a new clip with ffmpeg + burns watermark), `GET /api/filmstrip?seconds=<zoom>` (returns cached JPEG sprite sheet of video frames), `POST /api/like/:id` (per-IP toggle likes, in-memory only — lost on restart, TODO persist), `GET /health`, `GET /api/buffer-info` (ring size/span, frame freshness, per-zoom cache status — the first place to look when Replay Station misbehaves), `GET /api/activity?seconds=<zoom>` (motion score per ring frame, drawn as marks under the timeline so players can see where the action was instead of scrubbing blind — scored by blending consecutive ring frames in difference mode and area-scaling to one grey pixel, so a single stdout byte is the mean change). Clips are never auto-deleted (disk will fill eventually — TODO migrate to object storage). Thumbnails are animated webp, full clip length, 360px wide, 12fps, quality 75 — generated on clip creation and backfilled for existing clips on startup via `generateMissingThumbs()`. Rate limit: one clip per IP per 10 seconds. The filmstrip cache is per-zoom (`60`, `120`, `300`, `1800`) stored under `/tmp/kutt-filmstrips/strip_<zoom>.jpg`; requests serve cached files instantly and trigger async regeneration if >10s stale; on startup all four levels are warmed sequentially; the `60` cache is refreshed every 15s, and a self-heal timer retries any level that has no cache (with a 10-minute backoff after a failure) so an outage at boot can't leave a zoom broken until someone restarts the API.

**Filmstrips come from a frame ring:** reading a whole window costs ~0.7s per second of footage, so `300`/`1800` could never finish inside any timeout — they used to 504 forever. So a **frame ring** runs continuously: one cheap grab from the *live edge* (first frame of the newest complete segment, file named by the moment it shows) every 6s, kept ~33 min in `/tmp/kutt-filmstrips/ring/<epoch_ms>.jpg`. All strips composite (a sequential read is only the fallback for ≤120s while the ring has <3 frames), taking 10 nearest-time frames from the ring with `hstack` — flat cost no matter how far back they reach. A half-filled ring still renders (frames repeat, then spread out as history builds). Two gotchas when touching this: the ring only fills while the camera is live, and any ffmpeg writing to the `.tmp` output **must** pass `-f image2` (the extension can't be inferred).

## Deployment workflow

**Everything is self-hosted on the VPS and deploys automatically.** Push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) reads the IP from `ops/host` (empty = no server, deploy skipped), uploads, and runs `.github/scripts/remote-deploy.sh` on the box, which:
1. runs `ops/bootstrap.sh` if the server is brand new or anything in `ops/` changed (hash in `/opt/kutt/.ops-hash`) — apt packages, 2G swap, pinned MediaMTX with sha256 check, configs, systemd units, nginx vhost. Idempotent; MediaMTX restarts only if its binary/config changed (a restart drops the buffer);
2. installs the frontend; installs `server.js` (+ `npm install` when `package.json` changed) and restarts `kutt-api` **only if they changed** (a restart re-warms filmstrip caches);
3. gets/extends the Let's Encrypt cert for whichever of kutt.cam / kutt.online already resolve to the box (certbot `--register-unsafely-without-email`; never send the user's email). Deploys retry until DNS catches up.
Health check: the API on the box (`curl 127.0.0.1:3333/api/buffer-info` over SSH, fatal) + public `https://kutt.cam` (warning only).

**Moving to a new server** (what we did after the Hetzner deletion): user adds the deploy public key in Hetzner (run the **Show deploy public key** workflow to print it), creates Ubuntu 24.04 with that key, sends the IP → write it to `ops/host`, push → the deploy provisions everything. User points GoDaddy A records (kutt.cam, kutt.online) at it; re-run the deploy (workflow_dispatch) once DNS resolves to get TLS. OBS needs no change if it publishes to `rtmp://kutt.cam/` key `table2`.

- Auth: repo secret `VPS_SSH_KEY` = base64 (single line) of a dedicated ed25519 private key; its public half goes into the server's authorized_keys via Hetzner's SSH-key picker at creation.
- Other workflows: **Delete clips** (manual, validated ids), **Show deploy public key**.
- Deploy status: repo → Actions tab, or via GitHub MCP tools (`actions_list`, `get_job_logs`) from a Claude session.
- **nginx after TLS:** certbot edits the live vhost in place (`# managed by Certbot` lines). `bootstrap.sh` only writes `ops/nginx-kutt.conf` while those lines are absent, so later edits to the repo copy do NOT reach a live box — change them carefully on the server (`nginx -t && systemctl reload nginx`) or mirror the edit by hand.
- The `netlify.toml` is a leftover from an abandoned Netlify idea — nothing uses it.

## Workflow notes from prior sessions

- **User works mostly from their phone** (Claude Code cloud sessions + Termius for SSH, claude.ai app). Do NOT propose Mac-terminal workflows; the deploy pipeline exists precisely so the user never needs a terminal. When a manual VPS step is unavoidable, give a single copy-pasteable command for Termius.
- **Claude's sandbox cannot SSH to the VPS** (port 22 blocked) — but outbound HTTPS works, so `curl https://kutt.cam/...` is available for verifying deploys.
- **Termius pastes fine; Blink mangles URLs** (wraps them in `<>`). The user's Mac zsh treats `!` as history expansion — avoid `!` inside double quotes in any command you hand over.
- **`.github/scripts/remote-deploy.sh` arrives on stdin** (`ssh 'bash -s' < script`), so any command in it that reads stdin — ffmpeg especially — swallows the rest of the script and the deploy dies with a bogus `exit 127`. Always add `</dev/null`.
- **Avoid multi-step `sed` pipelines on the server.** Past attempts corrupted files due to quote/escaping issues. Full-file deploys via the pipeline are the reliable path; simple single `sed` in single quotes is OK for emergencies.
- **User is a designer/builder, not a sysadmin.** Give exact copy-pasteable commands. Explain *why* alongside *what*. Prefer one-shot commands that deploy + test + show logs over multi-step sequences.
- **User appreciates architectural discussion before code on big changes.** For patches, just ship the fix.

## Known issues / TODO

- **Likes are in-memory only** — reset on API restart. Move to SQLite or JSON file.
- **Clips never auto-delete** — disk will fill. Need retention policy or object storage migration (R2/B2).
- **No auth / user accounts** — anonymous only. Wishlist: Google/Instagram OAuth login for per-user clip history.
- **GoPro Hero 5 Session can't stream** — currently using a Lenovo monoblock at the club with OBS. Need a USB webcam long-term.
- **Multi-club support** (\"KUTT TV\" network of venues) — future.
- **Frontend has big embedded base64 logos** in `index.html` — could be extracted to real files but works fine inline.

## File inventory

```
├── index.html              # onboarding landing (first-person rally), auto-deploys to VPS
├── app.html                # the app, single file, auto-deploys to /app/ on VPS
├── overview.html           # product/investor deck
├── server.js               # Node API (Express), auto-deploys to VPS
├── package.json            # deps: express, cors
├── ops/
│   ├── host                # target server IP (one line; empty = no server)
│   ├── bootstrap.sh        # provisions a fresh Ubuntu 24.04 box (run by deploys)
│   ├── mediamtx.yml        # RTMP in, LL-HLS out, 900×2s buffer, path table2
│   ├── mediamtx.service    # systemd unit
│   ├── kutt-api.service    # systemd unit
│   ├── nginx-kutt.conf     # vhost, pre-certbot
│   └── kutt-watermark.png  # burned into clips (rebuilt from the app logo)
├── netlify.toml            # leftover, unused
├── KUTT_TECH_SPEC.md       # tech spec: v1.0 + stages 2-4 roadmap
├── README.md               # brief public-facing readme
├── CLAUDE.md               # this file
└── .github/
    ├── workflows/deploy.yml       # push to main → provision if needed → deploy
    ├── workflows/delete-clips.yml # manual: delete clips by id
    ├── workflows/deploy-key.yml   # manual: print deploy public key for Hetzner
    └── scripts/remote-deploy.sh   # install script that runs on the VPS
```

## Brand constants

- Yellow `#FFE135`, Blue `#1A8FCC`
- Font: **ABC Diatype Cyrillic** (Dinamo) throughout — self-hosted at `/fonts/diatype-{400,500,700,900}.woff2`, subset to latin+Cyrillic. Licensed commercial face: keep the source package OUT of this public repo, only the subset webfonts belong here. It has `tnum`, which is what keeps timeline/clip numbers from jittering now that there's no monospace. Display headlines use 900; it's a compact grotesque, so display sizes are larger than they were under Unbounded. `overview.html` still uses Google Fonts (Space Grotesk/JetBrains Mono).
- STREAM tab = blue background, yellow accents. REPLAY STATION = inverted.

## Starting point for your session

Check the box is alive and matches the repo: `curl -s https://kutt.cam/api/buffer-info` (ring + strip status), and the latest **Deploy to VPS** run's log (host report at the end: disk, clips, stream status). To force a resync, re-run the deploy workflow. Then ask the user what they want to build next.
