const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const TEMP = path.join(os.tmpdir(), 'instaready');
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;   // 2 GB
const JOB_TTL_MS = 30 * 60 * 1000;               // 30 min auto-expire
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;         // 30 min max encode
const STDERR_CAP = 8192;                          // cap stderr buffer

const FORMATS = {
  reel:   { w: 1080, h: 1920, label: 'Reel / Story', ratio: '9:16' },
  feed:   { w: 1080, h: 1350, label: 'Feed Portrait', ratio: '4:5' },
  square: { w: 1080, h: 1080, label: 'Square',        ratio: '1:1' },
};

// ─────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────

fs.mkdirSync(TEMP, { recursive: true });

// Clean orphaned temp files from previous crashes
try {
  const orphans = fs.readdirSync(TEMP);
  if (orphans.length > 0) {
    for (const f of orphans) {
      try { fs.unlinkSync(path.join(TEMP, f)); } catch {}
    }
    console.log(`✓ Cleaned ${orphans.length} orphaned temp file(s).`);
  }
} catch {}

// Verify ffmpeg/ffprobe and log version
let ffmpegVersion = 'unknown';
try {
  const verOutput = execSync('ffmpeg -version', { stdio: 'pipe', encoding: 'utf-8' });
  const match = verOutput.match(/ffmpeg version (\S+)/);
  ffmpegVersion = match ? match[1] : 'found';
  execSync('ffprobe -version', { stdio: 'pipe' });
  console.log(`✓ ffmpeg ${ffmpegVersion}`);
} catch {
  console.error('FATAL: ffmpeg/ffprobe not found.');
  process.exit(1);
}

// ─────────────────────────────────────────────
//  JOB TRACKING
// ─────────────────────────────────────────────

const jobs = new Map();
const activeProcs = new Set();

function genId() { return crypto.randomBytes(16).toString('hex'); }
function safeUnlink(p) { if (p) try { fs.unlinkSync(p); } catch {} }

function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  safeUnlink(job.inputPath);
  safeUnlink(job.outputPath);
  jobs.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > JOB_TTL_MS) cleanupJob(id);
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
//  EXPRESS SETUP
// ─────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);

const storage = multer.diskStorage({
  destination: TEMP,
  filename: (_req, file, cb) => cb(null, genId() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  MULTER ERROR HANDLER  (defined before routes for clarity)
// ─────────────────────────────────────────────

function handleMulterError(err, _req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large. Maximum size is 2 GB.' });
    return res.status(400).json({ error: 'Upload error: ' + err.message });
  }
  return res.status(500).json({ error: 'Upload failed.' });
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

function classifyFile(mimetype, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (mimetype?.startsWith('image/') ||
      ['.jpg','.jpeg','.png','.webp','.heic','.heif','.tiff','.tif','.bmp'].includes(ext))
    return 'image';
  if (mimetype?.startsWith('video/') ||
      ['.mov','.mp4','.m4v','.mkv','.avi','.webm','.mts'].includes(ext))
    return 'video';
  return 'unknown';
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// ─────────────────────────────────────────────
//  FFPROBE
// ─────────────────────────────────────────────

function probe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

// ─────────────────────────────────────────────
//  IMAGE PROCESSING
// ─────────────────────────────────────────────

async function processImage(job) {
  const { w, h } = FORMATS[job.format];
  job.progress = 10;

  const meta = await sharp(job.inputPath).metadata();
  job.sourceWidth = meta.width || 0;
  job.sourceHeight = meta.height || 0;

  await sharp(job.inputPath)
    .rotate()
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .toColorspace('srgb')
    .jpeg({ quality: 87 })
    .toFile(job.outputPath);

  job.progress = 100;
}

// ─────────────────────────────────────────────
//  VIDEO PROCESSING
// ─────────────────────────────────────────────

function runFfmpeg(args, job, totalDuration) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    activeProcs.add(proc);

    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      if (stderr.length > STDERR_CAP * 2) stderr = stderr.slice(-STDERR_CAP);

      if (totalDuration > 0) {
        const m = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m) {
          const secs = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
          job.progress = Math.min(99, Math.round((secs / totalDuration) * 100));
        }
      }
    });

    proc.on('close', code => {
      clearTimeout(timer);
      activeProcs.delete(proc);
      if (killed) resolve({ ok: false, timedOut: true });
      else if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, stderr: stderr.slice(-500) });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      activeProcs.delete(proc);
      reject(err);
    });
  });
}

