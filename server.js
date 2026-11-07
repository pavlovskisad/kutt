const express = require('express');
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const app = express();
// Behind nginx: take the client IP from X-Forwarded-For (nginx sets it to
// $remote_addr), otherwise every player is 127.0.0.1 and shares one rate limit.
app.set('trust proxy', 'loopback');
app.use(cors());
app.use(express.json());
const CLIPS_DIR = '/opt/kutt/clips';
const LOGO_PATH = '/opt/kutt/logos/kutt-watermark.png';
const MASTER_URL = 'http://127.0.0.1:8888/table2/index.m3u8';
const PORT = 3333;

// ---- Finding a moment in the live HLS buffer ------------------------------
// ffmpeg can't seek a live playlist: `-sseof` needs a known duration, which a
// live HLS input never has ("Cannot use -sseof, file duration not known"), so
// ffmpeg silently starts near the live edge instead. What it does honour is
// `-live_start_index N` (start N segments from the end). So we read the media
// playlist ourselves, find the segment that holds the requested moment, start
// ffmpeg there, and trim the remainder with an output-side `-ss`.
// The media playlist name differs between MediaMTX versions (stream.m3u8 in
// old ones, video1_stream.m3u8 + audio2_stream.m3u8 in new ones), so it is
// resolved from the master playlist rather than hardcoded.
function fetchText(url, cb) {
  let finished = false;
  const done = (err, body) => { if (!finished) { finished = true; cb(err, body); } };
  const req = http.get(url, { timeout: 5000 }, res => {
    if (res.statusCode !== 200) { res.resume(); return done(new Error('HTTP ' + res.statusCode)); }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; });
    res.on('end', () => done(null, body));
    res.on('error', done);
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', done);
}

// -> { video: media playlist URL (video, or muxed a/v), clipInput: URL to cut
// clips from (the master when audio is a separate rendition, so ffmpeg reads both) }
function resolveStream(cb) {
  fetchText(MASTER_URL, (err, text) => {
    if (err) return cb(err);
    if (/#EXTINF/.test(text)) return cb(null, { video: MASTER_URL, clipInput: MASTER_URL });
    const lines = text.split('\n').map(s => s.trim());
    let variant = null, splitAudio = false;
    lines.forEach((l, i) => {
      if (/^#EXT-X-MEDIA:/.test(l) && /TYPE=AUDIO/.test(l) && /URI="/.test(l)) splitAudio = true;
      if (!variant && /^#EXT-X-STREAM-INF/.test(l)) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && lines[j][0] !== '#') { variant = lines[j]; break; }
        }
      }
    });
    if (!variant) return cb(new Error('no variant in master playlist'));
    const video = new URL(variant, MASTER_URL).href;
    cb(null, { video: video, clipInput: splitAudio ? MASTER_URL : video });
  });
}

function parseMediaPlaylist(text) {
  const segs = [];
  let dur = null, gap = false, trailing = 0;
  text.split('\n').forEach(raw => {
    const l = raw.trim();
    if (!l) return;
    if (l === '#EXT-X-GAP') gap = true;
    else if (l.indexOf('#EXTINF:') === 0) dur = parseFloat(l.slice(8));
    else if (l.indexOf('#EXT-X-PART:') === 0) {
      const m = l.match(/DURATION=([\d.]+)/);
      if (m) trailing += parseFloat(m[1]);
    } else if (l[0] !== '#') {
      // ffmpeg counts every segment line, gaps included, so we do too.
      segs.push({ dur: dur || 0, gap: gap });
      dur = null; gap = false; trailing = 0; // parts listed so far belonged to this segment
    }
  });
  return { segs: segs, trailing: trailing }; // trailing = in-progress segment (LL-HLS parts)
}

// Where is the moment `secondsAgo` before the live edge?
// -> { stream, index (negative, for -live_start_index), offset (s to trim), buffered (s) }
// "Live edge" = end of the playlist including LL-HLS parts, the same point the
// player's buffered end sits at, which is what the Replay Station measures from.
function locate(secondsAgo, cb, attempt) {
  attempt = attempt || 0;
  resolveStream((err, stream) => {
    if (err) return cb(err);
    fetchText(stream.video, (err2, text) => {
      if (err2) return cb(err2);
      const pl = parseMediaPlaylist(text);
      const n = pl.segs.length;
      const first = pl.segs.findIndex(s => !s.gap);
      if (!n || first < 0) return cb(new Error('buffer empty'));
      // ffmpeg fetches the playlist again a moment later. If a segment completes
      // in between, its count shifts by one and we'd start a segment late, so
      // don't launch right on a boundary.
      const last = pl.segs[n - 1].dur;
      if (attempt < 4 && last - pl.trailing < 0.4) {
        return setTimeout(() => locate(secondsAgo, cb, attempt + 1), 500);
      }
      const starts = [];
      let acc = 0;
      pl.segs.forEach(s => { starts.push(acc); acc += s.dur; });
      const total = acc + pl.trailing;
      const target = Math.max(starts[first], total - secondsAgo);
      let i = n - 1;
      while (i > first && starts[i] > target) i--;
      cb(null, {
        stream: stream,
        index: i - n,
        offset: Math.max(0, target - starts[i]),
        buffered: total - starts[first]
      });
    });
  });
}

// Serve clips with download header
app.use('/thumbs', express.static(path.join(CLIPS_DIR, 'thumbs')));
app.use('/clips', (req, res, next) => {
  res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(req.path) + '"');
  next();
}, express.static(CLIPS_DIR));

