import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 31337;
const DOWNLOADS_DIR = path.join(os.tmpdir(), 'mamzouka-cache');
const CONVERT_DIR = path.join(os.tmpdir(), 'mamzouka-convert');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } catch (e) {}
} else {
  // Prune cache files older than 12 hours on startup to prevent disk fill
  try {
    const now = Date.now();
    const maxAge = 12 * 60 * 60 * 1000;
    fs.readdirSync(DOWNLOADS_DIR).forEach((file) => {
      const fullPath = path.join(DOWNLOADS_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAge) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch (e) {}
    });
  } catch (e) {}
}

try {
  if (!fs.existsSync(CONVERT_DIR)) fs.mkdirSync(CONVERT_DIR, { recursive: true });
  // Prune converted files older than 12 hours on startup
  try {
    const now2 = Date.now();
    const maxAge2 = 12 * 60 * 60 * 1000;
    fs.readdirSync(CONVERT_DIR).forEach((file) => {
      const fullPath = path.join(CONVERT_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now2 - stat.mtimeMs > maxAge2) fs.rmSync(fullPath, { recursive: true, force: true });
      } catch (e) {}
    });
  } catch (e) {}
} catch (e) {}

// ----------------------------------------------------
// ffmpeg auto-transcode helpers (MKV -> browser-playable MP4)
// ----------------------------------------------------
let _ffmpegBin = null;
let _ffmpegCheckedAt = 0;
function findFfmpeg() {
  const now = Date.now();
  if (_ffmpegBin && now - _ffmpegCheckedAt < 60000) return _ffmpegBin;
  _ffmpegCheckedAt = now;
  const candidates = ['ffmpeg', 'ffmpeg.exe'];
  // In-app copy provided by installer/first-run (env) or per-user download.
  if (process.env.MAMZOUKA_FFMPEG) candidates.unshift(process.env.MAMZOUKA_FFMPEG);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'com.mamzouka.stream', 'bin', 'ffmpeg.exe'));
  }
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\ffmpeg\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(process.cwd(), 'ffmpeg.exe'),
      path.join(process.cwd(), 'resources', 'ffmpeg.exe')
    );
    try {
      const exeDir = path.dirname(process.execPath);
      candidates.push(path.join(exeDir, 'ffmpeg.exe'), path.join(exeDir, 'resources', 'ffmpeg.exe'));
    } catch (e) {}
  }
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" -version`, { stdio: 'ignore', timeout: 4000 });
      _ffmpegBin = bin;
      return bin;
    } catch (e) {}
  }
  _ffmpegBin = null;
  return null;
}

// convertJobs: key -> { status, progress, outputFile, error, startedAt }
const convertJobs = new Map();
function convertKey(infoHash, fileIndex) {
  return `${String(infoHash).toLowerCase()}_${parseInt(fileIndex, 10) || 0}`;
}
function isMkvName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.mkv');
}

const POPULAR_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://tracker.altrosky.nl:2710/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

function enhanceMagnet(magnet) {
  if (!magnet || !magnet.startsWith('magnet:')) return magnet;
  let enhanced = magnet;
  POPULAR_TRACKERS.forEach((tr) => {
    const encoded = encodeURIComponent(tr);
    if (!enhanced.includes(encoded) && !enhanced.includes(tr)) {
      enhanced += `&tr=${encoded}`;
    }
  });
  return enhanced;
}

const client = new WebTorrent({
  maxConns: 120,
  dht: true,
  lsd: true,
  webSeeds: true,
  tracker: {
    announce: POPULAR_TRACKERS,
  },
});

client.on('error', (err) => {
  console.warn('[WebTorrent Client Error]', err ? err.message : err);
});

function findTorrent(infoHash) {
  if (!infoHash || !client.torrents) return null;
  const target = infoHash.toLowerCase();
  return client.torrents.find((t) => t && !t.destroyed && t.infoHash && t.infoHash.toLowerCase() === target) || null;
}

function cleanupInactiveTorrents(keepInfoHash = null) {
  if (!client.torrents) return;
  const torrents = [...client.torrents];
  torrents.forEach((t) => {
    if (t && t.infoHash && (!keepInfoHash || t.infoHash.toLowerCase() !== keepInfoHash.toLowerCase())) {
      try {
        t.destroy({ destroyStore: false }, () => {});
      } catch (e) {}
    }
  });
}

