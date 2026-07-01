require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
    const ext = path.extname(req.file.originalname) || '.mp4';
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

    uploader.on('httpUploadProgress', (progress) => {
      // progress available if needed
    });

    await uploader.done();

    const publicUrl = `${PUBLIC_URL}/${key}`;
    res.json({ success: true, url: publicUrl, key, name: key.split('/').pop(), size: req.file.size });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/videos', async (req, res) => {
  try {
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' });
    const data = await s3.send(cmd);
    const items = (data.Contents || [])
      .filter(o => o.Key !== 'videos/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => ({
        key: o.Key,
        url: `${PUBLIC_URL}/${o.Key}`,
        name: o.Key.split('/').pop().replace(/^\d+_/, ''),
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
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' });
    const data = await s3.send(cmd);
    const rows = (data.Contents || [])
      .filter(o => o.Key !== 'videos/')
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(o => ({
        'File Name': o.Key.split('/').pop().replace(/^\d+_/, ''),
        'URL': `${PUBLIC_URL}/${o.Key}`,
      }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 40 }, { wch: 80 }];
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
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video uploader running at http://localhost:${PORT}`));