app.get('/health', (req, res) => { res.json({ status: 'ok' }); });
app.get('/api/buffer-info', (req, res) => {
  const all = ringFrames();
  const span = all.length ? Math.round((all[all.length - 1].t - all[0].t) / 1000) : 0;
  const fresh = all.length ? Math.round((Date.now() - all[all.length - 1].t) / 1000) : null;
  res.json({
    available: all.length > 0 && fresh !== null && fresh < 60,
    ringFrames: all.length,
    ringSpanSeconds: span,
    newestFrameAgeSeconds: fresh,
    strips: Object.keys(filmstripCache).map(k => ({
      zoom: parseInt(k, 10),
      cached: !!(filmstripCache[k].file && fs.existsSync(filmstripCache[k].file)),
      ageSeconds: filmstripCache[k].time ? Math.round((Date.now() - filmstripCache[k].time) / 1000) : null,
      generating: !!filmstripCache[k].generating
    }))
  });
});

// List clips with pagination
app.get('/api/clips', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 42;
    const offset = parseInt(req.query.offset) || 0;
    const all = fs.readdirSync(CLIPS_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const stat = fs.statSync(path.join(CLIPS_DIR, f));
        const durMatch = f.match(/(\d+)s\.mp4$/);
        const durPart = durMatch ? parseInt(durMatch[1]) : 0;
        return {
          id: f.replace('.mp4',''),
          filename: f,
          url: '/clips/' + f,
          thumb: '/thumbs/' + f.replace('.mp4', '.webp'),
          duration: durPart,
          sizeMB: (stat.size / 1024 / 1024).toFixed(1),
          createdAt: stat.mtimeMs,
          ago: getAgo(stat.mtimeMs)
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    const sliced = all.slice(offset, offset + limit);
    res.json({ clips: sliced, total: all.length, offset: offset, limit: limit });
  } catch (e) { res.json({ clips: [], total: 0 }); }
});

function getAgo(ms) {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 120) return '1 min ago';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
  return Math.floor(diff / 2592000) + 'mo ago';
}

function makeClipName(duration) {
  const d = new Date();
  const date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const time = String(d.getHours()).padStart(2,'0') + '-' + String(d.getMinutes()).padStart(2,'0') + '-' + String(d.getSeconds()).padStart(2,'0');
  return 'kutt_' + date + '_' + time + '_' + duration + 's';
}