function waitForTorrentReady(torrent, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (!torrent) return resolve(null);
    if (torrent.ready && Array.isArray(torrent.files) && torrent.files.length > 0) {
      return resolve(torrent);
    }

    let timeoutId;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (typeof torrent.removeListener === 'function') {
        torrent.removeListener('ready', onReady);
        torrent.removeListener('metadata', onMetadata);
      }
    };

    const onReady = () => { cleanup(); resolve(torrent); };
    const onMetadata = () => {
      if (Array.isArray(torrent.files) && torrent.files.length > 0) {
        cleanup();
        resolve(torrent);
      }
    };

    torrent.once('ready', onReady);
    torrent.once('metadata', onMetadata);

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(torrent);
    }, timeoutMs);
  });
}

// ----------------------------------------------------
// API Routes
// ----------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', torrents: client.torrents ? client.torrents.length : 0, ffmpeg: !!findFfmpeg() });
});

app.get('/api/ffmpeg/status', (req, res) => {
  const bin = findFfmpeg();
  res.json({ available: !!bin, bin: bin || null });
});

// Probe: isolate ENGINE vs PLAYER errors without starting playback
app.get('/api/stream/probe/:infoHash', async (req, res) => {
  const torrent = findTorrent(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found', code: 'NOT_FOUND' });
  if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
    await waitForTorrentReady(torrent, 15000);
  }
  const files = Array.isArray(torrent.files) ? torrent.files : [];
  if (files.length === 0) {
    return res.json({ code: 'METADATA_TIMEOUT', peers: torrent.numPeers || 0, progress_pct: 0, files: [] });
  }
  const peers = torrent.numPeers || 0;
  const progress = torrent.progress || 0;
  let code = 'OK';
  if (peers === 0 && progress === 0) code = 'NO_PEERS';
  res.json({
    code,
    peers,
    progress_pct: Math.round(progress * 100),
    files: files.map((f, i) => ({ index: i, name: f.name, size: f.length, isMkv: isMkvName(f.name), needsTranscode: isMkvName(f.name) })),
  });
});

// ----------------------------------------------------
// MKV auto-transcode (inside app): MKV --ffmpeg--> MP4 faststart
// POST /api/convert/start { infoHash, fileIndex } -> { key, status }
// GET  /api/convert/status/:key -> { status, progress, outputUrl }
// GET  /api/convert/file/:key -> converted mp4 (range supported)
// ----------------------------------------------------
function runConvertJob(key, infoHash, fileIndex) {
  const job = convertJobs.get(key);
  if (!job || job.status === 'running' || job.status === 'done') return job;
  const torrent = findTorrent(infoHash);
  if (!torrent || !torrent.files || !torrent.files[fileIndex]) {
    job.status = 'error';
    job.error = 'Torrent file not ready yet';
    return job;
  }
  const ffmpegBin = findFfmpeg();
  if (!ffmpegBin) {
    job.status = 'error';
    job.error = 'ffmpeg not found — install ffmpeg or use VLC';
    return job;
  }
  const file = torrent.files[fileIndex];
  const total = file.length || 1;
  const outFile = path.join(CONVERT_DIR, `${key}.mp4`);
  // Resume: already converted
  try {
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024 * 1024) {
      job.status = 'done';
      job.progress = 100;
      job.outputFile = outFile;
      return job;
    }
  } catch (e) {}

  job.status = 'running';
  job.progress = 1;
  const inputUrl = `http://127.0.0.1:${PORT}/api/stream/${infoHash}/${fileIndex}`;
  // Fast path first: copy video, transcode audio to AAC, keep subs (works for H.264 MKV).
  // Fallback: full H.264 transcode (works for H.265 MKV). Keep first audio + all subs.
  const fastArgs = ['-y', '-i', inputUrl, '-map', '0:v:0', '-map', '0:a?', '-map', '0:s?', '-c:v', 'copy', '-c:a', 'aac', '-c:s', 'mov_text', '-movflags', '+faststart', outFile];
  const slowArgs = ['-y', '-i', inputUrl, '-map', '0:v:0', '-map', '0:a?', '-map', '0:s?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-c:s', 'mov_text', '-movflags', '+faststart', outFile];
  console.log(`[Convert] starting fast remux ${key} <- ${file.name}`);
  const child = spawn(ffmpegBin, fastArgs, { windowsHide: true });
  job.child = child;
  let usedSlow = false;
  child.stderr.on('data', () => {
    try {
      const cur = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      job.progress = Math.max(1, Math.min(99, Math.round((cur / total) * 100)));
    } catch (e) {}
  });
  child.on('error', (err) => {
    job.status = 'error';
    job.error = String((err && err.message) || err);
  });
  child.on('close', (code) => {
    if (code === 0) {
      job.status = 'done';
      job.progress = 100;
      job.outputFile = outFile;
      console.log(`[Convert] done ${key}`);
      return;
    }
    if (!usedSlow) {
      usedSlow = true;
      console.log(`[Convert] fast remux failed for ${key}, retry full transcode`);
      job.progress = 2;
      const child2 = spawn(ffmpegBin, slowArgs, { windowsHide: true });
      job.child = child2;
      child2.stderr.on('data', () => {
        try {
          const cur = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
          job.progress = Math.max(1, Math.min(99, Math.round((cur / total) * 100)));
        } catch (e) {}
      });
      child2.on('error', (err) => { job.status = 'error'; job.error = String((err && err.message) || err); });
      child2.on('close', (code2) => {
        if (code2 === 0) { job.status = 'done'; job.progress = 100; job.outputFile = outFile; }
        else { job.status = 'error'; job.error = `ffmpeg failed (code ${code2}). Try VLC.`; }
      });
      return;
    }
    job.status = 'error';
    job.error = `ffmpeg failed (code ${code}). Try VLC.`;
  });
  return job;
}

