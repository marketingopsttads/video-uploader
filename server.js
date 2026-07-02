require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('path');
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
const FILENAMES_KEY = 'filenames.json';

async function loadFilenames() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: FILENAMES_KEY }));
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    return {};
  }
}

async function saveFilenames(map) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: FILENAMES_KEY,
    Body: JSON.stringify(map),
    ContentType: 'application/json',
  }));
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const originalName = req.file.originalname;
    const ext = path.extname(originalName) || '.mp4';
    const key = `videos/${Date.now()}${ext}`;

    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      },
    });

    await uploader.done();

    // Persist original filename mapping
    const map = await loadFilenames();
    map[key] = originalName;
    await saveFilenames(map);

    const publicUrl = `${PUBLIC_URL}/${key}`;
    res.json({ success: true, url: publicUrl, key, name: originalName, size: req.file.size });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/videos', async (req, res) => {
  try {
    const [listData, filenameMap] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' })),
      loadFilenames(),
    ]);
    const items = (listData.Contents || [])
      .filter(o => o.Key !== 'videos/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => ({
        key: o.Key,
        url: `${PUBLIC_URL}/${o.Key}`,
        name: filenameMap[o.Key] || o.Key.split('/').pop(),
        size: o.Size,
        lastModified: o.LastModified,
      }));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/export', async (req, res) => {
  try {
    const [listData, filenameMap] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' })),
      loadFilenames(),
    ]);
    const rows = (listData.Contents || [])
      .filter(o => o.Key !== 'videos/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => ({
        'File Name': filenameMap[o.Key] || o.Key.split('/').pop(),
        'URL': `${PUBLIC_URL}/${o.Key}`,
      }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 50 }, { wch: 80 }];
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
    const key = req.params.key;
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    // Remove from filename map
    const map = await loadFilenames();
    delete map[key];
    await saveFilenames(map);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video uploader running at http://localhost:${PORT}`));