const recentClips = {};
app.post('/api/clip', (req, res) => {
  const { startSecondsAgo, endSecondsAgo } = req.body;
  if (startSecondsAgo == null || endSecondsAgo == null) return res.status(400).json({ error: 'Need time range' });
  const duration = startSecondsAgo - endSecondsAgo;
  if (duration < 1 || duration > 1800) return res.status(400).json({ error: 'Clip 1-1800s' });
  const clientIP = req.ip;
  if (recentClips[clientIP] && Date.now() - recentClips[clientIP] < 10000) return res.status(429).json({ error: 'Wait 10s' });
  recentClips[clientIP] = Date.now();
  const durInt = Math.round(duration);
  const clipName = makeClipName(durInt);
  const outputFile = path.join(CLIPS_DIR, clipName + '.mp4');
  const encodeTimeout = Math.max(120000, durInt * 8000); // ~8s per clip second, min 2 min

  locate(startSecondsAgo, (locErr, loc) => {
    if (locErr) {
      delete recentClips[clientIP];
      console.error('[clip] cannot locate start:', locErr.message);
      return res.status(503).json({ error: 'Stream offline' });
    }
    const args = ['-live_start_index', String(loc.index), '-i', loc.stream.clipInput];
    if (fs.existsSync(LOGO_PATH)) {
      args.push('-i', LOGO_PATH, '-filter_complex', '[0:v][1:v]overlay=W-w-20:14:format=auto');
    }
    // Output-side -ss: decode from the segment start and drop the first `offset`
    // seconds (always under one segment), so the cut lands on the exact moment.
    args.push('-ss', loc.offset.toFixed(3), '-t', String(durInt),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outputFile);
    execFile('ffmpeg', args, { timeout: encodeTimeout, maxBuffer: 1024 * 1024 * 8 }, (error) => {
      if (error) {
        console.error('[clip] ffmpeg failed:', String(error.message).split('\n').slice(-3).join(' | '));
        return res.status(500).json({ error: 'Encoding failed' });
      }
      const stats = fs.statSync(outputFile);
      const thumbDir = path.join(CLIPS_DIR, 'thumbs');
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
      const thumbFile = path.join(thumbDir, clipName + '.webp');
      // Lightweight thumbnails: 240px wide, 8fps, max 3 seconds, lower quality
      const thumbDur = Math.min(3, durInt);
      execFile('ffmpeg', ['-i', outputFile, '-t', String(thumbDur), '-vf', 'scale=240:-1,fps=8', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '50', '-loop', '0', '-an', '-y', thumbFile], { timeout: encodeTimeout }, function() {});
      res.json({ url: '/clips/' + clipName + '.mp4', thumb: '/thumbs/' + clipName + '.webp', filename: clipName + '.mp4', duration: durInt, sizeMB: (stats.size / 1024 / 1024).toFixed(1) });
    });
  });
});

const likes = {};
app.post('/api/like/:clipId', (req, res) => {
  const { clipId } = req.params;
  const ip = req.ip;
  if (!likes[clipId]) likes[clipId] = new Set();
  if (likes[clipId].has(ip)) { likes[clipId].delete(ip); res.json({ liked: false, count: likes[clipId].size }); }
  else { likes[clipId].add(ip); res.json({ liked: true, count: likes[clipId].size }); }
});
app.get('/api/likes/:clipId', (req, res) => {
  const count = likes[req.params.clipId] ? likes[req.params.clipId].size : 0;
  res.json({ count });
});

// Filmstrip API - generates a horizontal sprite sheet of frames from the live buffer
const FILMSTRIP_DIR = '/tmp/kutt-filmstrips';
if (!fs.existsSync(FILMSTRIP_DIR)) fs.mkdirSync(FILMSTRIP_DIR, { recursive: true });

// Cache per zoom level: { '60': { file, time, generating } }
const filmstripCache = {};

// Continuous frame ring. One cheap grab from the LIVE EDGE every 6s, kept for
// ~33 min. Filmstrips composite from these instead of reading backwards
// through the buffer, which costs ~0.7s per second of window (a 30m strip
// would take ~20 min). Reading the live edge is always ~2s.
// Each frame is the first frame of the newest complete segment, and its file
// name is the wall-clock moment it shows (not when it was grabbed), so the
// timeline lines up with what the Replay Station plays.
const FRAMES_DIR = path.join(FILMSTRIP_DIR, 'ring');
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });
const RING_KEEP_MS = 2000 * 1000; // ~33 min, a little over the HLS buffer
let ringBusy = false;
// Motion score per ring frame: ffmpeg blends the frame against the previous one
// in difference mode and area-scales the result down to a single grey pixel, so
// one byte of stdout is the mean absolute change. No image library needed, and
// on 107x80 thumbnails it costs a few milliseconds.
const ringScore = new Map();

function scoreFrame(prevPath, curPath, cb) {
  execFile('ffmpeg', [
    '-v', 'error', '-i', prevPath, '-i', curPath,
    '-filter_complex', '[0][1]blend=all_mode=difference,format=gray,scale=1:1:flags=area',
    '-frames:v', '1', '-f', 'rawvideo', '-'
  ], { timeout: 10000, encoding: 'buffer', maxBuffer: 4096 }, (err, stdout) => {
    cb(err || !stdout || !stdout.length ? null : stdout[0]);
  });
}