app.post('/api/convert/start', async (req, res) => {
  const { infoHash, fileIndex } = req.body || {};
  if (!infoHash) return res.status(400).json({ error: 'infoHash required' });
  const idx = parseInt(fileIndex, 10) || 0;
  let torrent = findTorrent(infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found. Start stream first.', code: 'NOT_FOUND' });
  if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
    await waitForTorrentReady(torrent, 30000);
  }
  if (!torrent.files || !torrent.files[idx]) {
    return res.status(404).json({ error: 'File not ready yet (metadata loading)', code: 'METADATA_TIMEOUT' });
  }
  const bin = findFfmpeg();
  if (!bin) return res.status(500).json({ error: 'ffmpeg not found — install ffmpeg or use VLC', code: 'NO_FFMPEG' });
  const key = convertKey(infoHash, idx);
  if (!convertJobs.has(key)) {
    convertJobs.set(key, { status: 'queued', progress: 0, outputFile: null, error: null, startedAt: Date.now(), child: null });
  }
  const job = runConvertJob(key, infoHash, idx);
  res.json({ key, status: job.status, progress: job.progress || 0, outputUrl: `http://127.0.0.1:${PORT}/api/convert/file/${key}`, error: job.error || null });
});

app.get('/api/convert/status/:key', (req, res) => {
  const job = convertJobs.get(req.params.key);
  if (!job) return res.status(404).json({ error: 'Convert job not found' });
  res.json({
    status: job.status,
    progress: job.progress || 0,
    outputUrl: job.status === 'done' ? `http://127.0.0.1:${PORT}/api/convert/file/${req.params.key}` : null,
    error: job.error || null,
  });
});

app.get('/api/convert/file/:key', (req, res) => {
  const job = convertJobs.get(req.params.key);
  const outFile = job && job.outputFile;
  if (!outFile || !fs.existsSync(outFile)) {
    // Allow progressive playback while converting
    const maybe = path.join(CONVERT_DIR, `${req.params.key}.mp4`);
    if (!fs.existsSync(maybe)) return res.status(404).send('Converted file not ready yet');
    return serveFileRange(maybe, 'video/mp4', req, res);
  }
  return serveFileRange(outFile, 'video/mp4', req, res);
});

function serveFileRange(absPath, mimeType, req, res) {  try {
    const stat = fs.statSync(absPath);
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = Math.max(0, parseInt(parts[0], 10) || 0);
      const end = parts[1] ? Math.min(parseInt(parts[1], 10), total - 1) : total - 1;
      if (start >= total) return res.status(416).send('Range not satisfiable');
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });
      const stream = fs.createReadStream(absPath, { start, end });
      stream.pipe(res);
      stream.on('error', () => { try { res.end(); } catch (e) {} });
      req.on('close', () => { try { stream.destroy(); } catch (e) {} });
    } else {
      res.writeHead(200, { 'Content-Length': total, 'Content-Type': mimeType, 'Accept-Ranges': 'bytes' });
      const stream = fs.createReadStream(absPath);
      stream.pipe(res);
      stream.on('error', () => { try { res.end(); } catch (e) {} });
      req.on('close', () => { try { stream.destroy(); } catch (e) {} });
    }
  } catch (e) {
    res.status(500).send('Failed to serve converted file');
  }
}