async function processVideo(job) {
  const { w, h } = FORMATS[job.format];

  const info = await probe(job.inputPath);
  const videoStream = info.streams?.find(s => s.codec_type === 'video');
  const audioStream = info.streams?.find(s => s.codec_type === 'audio');
  if (!videoStream) throw new Error('No video stream found in file.');

  const duration = parseFloat(info.format?.duration || videoStream?.duration || '0');
  job.duration = duration;
  job.sourceWidth = videoStream.width || 0;
  job.sourceHeight = videoStream.height || 0;
  job.sourceFps = videoStream.r_frame_rate || '';
  job.sourceCodec = videoStream.codec_name || '';
  job.audioCodecIn = audioStream?.codec_name || null;

  // Audio strategy: AAC → copy, other → re-encode, none → skip
  const hasAudio = !!audioStream;
  const audioCodec = audioStream?.codec_name?.toLowerCase();
  let audioArgs;
  let triedCopy = false;

  if (!hasAudio) {
    audioArgs = ['-an'];
  } else if (audioCodec === 'aac') {
    audioArgs = ['-c:a', 'copy'];
    triedCopy = true;
  } else {
    audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
  }

  // Video filter: scale-to-cover → center-crop → anti-banding noise
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    `noise=c0s=2:c0f=t+u`,
  ].join(',');

  function buildArgs(aArgs) {
    return [
      '-nostdin',                     // prevent stdin read → hang
      '-i', job.inputPath,
      '-map', '0:v:0',
      ...(hasAudio && aArgs[0] !== '-an' ? ['-map', '0:a:0'] : []),
      '-vf', vf,
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level:v', '4.2',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '18',
      '-r', '30',
      '-g', '60',
      '-movflags', '+faststart',
      ...aArgs,
      '-y',
      job.outputPath,
    ];
  }

  job.progress = 1;
  let result = await runFfmpeg(buildArgs(audioArgs), job, duration);

  // Audio copy failed → retry with AAC re-encode
  if (!result.ok && triedCopy) {
    console.log(`[${job.id.slice(0,8)}] Audio copy failed, retrying with AAC re-encode…`);
    safeUnlink(job.outputPath);
    job.progress = 0;
    audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
    result = await runFfmpeg(buildArgs(audioArgs), job, duration);
  }

  if (!result.ok) {
    safeUnlink(job.outputPath);
    if (result.timedOut) throw new Error('Conversion timed out after 30 minutes.');
    throw new Error(
      result.stderr?.includes('Invalid data')
        ? 'File appears corrupted or uses an unsupported codec.'
        : 'Video conversion failed.'
    );
  }

  // Verify audio survived conversion
  if (hasAudio) {
    try {
      const outInfo = await probe(job.outputPath);
      const outAudio = outInfo.streams?.find(s => s.codec_type === 'audio');
      if (!outAudio) {
        safeUnlink(job.outputPath);
        throw new Error('Audio was lost during conversion — this is a bug. Please report it.');
      }
    } catch (e) {
      if (e.message.includes('Audio was lost')) throw e;
      safeUnlink(job.outputPath);
      throw new Error('Output file verification failed.');
    }
  }

  job.progress = 100;
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// Health check for Railway / uptime monitoring
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    activeJobs: jobs.size,
    ffmpeg: ffmpegVersion,
    uptime: Math.round(process.uptime()),
  });
});

