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
  try {
    const files = fs.readdirSync(HLS_DIR).filter(f => f.endsWith('.mp4')).sort();
    res.json({ available: files.length > 0, segments: files.length, estimatedSeconds: files.length * 2 });
  } catch (e) { res.json({ available: false }); }
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
  return Math.floor(diff / 3600) + 'h ago';
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
  const fpsRate = frames / zoom;
  const STREAM_URL = 'http://127.0.0.1:8888/table2/stream.m3u8';

  const args = [
    '-an',
    '-sseof', '-' + zoom,
    '-i', STREAM_URL,
    '-vf', 'fps=' + fpsRate.toFixed(6) + ',scale=-1:' + height + ',tile=' + frames + 'x1',
    '-frames:v', '1',
    '-q:v', '4',
    '-f', 'image2',
    '-y', tmpFile
  ];

  const started = Date.now();
  execFile('ffmpeg', args, { timeout: 120000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
    filmstripCache[key].generating = false;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (error || !fs.existsSync(tmpFile)) {
      console.error('[filmstrip] FAIL zoom=' + zoom + ' after ' + elapsed + 's:', error && error.message);
      if (stderr) console.error('[filmstrip] stderr tail:', stderr.split('\n').slice(-5).join(' | '));
      if (cb) cb(error || new Error('no_output'));
      return;
    }
    try { fs.renameSync(tmpFile, outFile); } catch (e) {}
    filmstripCache[key].file = outFile;
    filmstripCache[key].time = Date.now();
    console.log('[filmstrip] OK zoom=' + zoom + ' in ' + elapsed + 's');
    if (cb) cb(null, outFile);
  });
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
  setTimeout(warmNext, 3000);
  // Periodic refresh of zoom=60 (most common) every 15s
  setInterval(() => {
    if (filmstripCache['60'] && !filmstripCache['60'].generating) {
      generateFilmstrip(60);
    }
  }, 15000);
});
