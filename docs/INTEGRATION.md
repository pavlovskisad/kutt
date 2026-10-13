# KUTT — System Description & Integration Spec

For partners building on top of KUTT (tournament service, scoring, refereeing).
Status labels: **LIVE** = running in production today · **PROPOSED** = not built yet, the shape we'd suggest.

---

## 1. What KUTT is

KUTT (kutt.cam) is a live replay camera system for table tennis clubs. A fixed camera streams a table to the web; the last **30 minutes are always buffered**, so any player can open the app on their phone, scrub back to a rally they just played, cut a clip (1 s – 30 min) and share it. Clips land in a public feed.

Today: one club (KUTT, Kudriavka, Kyiv), one camera, one table (`table2`). Multi-table / multi-venue channels are the next stage.

## 2. Architecture

```
[Camera + OBS at the club]
      │ RTMP push (720p, 4:3, 30 fps, 2.5 Mbps, keyframe every 2 s)
      ▼
[MediaMTX]  ── holds a 30-min rolling HLS buffer in RAM (900 × 2 s segments)
      │
      ▼
[Node/Express API]  ── cuts clips (ffmpeg, x264, watermark), filmstrips, motion scoring
      │
      ▼
[nginx + TLS]  ── kutt.cam: static frontend, /api, /hls, /clips, /thumbs
      │
      ▼
[Browser]  ── vanilla JS + hls.js, no app install
```

Single Hetzner VPS (2 vCPU AMD EPYC, 4 GB RAM, 75 GB SSD). Deploys are automatic on push to `main`.

**Capacity, measured:** RAM is not the limit (whole streaming stack ≈ 120 MB). CPU is — clip encoding costs ~0.5–1 s of CPU per second of clip, and each channel's background frame sampler ~25% of a core. Comfortable for 2–3 channels on this box; beyond that we size up.

## 3. What you can use today (LIVE)

All endpoints are public, no auth, CORS open. Base URL `https://kutt.cam`.

### Live stream
| | |
|---|---|
| `GET /hls/table2/index.m3u8` | HLS master playlist (play with hls.js / native Safari). 404 while the camera is off. |

Latency behind real life: ~5–15 s (standard HLS).

### Clips
| | |
|---|---|
| `GET /api/clips?limit=42&offset=0` | Feed, newest first. |
| `POST /api/clip` | Cut a clip from the buffer. |
| `GET /clips/<filename>.mp4` | Download (H.264/AAC mp4, watermarked). |
| `GET /thumbs/<id>.webp` | Animated preview, 240 px, first 3 s. |

`GET /api/clips` returns:
```json
{ "clips": [ { "id": "kutt_2026-10-12_17-39-27_121s",
               "filename": "kutt_2026-10-12_17-39-27_121s.mp4",
               "url": "/clips/…mp4", "thumb": "/thumbs/…webp",
               "duration": 121, "sizeMB": "7.2",
               "createdAt": 1791814767000, "ago": "1d ago" } ],
  "total": 45, "offset": 0, "limit": 42 }
```

`POST /api/clip` body — **times are relative, in seconds before "now" on the server**:
```json
{ "startSecondsAgo": 40, "endSecondsAgo": 10 }   // cuts a 30 s clip
```
Response: `{ "url", "thumb", "filename", "duration", "sizeMB" }`. The request blocks until encoding finishes (≈ duration × 0.5–1 s).
Limits: duration 1–1800 s · start must still be inside the 30-min buffer · **1 clip per IP per 10 s** (429 otherwise).

### Timeline helpers
| | |
|---|---|
| `GET /api/filmstrip?seconds=60\|120\|300\|1800` | JPEG strip of 10 frames across the window. |
| `GET /api/activity?seconds=N` | Motion score per frame sample (one every ~6 s): `{ points: [{ ago, score }], max }`. Higher = more movement. Separates "play" from "empty table"; not point-level. |
| `GET /api/buffer-info` | Health: is the camera live, how much history is buffered. |

## 4. Integration with a tournament service (PROPOSED)

The natural split: **your service owns the match** (players, draw, schedule, score — the source of truth). **KUTT owns the video** (stream, buffer, clips). The glue is time.

### 4.1 What we'd build on our side

1. **Absolute-time clip API.** Relative "seconds ago" is awkward server-to-server. Add:
   ```json
   POST /api/clip  { "startAt": 1791814700000, "endAt": 1791814730000, "tag": {…} }
   ```
   epoch-ms, server clock (we'd expose `GET /api/time` so you can correct for skew).
2. **API key for partners** — exempt from the per-IP rate limit, required for tagging.
3. **Clip tags** — attach `{ matchId, tournamentId, players, set, score }` to a clip, filterable in `GET /api/clips?matchId=…`.
4. **Channel ids** — `table2` today; with multi-table, every endpoint takes a channel (`/api/<channel>/…`, `/hls/<channel>/…`). Your match record would store which channel/table it's on.

### 4.2 What we'd need from you

- **Match start / end events** with timestamps (and table/channel). → We can auto-cut the full match (up to 30 min per clip today; longer matches split into parts) and tag it.
- **Point events** — `{ matchId, at: epochMs, winner, score }` per point, sent to a webhook on our side. → We auto-cut every point (e.g. 8 s before → 2 s after), and mark points on the Replay Station timeline so players jump straight to them.

### 4.3 Flow
```
Tournament app            KUTT
 match.start  ───────────►  remember window + channel
 point(at, winner) ──────►  cut [at-8s, at+2s], tag, mark on timeline
 match.end    ───────────►  cut full match, tag, link from tournament page
              ◄───────────  clip URLs (webhook or GET /api/clips?matchId=)
```

## 5. Automatic point detection / "referee" — honest assessment

**Reliable today: humans score, KUTT provides evidence.** Scoring in your app (umpire tablet or players' phones) as the source of truth; KUTT clips every point so any dispute is settled by replay. This is cheap, accurate, and the integration above delivers it.

**Fully automatic win/lose detection is hard with the current setup:**
- **Camera:** one fixed overhead-ish view at 720p/30 fps. The ball at match speed (60–100+ km/h) is a few motion-blurred pixels per frame and often skipped between frames. Edge balls and nets are not decidable from this view.
- **Compute:** ball tracking needs a model per frame, ideally GPU. Our VPS is CPU-only.

**What it would take, in rising cost:**
1. *Rally segmentation (feasible soon):* detect when a rally starts/stops from motion + sound (bounce acoustics are very distinctive). Gives "a point happened here" without who won — useful to pre-mark points for a human to confirm in one tap.
2. *Who won the point (hard):* side-on camera at net height, ≥ 60 fps (120 better), a small ball-tracking model (TTNet-style) on a GPU box at the venue. Scoring then follows rules from ball trajectory + bounce detection. Expect a research-grade project and manual override for edge cases.
3. *Hybrid (recommended):* automatic proposal ("point to player A?") + one-tap confirmation by umpire/players. Gets most of the speed of automation with human accuracy.

## 6. Constraints & conventions

- Video: 4:3, 720p, H.264. Buffer 30 min — anything older is gone unless clipped.
- Time: server clock is authoritative; client players lag the live edge by 5–15 s.
- Privacy: players are filmed in a private club; consent via club rules/signage. Clips are currently public — a private-by-default mode is planned and relevant if tournaments include minors or guests.
- Brand: yellow `#FFE135`, blue `#1A8FCC`, font ABC Diatype.

## 7. Contacts / next step

Suggested first step: agree on the event format in 4.2 (match start/end + point events with epoch-ms timestamps and table id). Once that's fixed, the KUTT side (absolute-time clips, tags, API key, webhook) is a few days of work.
