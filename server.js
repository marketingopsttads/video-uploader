require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
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

// Paginate through all R2 objects under a prefix (ListObjectsV2 caps at 1000 per page)
async function listAll(prefix) {
  const items = [];
  let token;
  do {
    const params = { Bucket: BUCKET, Prefix: prefix };
    if (token) params.ContinuationToken = token;
    const res = await s3.send(new ListObjectsV2Command(params));
    items.push(...(res.Contents || []));
    token = res.IsTruncated ? res.NextContinuationToken : null;
  } while (token);
  return items;
}

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
const uploadImage = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
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
        params: { Bucket: BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype, Metadata: { 'original-name': originalName } },
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
    const [videoObjs, thumbObjs] = await Promise.all([
      listAll('videos/'),
      listAll('thumbnails/'),
    ]);
    const thumbSet = new Set(thumbObjs.map(o => o.Key.split('/').pop()));
    const items = videoObjs
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
    const [videoObjs, thumbObjs] = await Promise.all([
      listAll('videos/'),
      listAll('thumbnails/'),
    ]);
    const thumbSet = new Set(thumbObjs.map(o => o.Key.split('/').pop()));
    const videoObjects = videoObjs.filter(o => o.Key !== 'videos/').sort((a, b) => b.LastModified - a.LastModified);
    const metas = await Promise.all(videoObjects.map(o =>
      s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: o.Key })).catch(() => ({}))
    ));
    const rows = videoObjects.map((o, i) => {
      const base = o.Key.split('/').pop().replace(/\.[^.]+$/, '');
      const thumbFile = `${base}.jpg`;
      const originalName = metas[i]?.Metadata?.['original-name'] || '';
      const row = {
        'Uploaded File Name': displayName(o.Key),
        'Original File Name': originalName,
        'URL': `${PUBLIC_URL}/${o.Key}`,
        'Uploaded At': new Date(o.LastModified).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      };
      if (thumbSet.has(thumbFile)) row['Thumbnail URL'] = `${THUMBNAIL_PUBLIC_URL}/thumbnails/${thumbFile}`;
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 40 }, { wch: 50 }, { wch: 80 }, { wch: 22 }, { wch: 80 }];
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

app.delete('/videos', async (req, res) => {
  try {
    const [videoObjs, thumbObjs] = await Promise.all([
      listAll('videos/'),
      listAll('thumbnails/'),
    ]);
    const keys = [
      ...videoObjs.filter(o => o.Key !== 'videos/').map(o => o.Key),
      ...thumbObjs.map(o => o.Key),
    ];
    await Promise.all(keys.map(k => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })).catch(() => {})));
    res.json({ success: true, deleted: keys.length });
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

// ── Image endpoints ──────────────────────────────────────────────────────────

app.post('/upload-image', uploadImage.single('image'), async (req, res) => {
  try {
    const originalName = req.file.originalname;
    const ext = path.extname(originalName) || '.jpg';
    const shortName = originalName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 25).replace(/_+$/, '');
    const key = `images/${Date.now()}_${shortName}${ext}`;
    await new Upload({
      client: s3,
      params: { Bucket: BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype, Metadata: { 'original-name': originalName } },
    }).done();
    const publicUrl = `${PUBLIC_URL}/${key}`;
    res.json({ success: true, url: publicUrl, key, name: displayName(key), size: req.file.size });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/images', async (req, res) => {
  try {
    const imageObjs = await listAll('images/');
    const items = imageObjs
      .filter(o => o.Key !== 'images/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => ({
        key: o.Key,
        url: `${PUBLIC_URL}/${o.Key}`,
        name: displayName(o.Key),
        size: o.Size,
        lastModified: o.LastModified,
      }));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/export-images', async (req, res) => {
  try {
    const imageObjects = (await listAll('images/')).filter(o => o.Key !== 'images/').sort((a, b) => b.LastModified - a.LastModified);
    const metas = await Promise.all(imageObjects.map(o =>
      s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: o.Key })).catch(() => ({}))
    ));
    const rows = imageObjects.map((o, i) => ({
      'Uploaded File Name': displayName(o.Key),
      'Original File Name': metas[i]?.Metadata?.['original-name'] || '',
      'URL': `${PUBLIC_URL}/${o.Key}`,
      'Uploaded At': new Date(o.LastModified).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 40 }, { wch: 50 }, { wch: 80 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Images');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="image-urls.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/images', async (req, res) => {
  try {
    const keys = (await listAll('images/')).filter(o => o.Key !== 'images/').map(o => o.Key);
    await Promise.all(keys.map(k => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })).catch(() => {})));
    res.json({ success: true, deleted: keys.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/images/*key', async (req, res) => {
  try {
    const raw = req.params.key;
    const key = Array.isArray(raw) ? raw.join('/') : raw;
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video uploader running at http://localhost:${PORT}`));
