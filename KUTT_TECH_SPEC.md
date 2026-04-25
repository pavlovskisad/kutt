# KUTT Technical Specification

**Version:** 1.0 (Current) + Stages 2-4 (Roadmap)
**Last Updated:** 2026-04-25
**Product:** Live Replay Camera System for Sports Venues
**Current Deployment:** Kyiv United Table Tennis (kutt.cam)

---

## 1. CURRENT VERSION (v1.0)

### 1.1 System Architecture

```
[Camera (OBS on Lenovo monoblock at club)]
         |
         | RTMP push (port 1935)
         v
[MediaMTX on Hetzner VPS]
         |-- RTMP :1935 (ingest)
         |-- HLS  :8888 (LL-HLS, in-memory, 30min rolling buffer)
         |       |-- /table2/index.m3u8   (master playlist)
         |       |-- /table2/stream.m3u8  (media playlist)
         v
[Node.js API :3333]
         |-- Express (clip cutting, filmstrip, feed, likes)
         |-- ffmpeg (encoding, thumbnails, filmstrips)
         |-- Filesystem (clips on disk, filmstrips in /tmp)
         v
[nginx :80/:443]
         |-- TLS (Let's Encrypt)
         |-- Static frontend (/var/www/html/index.html)
         |-- Reverse proxy: /api/* -> :3333, /hls/* -> :8888
         v
[Browser (vanilla JS + hls.js)]
```

### 1.2 Infrastructure

- Server: Hetzner VPS 77.42.76.62, Ubuntu 24.04
- Domains: kutt.cam (primary), kutt.online (redirects)

| Port | Service | Purpose |
|------|---------|---------|
| 1935 | MediaMTX | RTMP ingest |
| 8888 | MediaMTX | HLS output (internal) |
| 3333 | Node API | Clip API (internal) |
| 80/443 | nginx | HTTP/HTTPS |

### 1.3 File Paths

```
/opt/kutt/api/server.js
/opt/kutt/clips/
/opt/kutt/clips/thumbs/
/opt/kutt/logos/kutt-watermark.png
/opt/kutt/mediamtx
/opt/kutt/mediamtx.yml
/var/www/html/index.html
/etc/nginx/sites-available/kutt
/tmp/kutt-filmstrips/
```

### 1.4 Media Pipeline

Clip extraction:
```
ffmpeg -sseof -<startSecondsAgo> -i stream.m3u8 -i watermark.png
  -t <duration> -filter_complex overlay=W-w-20:14
  -c:v libx264 -preset fast -crf 23
  -c:a aac -b:a 128k -movflags +faststart
```
- Must use stream.m3u8 (not index.m3u8) for -sseof
- Duration: 1-1800s, Timeout: max(120s, duration*8s)

Thumbnails:
```
ffmpeg -i clip.mp4 -t 3 -vf scale=240:-1,fps=8
  -c:v libwebp -q:v 50 -loop 0
```

Filmstrips:
```
ffmpeg -sseof -<zoom> -i stream.m3u8
  -vf fps=<10/zoom>,scale=-1:80,tile=10x1
  -frames:v 1 -q:v 4
```

### 1.5 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Status check |
| GET | /api/clips?limit=&offset= | Paginated clip list |
| POST | /api/clip | Create clip {startSecondsAgo, endSecondsAgo} |
| GET | /api/filmstrip?seconds= | Timeline sprite sheet |
| POST | /api/like/:clipId | Toggle like |
| GET | /api/likes/:clipId | Like count |
| GET | /api/buffer-info | Buffer status |

### 1.6 Frontend

- Single index.html, vanilla JS, hls.js from CDN
- Two tabs: STREAM (blue bg) and REPLAY STATION (yellow bg)
- Two video elements: #vid (live), #vidR (replay)
- Clip bounds as absolute seconds-ago (sAgo/eAgo)
- Dynamic presets by zoom level
- Brand: Yellow #FFE135, Blue #1A8FCC
- Fonts: Space Grotesk, JetBrains Mono

### 1.7 Known Limitations

1. Likes in-memory only (lost on restart)
2. No clip auto-delete (disk fills)
3. No auth/user accounts
4. Single venue, single camera
5. 30m filmstrip slow (~120s)
6. No monitoring
7. Base64 logos in HTML (~150KB)

---

## 2. STAGE 2 -- Multi-Venue + User Accounts