app.post('/api/stream/start', async (req, res) => {
  let { magnet } = req.body;
  if (!magnet) {
    return res.status(400).json({ error: 'Magnet URI is required' });
  }

  try {
    const enhancedMagnet = enhanceMagnet(magnet);
    const hashMatch = enhancedMagnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
    const reqHash = hashMatch ? hashMatch[1].toLowerCase() : null;

    let torrent = findTorrent(reqHash);

    if (!torrent) {
      cleanupInactiveTorrents(reqHash);
      try {
        torrent = client.add(enhancedMagnet, {
          path: DOWNLOADS_DIR,
          maxWebConns: 32,
          announce: POPULAR_TRACKERS,
        });
      } catch (addErr) {
        torrent = findTorrent(reqHash);
        if (!torrent) throw addErr;
      }
    }

    // Wait for metadata to resolve files list (15s max so UI doesn't hang)
    await waitForTorrentReady(torrent, 15000);

    const hasMetadata = Array.isArray(torrent.files) && torrent.files.length > 0;
    const peers = torrent.numPeers || 0;
    const progress = torrent.progress || 0;
    const allFiles = Array.isArray(torrent.files) ? torrent.files : [];
    let videoFiles = allFiles
      .filter((f) => /\.(mp4|mkv|webm|avi|mov|m4v|ts|flv)$/i.test(f.name))
      .sort((a, b) => b.length - a.length);

    if (videoFiles.length === 0 && allFiles.length > 0) {
      videoFiles = [...allFiles].sort((a, b) => b.length - a.length);
    }

    const mainFile = videoFiles.length > 0 ? videoFiles[0] : null;
    const mainFileIndex = mainFile ? allFiles.indexOf(mainFile) : 0;

    // Deselect non-video files and prioritize the main video stream
    if (allFiles.length > 0) {
      allFiles.forEach((f) => {
        if (f !== mainFile && typeof f.deselect === 'function') {
          try { f.deselect(); } catch (e) {}
        }
      });
    }
    if (mainFile && typeof mainFile.select === 'function') {
      try { mainFile.select(); } catch (e) {}
    }

    // Fast return: do not stall user interface for 20 seconds
    const streamUrl = `http://127.0.0.1:${PORT}/api/stream/${reqHash}/${mainFileIndex}`;
    const mainName = (mainFile ? mainFile.name : torrent.name) || 'Video Stream';
    const mkv = isMkvName(mainName);
    // Error isolation codes for the player layer:
    // OK | METADATA_TIMEOUT (no file list yet) | NO_PEERS (metadata ok, 0 peers + 0 progress)
    let code = 'OK';
    if (!hasMetadata) code = 'METADATA_TIMEOUT';
    else if (peers === 0 && progress === 0) code = 'NO_PEERS';

    res.json({
      success: true,
      infoHash: reqHash,
      name: mainName,
      streamUrl,
      stream_url: streamUrl,
      code,
      peers,
      progress_pct: Math.round(progress * 100),
      hasMetadata,
      isMkv: mkv,
      needsTranscode: mkv,
      ffmpegAvailable: !!findFfmpeg(),
      fileIndex: mainFileIndex,
      size: mainFile ? mainFile.length : 0,
      files: videoFiles.map((f) => ({
        index: allFiles.indexOf(f),
        name: f.name,
        size: f.length,
      })),
    });
  } catch (err) {
    console.error('[Stream Start Error]', err);
    res.status(500).json({ error: err.message || 'Failed to start torrent stream' });
  }
});