function ringFrames() {
  try {
    return fs.readdirSync(FRAMES_DIR)
      .map(n => ({ n: n, t: parseInt(n, 10), p: path.join(FRAMES_DIR, n) }))
      .filter(x => x.t && x.n.endsWith('.jpg'))
      .sort((a, b) => a.t - b.t);
  } catch (e) { return []; }
}

function ringTick() {
  if (ringBusy) return;
  ringBusy = true;
  const asked = Date.now();
  // locate(0) clamps to the newest complete segment: index -1, and `offset` is
  // how far its first frame sits behind the live edge.
  locate(0, (err, loc) => {
    if (err) { ringBusy = false; return; }
    const f = path.join(FRAMES_DIR, Math.round(asked - loc.offset * 1000) + '.jpg');
    execFile('ffmpeg', [
      '-an', '-live_start_index', String(loc.index), '-i', loc.stream.video,
      '-frames:v', '1', '-q:v', '5', '-vf', 'scale=-1:80', '-y', f
    ], { timeout: 25000, maxBuffer: 1024 * 1024 }, () => ringSettle());
  });
}

function ringSettle() {
  ringBusy = false;
  const now = Date.now();
  const kept = [];
  ringFrames().forEach(x => {
    if (now - x.t > RING_KEEP_MS) {
      try { fs.unlinkSync(x.p); } catch (e) {}
      ringScore.delete(x.t);
    } else kept.push(x);
  });
  if (kept.length >= 2) {
    const cur = kept[kept.length - 1], prev = kept[kept.length - 2];
    if (!ringScore.has(cur.t)) scoreFrame(prev.p, cur.p, v => { if (v != null) ringScore.set(cur.t, v); });
  }
}