### 2.1 Database (PostgreSQL)

```sql
venues (id, slug, name, city, country, timezone, stream_key,
        hls_path, mediamtx_host, buffer_seconds)

cameras (id, venue_id, slug, label, stream_path, is_active)

users (id, email, display_name, avatar_url,
       oauth_provider, oauth_id, home_venue_id)

sessions (id, user_id, token_hash, expires_at)

clips (id, venue_id, camera_id, user_id, filename,
       storage_url, thumb_url, duration, size_bytes)

likes (clip_id, user_id, ip_address)

venue_admins (venue_id, user_id, role)
```

### 2.2 Auth

- Passport.js + OAuth 2.0
- Providers: Google, Apple, Instagram
- JWT in HttpOnly cookies (RS256, 7-day expiry)
- Auth optional -- anonymous still works

### 2.3 Multi-Tenancy

- URLs: kutt.cam/<venue-slug>
- API: /api/v2/venues/:slug/clips
- Storage: Cloudflare R2 (zero egress)
- MediaMTX: multiple stream paths per VPS

### 2.4 New Endpoints

```
GET  /api/v2/venues
GET  /api/v2/venues/:slug
GET  /api/v2/venues/:slug/clips
POST /api/v2/venues/:slug/clip
GET  /api/v2/me/clips
GET  /api/auth/google[/callback]
GET  /api/auth/apple[/callback]
POST /api/auth/logout
GET  /api/auth/me
```

---

## 3. STAGE 3 -- Social + Mobile

### 3.1 Social Features

```sql
comments (id, clip_id, user_id, body, created_at)
follows (follower_id, followed_id)
```

- Highlights feed: /api/v2/feed?type=trending|following|venue
- Ranking: likes*3 + comments*2 + views*0.5 + recency_bonus

### 3.2 Mobile App

- React Native + Expo
- Same API backend
- Screens: Home, Venue, Replay Station, My Clips, Profile

### 3.3 Push Notifications

- Firebase (Android) + APNs (iOS) via Expo Push
- Triggers: likes, comments, venue live, weekly digest
- Max 10/user/hour

### 3.4 CDN

- Clips: ffmpeg -> R2 -> Cloudflare CDN (cache 1yr)
- HLS: keep direct nginx for now

### 3.5 Analytics

- PostHog or Plausible (frontend)
- Prometheus + Grafana (backend)

---

## 4. STAGE 4 -- KUTT TV Network

### 4.1 Multi-Camera

- 2-8 cameras per venue
- Camera selector with live thumbnails
- Independent filmstrip cache per camera

### 4.2 Live Chat

- Socket.IO + Redis adapter
- One room per venue
- Rate: 1 msg/2s/user
- Profanity filter

### 4.3 Monetization

| Plan | Price | Features |
|------|-------|----------|
| Venue Free | $0 | 1 cam, 100 clips/mo, watermark |
| Venue Pro | $49/mo | 4 cams, unlimited, custom watermark |
| Venue Enterprise | $149/mo | 8 cams, API, white-label |
| User Premium | $2.99/mo | 1080p, no watermark, 60min buffer |

Stripe + Stripe Connect for venue payouts.

### 4.4 Events/Tournaments

```sql
events (id, venue_id, name, starts_at, ends_at, is_live)
event_clips (event_id, clip_id, sort_order, label)
```

Auto-tag clips during event window. Curated highlight reels.

### 4.5 Moderation

- NSFW detection on clip creation
- Chat profanity filter
- Report system (clips, comments, users)
- Roles: venue mod, global mod
- GDPR: /api/v2/me/delete

### 4.6 Admin Dashboards

- Venue admin: stream status, clips, moderation, events, analytics
- Global admin: venues, users, revenue, infrastructure, content

---

## Technology by Stage

| Layer | v1.0 | Stage 2 | Stage 3 | Stage 4 |
|-------|------|---------|---------|---------|
| Frontend | Vanilla JS | + Router | React Native | React admin |
| API | Express | + Passport | + Socket.IO | + Bull queues |
| Database | None | PostgreSQL | Same | Same |
| Storage | Disk | R2 | Same | Same |
| CDN | None | Cloudflare | + Push | + Workers |
| Auth | None | OAuth | Same | + Roles |
| Payments | None | None | None | Stripe |
| Deploy | scp | GH Actions | Same | K8s |
