const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const HLS_DIR = '/opt/kutt/hls/table2';
const CLIPS_DIR = '/opt/kutt/clips';
const LOGO_PATH = '/opt/kutt/logos/kutt-watermark.png';
const HLS_URL = 'http://127.0.0.1:8888/table2/stream.m3u8'; // MUST use stream.m3u8 (not index/master) for -sseof
const PORT = 3333;

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
  const hasLogo = fs.existsSync(LOGO_PATH);
  const encodeTimeout = Math.max(120000, durInt * 8000); // ~8s per clip second, min 2 min
  const args = hasLogo ? [
    '-sseof', '-' + startSecondsAgo, '-i', HLS_URL, '-i', LOGO_PATH,
    '-t', String(durInt), '-filter_complex', '[0:v][1:v]overlay=W-w-20:14:format=auto',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outputFile
  ] : [
    '-sseof', '-' + startSecondsAgo, '-i', HLS_URL,
    '-t', String(durInt), '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outputFile
  ];
  execFile('ffmpeg', args, { timeout: encodeTimeout }, (error) => {
    if (error) return res.status(500).json({ error: 'Encoding failed' });
    const stats = fs.statSync(outputFile);
    var thumbDir = path.join(CLIPS_DIR, 'thumbs');
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
    var thumbFile = path.join(thumbDir, clipName + '.webp');
    // Lightweight thumbnails: 240px wide, 8fps, max 3 seconds, lower quality
    var thumbFps = 8;
    var thumbDur = Math.min(3, durInt);
    execFile('ffmpeg', ['-i', outputFile, '-t', String(thumbDur), '-vf', 'scale=240:-1,fps=' + thumbFps, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '50', '-loop', '0', '-an', '-y', thumbFile], { timeout: encodeTimeout }, function() {});
    res.json({ url: '/clips/' + clipName + '.mp4', thumb: '/thumbs/' + clipName + '.webp', filename: clipName + '.mp4', duration: durInt, sizeMB: (stats.size / 1024 / 1024).toFixed(1) });
    cleanOldClips();
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

function cleanOldClips() {}

// Filmstrip API - generates a horizontal sprite sheet of frames from the live buffer
const FILMSTRIP_DIR = '/tmp/kutt-filmstrips';
if (!fs.existsSync(FILMSTRIP_DIR)) fs.mkdirSync(FILMSTRIP_DIR, { recursive: true });

// Cache per zoom level: { '60': { file, time, generating } }
const filmstripCache = {};

// Continuous frame ring. One cheap grab from the LIVE EDGE every 10s, kept for
// ~33 min. Long filmstrips composite from these instead of seeking backwards
// through the buffer: ffmpeg has to stream everything it seeks past, so a 5m
// window costs minutes and a 30m window is hopeless. Reading the live edge is
// always ~2s no matter how far back the strip reaches.
const FRAMES_DIR = path.join(FILMSTRIP_DIR, 'ring');
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });
const RING_KEEP_MS = 2000 * 1000;
const STREAM_URL = 'http://127.0.0.1:8888/table2/stream.m3u8';
let ringBusy = false;

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
  const f = path.join(FRAMES_DIR, Date.now() + '.jpg');
  execFile('ffmpeg', [
    '-an', '-sseof', '-3', '-i', STREAM_URL,
    '-frames:v', '1', '-q:v', '5', '-vf', 'scale=-1:80', '-y', f
  ], { timeout: 25000, maxBuffer: 1024 * 1024 }, () => {
    ringBusy = false;
    const now = Date.now();
    ringFrames().forEach(x => {
      if (now - x.t > RING_KEEP_MS) { try { fs.unlinkSync(x.p); } catch (e) {} }
    });
  });
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

  // Short windows: one sequential read is cheap and gives the freshest frames.
  if (zoom <= 120) {
    const fpsRate = frames / zoom;
    execFile('ffmpeg', [
      '-an',
      '-sseof', '-' + zoom,
      '-i', STREAM_URL,
      '-vf', 'fps=' + fpsRate.toFixed(6) + ',scale=-1:' + height + ',tile=' + frames + 'x1',
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'image2',
      '-y', tmpFile
    ], { timeout: 120000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => done(error, stderr));
    return;
  }

  // Long windows: composite from the ring. Picks the nearest stored frame to
  // each slot, so a half-filled ring still renders (repeats early on, fills in
  // as history accumulates) instead of failing outright.
  const all = ringFrames();
  if (!all.length) return done(new Error('ring_empty'));
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
  setInterval(ringTick, 10000);
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
