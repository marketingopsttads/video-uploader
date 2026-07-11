require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { execFile } = require('child_process');
const XLSX = require('xlsx');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const THUMBNAIL_PUBLIC_URL = (process.env.THUMBNAIL_PUBLIC_URL || PUBLIC_URL).replace(/\/$/, '');

function displayName(key) {
  const base = key.split('/').pop();
  const noExt = base.replace(/\.[^.]+$/, '');
  const withoutTs = noExt.replace(/^\d+_?/, '');
  return withoutTs ? `${withoutTs}${path.extname(base)}` : base;
}

// Extract a JPEG frame at ~3s from a video buffer using ffmpeg
async function extractThumbnail(videoBuffer, videoExt) {
  const tmpVideo = path.join(os.tmpdir(), `upload_${Date.now()}${videoExt}`);
  const tmpThumb = path.join(os.tmpdir(), `thumb_${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmpVideo, videoBuffer);
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-ss', '3',           // seek to 3 seconds
        '-i', tmpVideo,
        '-vframes', '1',      // grab one frame
        '-q:v', '2',          // high quality JPEG
        '-y', tmpThumb,
      ], { timeout: 30000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return fs.readFileSync(tmpThumb);
  } finally {
    try { fs.unlinkSync(tmpVideo); } catch (_) {}
    try { fs.unlinkSync(tmpThumb); } catch (_) {}
  }
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const originalName = req.file.originalname;
    const ext = path.extname(originalName) || '.mp4';
    const shortName = originalName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 25).replace(/_+$/, '');
    const ts = Date.now();
    const key = `videos/${ts}_${shortName}${ext}`;
    const thumbKey = `thumbnails/${ts}_${shortName}.jpg`;

    // Upload video and generate thumbnail in parallel
    const [, thumbBuffer] = await Promise.all([
      new Upload({
        client: s3,
        params: { Bucket: BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype },
      }).done(),
      extractThumbnail(req.file.buffer, ext).catch(e => {
        console.warn('Thumbnail extraction failed:', e.message);
        return null;
      }),
    ]);

    // Upload thumbnail to R2 if extraction succeeded
    let thumbnailUrl = null;
    if (thumbBuffer) {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: 'image/jpeg',
      }));
      thumbnailUrl = `${THUMBNAIL_PUBLIC_URL}/${thumbKey}`;
    }

    const publicUrl = `${PUBLIC_URL}/${key}`;
    res.json({ success: true, url: publicUrl, thumbnailUrl, key, name: displayName(key), size: req.file.size });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/videos', async (req, res) => {
  try {
    const [videoData, thumbData] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' })),
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'thumbnails/' })),
    ]);
    const thumbSet = new Set((thumbData.Contents || []).map(o => o.Key.split('/').pop()));
    const items = (videoData.Contents || [])
      .filter(o => o.Key !== 'videos/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => {
        const base = o.Key.split('/').pop().replace(/\.[^.]+$/, '');
        const thumbFile = `${base}.jpg`;
        return {
          key: o.Key,
          url: `${PUBLIC_URL}/${o.Key}`,
          thumbnailUrl: `${THUMBNAIL_PUBLIC_URL}/thumbnails/${thumbFile}`,
          hasThumbnail: thumbSet.has(thumbFile),
          name: displayName(o.Key),
          size: o.Size,
          lastModified: o.LastModified,
        };
      });
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/export', async (req, res) => {
  try {
    const [videoData, thumbData] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' })),
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'thumbnails/' })),
    ]);
    const thumbSet = new Set((thumbData.Contents || []).map(o => o.Key.split('/').pop()));
    const rows = (videoData.Contents || [])
      .filter(o => o.Key !== 'videos/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => {
        const base = o.Key.split('/').pop().replace(/\.[^.]+$/, '');
        const thumbFile = `${base}.jpg`;
        const row = {
          'File Name': displayName(o.Key),
          'URL': `${PUBLIC_URL}/${o.Key}`,
          'Uploaded At': new Date(o.LastModified).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        };
        if (thumbSet.has(thumbFile)) row['Thumbnail URL'] = `${THUMBNAIL_PUBLIC_URL}/thumbnails/${thumbFile}`;
        return row;
      });

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 50 }, { wch: 80 }, { wch: 22 }, { wch: 80 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Videos');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="video-urls.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/videos/*key', async (req, res) => {
  try {
    const raw = req.params.key;
    const key = Array.isArray(raw) ? raw.join('/') : raw;
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    // Also delete associated thumbnail
    const base = key.split('/').pop().replace(/\.[^.]+$/, '');
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `thumbnails/${base}.jpg` })).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video uploader running at http://localhost:${PORT}`));