app.get('/api/stream/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  let torrent = findTorrent(infoHash);
  if (!torrent) {
    return res.status(404).send('Torrent not found');
  }

  if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
    await waitForTorrentReady(torrent, 30000);
  }

  if (!torrent.files || torrent.files.length === 0) {
    return res.status(404).send('Torrent metadata still loading');
  }

  const fileIdxNum = parseInt(fileIndex, 10);
  const file = torrent.files[fileIdxNum] || torrent.files[0];
  if (!file) return res.status(404).send('File not found');

  const total = file.length;
  const range = req.headers.range;

  let mimeType = 'video/mp4';
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.mkv')) mimeType = 'video/webm'; // Chromium/WebView parses Matroska natively via webm container engine
  else if (lower.endsWith('.webm')) mimeType = 'video/webm';
  else if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) mimeType = 'video/mp4';
  else if (lower.endsWith('.avi')) mimeType = 'video/x-msvideo';
  else if (lower.endsWith('.mov')) mimeType = 'video/quicktime';
  else if (lower.endsWith('.ts')) mimeType = 'video/mp2t';
  else if (lower.endsWith('.flv')) mimeType = 'video/x-flv';
  else mimeType = 'video/mp4';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });

    const stream = file.createReadStream({ start, end });
    stream.pipe(res);
    stream.on('error', () => {});
    req.on('close', () => stream.destroy());
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });

    const stream = file.createReadStream();
    stream.pipe(res);
    stream.on('error', () => {});
    req.on('close', () => stream.destroy());
  }
});

// ----------------------------------------------------
// Live On-The-Fly Transmuxing & Transcoding (MKV/DTS/AC3/HEVC -> Browser MP4)
// GET /api/stream-live/:infoHash/:fileIndex?mode=remux|transcode&ss=0
// ----------------------------------------------------
let _hasNvenc = null;
function checkNvenc(ffmpegBin) {
  if (_hasNvenc !== null) return _hasNvenc;
  try {
    const out = execSync(`"${ffmpegBin}" -encoders`, { encoding: 'utf8', timeout: 3000 });
    _hasNvenc = out.includes('h264_nvenc');
  } catch (e) {
    _hasNvenc = false;
  }
  return _hasNvenc;
}

app.get('/api/stream-live/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const startTime = parseFloat(req.query.ss) || 0;
  const mode = req.query.mode === 'transcode' ? 'transcode' : 'remux';

  let torrent = findTorrent(infoHash);
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not active. Start stream first.' });
  }

  if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
    await waitForTorrentReady(torrent, 30000);
  }

  if (!torrent.files || torrent.files.length === 0) {
    return res.status(404).send('Torrent metadata still loading');
  }

  const fileIdxNum = parseInt(fileIndex, 10);
  const file = torrent.files[fileIdxNum] || torrent.files[0];
  if (!file) return res.status(404).send('File not found');

  const ffmpegBin = findFfmpeg();
  if (!ffmpegBin) {
    // If no FFmpeg available on system, fallback to standard stream
    return res.redirect(`/api/stream/${infoHash}/${fileIndex}`);
  }

  const inputUrl = `http://127.0.0.1:${PORT}/api/stream/${infoHash}/${fileIndex}`;

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
  ];

  if (startTime > 0) {
    ffmpegArgs.push('-ss', String(startTime));
  }

  ffmpegArgs.push(
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', inputUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?'
  );

  if (mode === 'transcode') {
    const useNvenc = checkNvenc(ffmpegBin);
    if (useNvenc) {
      ffmpegArgs.push(
        '-c:v', 'h264_nvenc',
        '-preset', 'p1',
        '-tune', 'ull',
        '-b:v', '5M',
        '-maxrate', '8M',
        '-bufsize', '10M',
        '-pix_fmt', 'yuv420p'
      );
    } else {
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '22',
        '-pix_fmt', 'yuv420p'
      );
    }
  } else {
    // Fast remux: video packets copied without re-encoding (0% CPU, instant start!)
    ffmpegArgs.push('-c:v', 'copy');
  }

  // Audio: always transcode to AAC stereo so AC3, EAC3, DTS, TrueHD all play seamlessly in WebView2!
  ffmpegArgs.push(
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    // Output: Fragmented MP4 stream directly to stdout pipe
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  );

  console.log(`[StreamLive] Starting ${mode} (NVENC: ${checkNvenc(ffmpegBin)}) for ${file.name} ss=${startTime}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  const child = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });

  child.stdout.pipe(res);

  let killed = false;
  const killProc = () => {
    if (killed) return;
    killed = true;
    try {
      child.stdout.destroy();
      child.kill('SIGKILL');
    } catch (e) {}
  };

  child.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.toLowerCase().includes('error')) {
      console.warn(`[StreamLive FFmpeg] ${msg.trim()}`);
    }
  });

  child.on('error', (err) => {
    console.error(`[StreamLive] FFmpeg error:`, err);
    killProc();
  });

  child.on('close', (code) => {
    killProc();
  });

  req.on('close', () => {
    killProc();
  });
});

app.get('/api/probe/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = findTorrent(infoHash);
  if (!torrent || !torrent.files || !torrent.files[fileIndex]) {
    return res.status(404).json({ error: 'File not ready' });
  }
  const file = torrent.files[fileIndex];
  const isMkv = isMkvName(file.name);
  const ffmpegBin = findFfmpeg();
  res.json({
    name: file.name,
    isMkv,
    ffmpegAvailable: !!ffmpegBin,
    liveUrl: `http://127.0.0.1:${PORT}/api/stream-live/${infoHash}/${fileIndex}?mode=remux`,
    transcodeUrl: `http://127.0.0.1:${PORT}/api/stream-live/${infoHash}/${fileIndex}?mode=transcode`,
    rawUrl: `http://127.0.0.1:${PORT}/api/stream/${infoHash}/${fileIndex}`
  });
});

