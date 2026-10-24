const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const WORK_DIR = '/tmp/render';
const OUT_DIR = path.join(WORK_DIR, 'videos');
const FILE_TTL_MS = 2 * 60 * 60 * 1000; // видео хранятся 2 часа

fs.mkdirSync(OUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/videos', express.static(OUT_DIR));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ffmpeg-render' }));

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) {
    throw new Error(`Got HTML instead of file (check sharing): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return dest;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg failed: ' + stderr.slice(-2000)));
    });
  });
}

app.post('/render', async (req, res) => {
  const id = crypto.randomUUID();
  const jobDir = path.join(WORK_DIR, id);

  try {
    const {
      images = [],
      music_url,
      duration_sec,
      image_durations,
      width = 900,
      height = 1600,
    } = req.body || {};

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images[] is required' });
    }

    const n = images.length;
    let durations = Array.isArray(image_durations) && image_durations.length === n
      ? image_durations.map(Number)
      : Array(n).fill((Number(duration_sec) || 15) / n);
    const total = durations.reduce((a, b) => a + b, 0);

    await fsp.mkdir(jobDir, { recursive: true });

    const imgFiles = await Promise.all(
      images.map((u, i) => download(u, path.join(jobDir, `img${i}`)))
    );
    let musicFile = null;
    if (music_url) {
      musicFile = await download(music_url, path.join(jobDir, 'music'));
    }

    const args = ['-y'];
    imgFiles.forEach((f, i) => {
      args.push('-loop', '1', '-t', String(durations[i]), '-i', f);
    });
    if (musicFile) args.push('-stream_loop', '-1', '-i', musicFile);

    // Картинки: вписать в кадр без искажения, добить фоном, плавные переходы
    const W = Number(width), H = Number(height);
    const filters = imgFiles.map((_, i) =>
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=30,format=yuv420p,` +
      `fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(durations[i] - 0.4, 0)}:d=0.4[v${i}]`
    );
    filters.push(imgFiles.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[v]`);

    if (musicFile) {
      const fadeStart = Math.max(total - 1.5, 0);
      filters.push(`[${n}:a]atrim=0:${total},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart}:d=1.5[a]`);
    }

    args.push('-filter_complex', filters.join(';'), '-map', '[v]');
    if (musicFile) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-r', '30',
      '-t', String(total),
      '-movflags', '+faststart',
      path.join(OUT_DIR, `${id}.mp4`)
    );

    await runFfmpeg(args);

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const video_url = `${proto}://${host}/videos/${id}.mp4`;

    res.json({ status: 'ok', video_url, video_file: `${id}.mp4`, duration_sec: total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Чистка старых видео
setInterval(async () => {
  try {
    const now = Date.now();
    for (const f of await fsp.readdir(OUT_DIR)) {
      const p = path.join(OUT_DIR, f);
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > FILE_TTL_MS) await fsp.rm(p, { force: true });
    }
  } catch (e) { console.error('cleanup', e); }
}, 15 * 60 * 1000);

app.listen(PORT, () => console.log(`ffmpeg-render listening on ${PORT}`));