// POST /convert — upload file, start conversion, return job ID
app.post('/convert', upload.single('file'), handleMulterError, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const format = req.body.format;
  if (!FORMATS[format]) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'Invalid format.' });
  }

  const type = classifyFile(req.file.mimetype, req.file.originalname);
  if (type === 'unknown') {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'Unsupported file type.' });
  }

  const jobId = genId();
  const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const outExt = type === 'image' ? '.jpg' : '.mp4';
  const outputPath = path.join(TEMP, jobId + '_out' + outExt);
  const outputFilename = `${baseName}_${format}${outExt}`;

  const job = {
    id: jobId, type, format,
    inputPath: req.file.path, outputPath, outputFilename,
    status: 'processing', progress: 0, error: null,
    created: Date.now(), duration: 0,
    inputSize: req.file.size, outputSize: 0,
    sourceWidth: 0, sourceHeight: 0,
    sourceFps: '', sourceCodec: '', audioCodecIn: null,
  };

  jobs.set(jobId, job);
  res.json({ jobId, type });

  // Process asynchronously
  try {
    if (type === 'image') await processImage(job);
    else await processVideo(job);

    const stat = fs.statSync(job.outputPath);
    job.outputSize = stat.size;
    job.status = 'done';
    job.progress = 100;

    const shortId = jobId.slice(0, 8);
    console.log(`[${shortId}] ✓ ${job.outputFilename} `
      + `(${job.sourceWidth}×${job.sourceHeight} → ${FORMATS[format].w}×${FORMATS[format].h}, `
      + `${formatBytes(job.inputSize)} → ${formatBytes(job.outputSize)})`);

    safeUnlink(job.inputPath);
    job.inputPath = null;

  } catch (err) {
    job.status = 'error';
    job.error = err.message || 'Processing failed.';
    console.error(`[${jobId.slice(0,8)}] ✗ ${job.error}`);
    safeUnlink(job.outputPath);
    safeUnlink(job.inputPath);
    job.inputPath = null;
    job.outputPath = null;
  }
});

// GET /progress/:id — poll conversion progress
app.get('/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const resp = { status: job.status, progress: job.progress };
  if (job.status === 'done') {
    resp.downloadUrl = `/download/${job.id}`;
    resp.outputSize = job.outputSize;
    resp.outputFilename = job.outputFilename;
    resp.sourceWidth = job.sourceWidth;
    resp.sourceHeight = job.sourceHeight;
    if (job.duration > 0) resp.duration = job.duration;
  }
  if (job.status === 'error') resp.error = job.error;

  res.json(resp);
});

// GET /download/:id — stream converted file
app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done')
    return res.status(404).json({ error: 'File not ready.' });
  if (!job.outputPath || !fs.existsSync(job.outputPath))
    return res.status(404).json({ error: 'File expired. Convert again.' });

  // Content-Length for mobile download progress
  try { res.setHeader('Content-Length', fs.statSync(job.outputPath).size); } catch {}

  const mime = job.outputFilename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
  res.setHeader('Content-Type', mime);

  // RFC 5987 filename for unicode safety
  const encoded = encodeURIComponent(job.outputFilename).replace(/['()]/g, escape);
  res.setHeader('Content-Disposition',
    `attachment; filename="${job.outputFilename}"; filename*=UTF-8''${encoded}`);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
  });

  // Clean up 60s after download (allows one re-download)
  res.on('finish', () => setTimeout(() => cleanupJob(job.id), 60 * 1000));
});

// ─────────────────────────────────────────────
//  CATCH-ALL ERROR HANDLER
// ─────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
});

// ─────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received. Cleaning up…`);
  for (const proc of activeProcs) { try { proc.kill('SIGTERM'); } catch {} }
  for (const [id] of jobs) cleanupJob(id);
  try {
    for (const f of fs.readdirSync(TEMP)) {
      try { fs.unlinkSync(path.join(TEMP, f)); } catch {}
    }
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`InstaReady listening on port ${PORT}`);
  console.log(`Temp: ${TEMP}`);
});