app.get('/api/stream/stats/:infoHash', (req, res) => {
  const torrent = findTorrent(req.params.infoHash);
  if (!torrent) {
    return res.json({ active: false, speed_formatted: '0 KB/s', peers: 0, progress_pct: 0 });
  }

  const speedBytes = torrent.downloadSpeed || 0;
  let speed_formatted = '0 KB/s';
  if (speedBytes > 1024 * 1024) {
    speed_formatted = `↓ ${(speedBytes / (1024 * 1024)).toFixed(1)} MB/s`;
  } else if (speedBytes > 1024) {
    speed_formatted = `↓ ${(speedBytes / 1024).toFixed(0)} KB/s`;
  }

  const progress_pct = Math.round((torrent.progress || 0) * 100);

  res.json({
    active: true,
    speed_formatted,
    peers: torrent.numPeers || 0,
    progress_pct,
    downloaded: torrent.downloaded,
    timeRemaining: torrent.timeRemaining,
  });
});

// ----------------------------------------------------
// Disk quota guard: keep (cache + converted) under ENGINE_QUOTA_GB (default 10)
// Deletes oldest files first. Runs on startup + hourly + on demand.
// ----------------------------------------------------
let ENGINE_QUOTA_GB = parseFloat(process.env.MAMZOUKA_ENGINE_QUOTA_GB || '10') || 10;
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch (e) {}
    }
  } catch (e) {}
  return total;
}
function enforceQuota() {
  try {
    const maxBytes = ENGINE_QUOTA_GB * 1024 * 1024 * 1024;
    const dirs = [DOWNLOADS_DIR, CONVERT_DIR];
    let total = dirs.reduce((a, d) => a + dirSizeBytes(d), 0);
    if (total <= maxBytes) return { total, cleaned: 0 };
    const entries = [];
    for (const d of dirs) {
      try {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          try { const st = fs.statSync(fp); entries.push({ fp, mtime: st.mtimeMs, size: st.size }); } catch (e) {}
        }
      } catch (e) {}
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    let cleaned = 0;
    for (const e of entries) {
      if (total <= maxBytes) break;
      try { fs.rmSync(e.fp, { recursive: true, force: true }); total -= e.size; cleaned += e.size; } catch (err) {}
    }
    console.log(`[Quota] enforced ${ENGINE_QUOTA_GB}GB, cleaned ${(cleaned / 1048576).toFixed(0)}MB`);
    return { total, cleaned };
  } catch (e) { return { total: 0, cleaned: 0 }; }
}
app.get('/api/cache/status', (req, res) => {
  res.json({
    quota_gb: ENGINE_QUOTA_GB,
    cache_mb: Math.round(dirSizeBytes(DOWNLOADS_DIR) / 1048576),
    converted_mb: Math.round(dirSizeBytes(CONVERT_DIR) / 1048576),
  });
});
app.post('/api/cache/clear', (req, res) => {
  let cleared = 0;
  for (const d of [DOWNLOADS_DIR, CONVERT_DIR]) {
    try {
      for (const f of fs.readdirSync(d)) {
        try { const fp = path.join(d, f); cleared += fs.statSync(fp).size; fs.rmSync(fp, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {}
  }
  convertJobs.clear();
  res.json({ cleared_mb: Math.round(cleared / 1048576) });
});
setInterval(enforceQuota, 60 * 60 * 1000);
enforceQuota();

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Mamzouka Torrent Engine] Running on http://127.0.0.1:${PORT}`);
});

function gracefulExit() {
  cleanupInactiveTorrents();
  try {
    client.destroy(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  } catch (e) {
    process.exit(0);
  }
}

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