function generateFilmstrip(zoom, cb) {
  const key = zoom + '';
  if (!filmstripCache[key]) filmstripCache[key] = {};
  if (filmstripCache[key].generating) {
    if (cb) cb(new Error('already_generating'));
    return;
  }
  filmstripCache[key].generating = true;

  const outFile = path.join(FILMSTRIP_DIR, 'strip_' + zoom + '.jpg');
  const tmpFile = outFile + '.tmp';
  const frames = 10, height = 80;
  const started = Date.now();

  function done(error, stderr) {
    filmstripCache[key].generating = false;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (error || !fs.existsSync(tmpFile)) {
      filmstripCache[key].lastFail = Date.now();
      console.error('[filmstrip] FAIL zoom=' + zoom + ' after ' + elapsed + 's:', error && error.message);
      if (stderr) console.error('[filmstrip] stderr tail:', stderr.split('\n').slice(-5).join(' | '));
      if (cb) cb(error || new Error('no_output'));
      return;
    }
    try { fs.renameSync(tmpFile, outFile); } catch (e) {}
    filmstripCache[key].file = outFile;
    filmstripCache[key].time = Date.now();
    filmstripCache[key].lastFail = 0;
    console.log('[filmstrip] OK zoom=' + zoom + ' in ' + elapsed + 's');
    if (cb) cb(null, outFile);
  }

  // Composite from the ring whenever it holds enough history. A sequential read
  // costs ~0.7s per second of window, so a 60s strip only finishes ~40s after it
  // started and is already that stale before anyone sees it — which is why a
  // rally you just watched live wasn't on the timeline yet. Ring frames are at
  // most one tick old, so the strip matches what the player just saw.
  const ring = ringFrames();
  if (ring.length < 3) {
    if (zoom > 120) return done(new Error('ring_empty'));
    const fpsRate = frames / zoom;
    locate(zoom, (err, loc) => {
      if (err) return done(err);
      execFile('ffmpeg', [
        '-an',
        '-live_start_index', String(loc.index),
        '-i', loc.stream.video,
        // no -ss here: it would drop the single tiled output frame (timestamp 0)
        '-vf', 'fps=' + fpsRate.toFixed(6) + ',scale=-1:' + height + ',tile=' + frames + 'x1',
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'image2',
        '-y', tmpFile
      ], { timeout: 120000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => done(error, stderr));
    });
    return;
  }

  // Nearest stored frame per slot, so a half-filled ring still renders (frames
  // repeat early on and spread out as history accumulates) instead of failing.
  const all = ring;
  const now = Date.now();
  const picks = [];
  for (let i = 0; i < frames; i++) {
    const target = now - zoom * 1000 + (i * zoom * 1000) / (frames - 1);
    let best = all[0], bd = Math.abs(all[0].t - target);
    for (const x of all) {
      const d = Math.abs(x.t - target);
      if (d < bd) { bd = d; best = x; }
    }
    picks.push(best.p);
  }
  const args = [];
  picks.forEach(p => args.push('-i', p));
  // -f image2 is required: the temp name ends in .tmp so ffmpeg can't infer it.
  args.push('-filter_complex', 'hstack=inputs=' + picks.length, '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-y', tmpFile);
  execFile('ffmpeg', args, { timeout: 60000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => done(error, stderr));
}

// Where the action was: motion per ring frame across the requested window, so
// the timeline can show players where to look instead of making them scrub blind.
app.get('/api/activity', (req, res) => {
  const seconds = Math.min(1800, Math.max(10, parseInt(req.query.seconds) || 60));
  const now = Date.now();
  const cutoff = now - seconds * 1000;
  const points = [];
  ringFrames().forEach(f => {
    if (f.t < cutoff) return;
    const v = ringScore.get(f.t);
    if (v == null) return;
    points.push({ ago: +((now - f.t) / 1000).toFixed(1), score: v });
  });
  res.json({ seconds: seconds, max: points.reduce((m, p) => Math.max(m, p.score), 0), points: points });
});

app.get('/api/filmstrip', (req, res) => {
  const seconds = Math.min(1800, Math.max(10, parseInt(req.query.seconds) || 60));
  const key = seconds + '';
  const cached = filmstripCache[key];

  // Serve cached immediately if present
  if (cached && cached.file && fs.existsSync(cached.file)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(cached.file);
    // Trigger async refresh if stale (>10s old)
    if (Date.now() - cached.time > 10000 && !cached.generating) {
      generateFilmstrip(seconds);
    }
    return;
  }

  // No cache — generate and wait. Only blocks the very first request per zoom.
  generateFilmstrip(seconds, (err, file) => {
    if (err || !file) {
      return res.status(503).json({ error: 'Filmstrip generation failed', detail: err && err.message });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  });
});

// Generate thumbnails for existing clips on startup
function generateMissingThumbs() {
  var thumbDir = path.join(CLIPS_DIR, 'thumbs');
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
  try {
    var clips = fs.readdirSync(CLIPS_DIR).filter(f => f.endsWith('.mp4'));
    clips.forEach(function(f) {
      var thumbFile = path.join(thumbDir, f.replace('.mp4', '.webp'));
      if (!fs.existsSync(thumbFile)) {
        execFile('ffmpeg', ['-i', path.join(CLIPS_DIR, f), '-t', '3', '-vf', 'scale=240:-1,fps=8', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '50', '-loop', '0', '-an', '-y', thumbFile], { timeout: 60000 }, function() {});
      }
    });
  } catch(e) {}
}

app.listen(PORT, () => {
  console.log('KUTT clip API running on :' + PORT);
  generateMissingThumbs();
  // Warm all zoom levels sequentially so users never wait
  const zooms = [60, 120, 300, 1800];
  let i = 0;
  function warmNext() {
    if (i >= zooms.length) {
      console.log('[filmstrip] all caches warmed');
      return;
    }
    const z = zooms[i++];
    console.log('[filmstrip] warming zoom=' + z + '...');
    generateFilmstrip(z, () => warmNext());
  }
  ringTick();
  setInterval(ringTick, 6000);
  setTimeout(warmNext, 3000);
  // Periodic refresh of zoom=60 (most common) every 15s
  setInterval(() => {
    if (filmstripCache['60'] && !filmstripCache['60'].generating) {
      generateFilmstrip(60);
    }
  }, 15000);
  // Self-heal: startup warming runs once, so if the camera is offline at boot
  // every zoom level ends up with no cache and stays that way until a restart —
  // requests for those levels then block until the ffmpeg timeout and 504.
  // Retry missing levels in the background, one at a time.
  setInterval(() => {
    const busy = Object.keys(filmstripCache).some(k => filmstripCache[k].generating);
    if (busy) return;
    const missing = zooms.find(z => {
      const c = filmstripCache[z + ''];
      if (c && c.lastFail && Date.now() - c.lastFail < 600000) return false; // 10m backoff
      return !c || !c.file || !fs.existsSync(c.file);
    });
    if (missing) {
      console.log('[filmstrip] self-heal zoom=' + missing + '...');
      generateFilmstrip(missing);
    }
  }, 45000);
});
