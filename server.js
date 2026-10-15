const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Load .env (tiny parser, no dependency)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set, using default "admin".');

/* ---------------- storage drivers ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');

const blobSdk = USE_BLOB ? require('@vercel/blob') : null;

const storage = USE_BLOB
  ? {
      async init() {},
      // small JSON metadata only (db.json); audio goes browser -> Blob directly
      async put(key, buf, type) {
        await blobSdk.put(key, buf, { access: 'public', allowOverwrite: true, addRandomSuffix: false, contentType: type, cacheControlMaxAge: 60 });
      },
      async get(key) {
        try {
          const r = await blobSdk.get(key, { access: 'public', useCache: false });
          if (!r || r.statusCode !== 200) return null;
          return Buffer.from(await new Response(r.stream).arrayBuffer());
        } catch { return null; }
      },
      async del(key) {
        await blobSdk.del(key).catch(() => {});
      },
      async serve(res, key, { download }) {
        res.redirect(download ? key + (key.includes('?') ? '&' : '?') + 'download=1' : key);
      },
    }
  : {
      async init() {
        await fsp.mkdir(FILES_DIR, { recursive: true });
      },
      async put(key, buf) {
        const p = path.join(DATA_DIR, key);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, buf);
      },
      async get(key) {
        try { return await fsp.readFile(path.join(DATA_DIR, key)); } catch { return null; }
      },
      async del(key) {
        await fsp.rm(path.join(DATA_DIR, key), { force: true });
      },
      async serve(res, key, { download, filename }) {
        const p = path.join(DATA_DIR, key);
        if (!fs.existsSync(p)) return res.status(404).end();
        if (download) return res.download(p, filename);
        res.sendFile(p); // supports Range requests so the player can seek
      },
    };

/* ---------------- metadata (one JSON document) ---------------- */
const DB_KEY = 'db.json';
let db = { tracks: [] };
let writeChain = Promise.resolve();

async function loadDb() {
  const buf = await storage.get(DB_KEY);
  if (buf) db = JSON.parse(buf.toString('utf8'));
  if (!Array.isArray(db.tracks)) db.tracks = [];
}
function saveDb() {
  writeChain = writeChain.then(() => storage.put(DB_KEY, Buffer.from(JSON.stringify(db, null, 2)), 'application/json'));
  return writeChain;
}

/* ---------------- auth ---------------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function getRole(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)admin=([^;]+)/);
  return m && safeEq(decodeURIComponent(m[1]), sign('admin')) ? 'admin' : 'client';
}
const need = (...roles) => (req, res, next) => {
  const role = getRole(req);
  if (!roles.includes(role)) return res.status(403).json({ error: 'Forbidden' });
  req.role = role;
  next();
};

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
if (USE_BLOB) {
  app.use('/api', async (req, res, next) => {
    try { await loadDb(); next(); } catch (e) { next(e); }
  });
}
app.get('/api/config', (req, res) => res.json({ directUpload: USE_BLOB }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin = open the secret link /admin/<ADMIN_PASSWORD> once; it sets a cookie. Everyone else is a client.
app.get('/admin/:key', (req, res) => {
  if (!safeEq(req.params.key, ADMIN_PASSWORD)) return res.status(404).send('Not found');
  res.setHeader('Set-Cookie', `admin=${encodeURIComponent(sign('admin'))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}${req.secure ? '; Secure' : ''}`);
  res.redirect('/');
});
app.post('/api/exit-admin', (req, res) => {
  res.setHeader('Set-Cookie', 'admin=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ role: getRole(req) }));

const publicTrack = (t) => {
  const { storageKey, ...rest } = t;
  return rest;
};
app.get('/api/tracks', need('admin', 'client'), (req, res) => {
  res.json(db.tracks.map(publicTrack));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^audio\//.test(file.mimetype) || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.originalname)),
});

const cleanTitle = (name) =>
  path.parse(name).name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
// multer decodes filenames as latin1; fix UTF-8 names
const fixName = (n) => Buffer.from(n, 'latin1').toString('utf8');

app.post('/api/tracks', need('admin'), upload.array('files', 50), async (req, res) => {
  try {
    const added = [];
    for (const f of req.files || []) {
      const original = fixName(f.originalname);
      const id = crypto.randomUUID();
      const ext = path.extname(original).toLowerCase() || '.mp3';
      const storageKey = `files/${id}${ext}`;
      await storage.put(storageKey, f.buffer, f.mimetype);
      const t = {
        id,
        title: cleanTitle(original),
        artist: '',
        tags: '',
        filename: original,
        storageKey,
        size: f.size,
        status: 'pending',
        comment: '',
        addedAt: new Date().toISOString(),
        reviewedAt: null,
      };
      db.tracks.unshift(t);
      added.push(publicTrack(t, 'admin'));
    }
    await saveDb();
    res.json(added);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const findTrack = (id) => db.tracks.find((t) => t.id === id);

app.patch('/api/tracks/:id', need('admin'), async (req, res) => {
  const t = findTrack(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  for (const k of ['title', 'artist', 'tags']) if (typeof req.body[k] === 'string') t[k] = req.body[k].slice(0, 200);
  if (['pending', 'approved', 'rejected'].includes(req.body.status)) {
    t.status = req.body.status;
    t.reviewedAt = t.status === 'pending' ? null : new Date().toISOString();
  }
  await saveDb();
  res.json(publicTrack(t, 'admin'));
});

// Client (or admin) review: approve / reject / reset with optional comment
app.post('/api/tracks/:id/review', need('admin', 'client'), async (req, res) => {
  const t = findTrack(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { status, comment } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  t.status = status;
  if (typeof comment === 'string') t.comment = comment.slice(0, 500);
  t.reviewedAt = status === 'pending' ? null : new Date().toISOString();
  await saveDb();
  res.json(publicTrack(t, req.role));
});

app.post('/api/review-all', need('client', 'admin'), async (req, res) => {
  const status = req.body && req.body.status;
  if (status !== 'approved') return res.status(400).json({ error: 'Bad status' });
  const now = new Date().toISOString();
  for (const t of db.tracks) if (t.status === 'pending') { t.status = 'approved'; t.reviewedAt = now; }
  await saveDb();
  res.json(db.tracks.map((t) => publicTrack(t, req.role)));
});

app.delete('/api/tracks/:id', need('admin'), async (req, res) => {
  const i = db.tracks.findIndex((t) => t.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const [t] = db.tracks.splice(i, 1);
  await storage.del(t.storageKey);
  await saveDb();
  res.json({ ok: true });
});

// Vercel only: browser uploads straight to Blob (functions can't take big bodies)
app.post('/api/blob-upload', need('admin'), async (req, res) => {
  try {
    const { handleUpload } = require('@vercel/blob/client');
    const json = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['audio/*'],
        maximumSizeInBytes: 200 * 1024 * 1024,
        addRandomSuffix: true,
      }),
    });
    res.json(json);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/tracks/register', need('admin'), async (req, res) => {
  const { url, filename, size } = req.body || {};
  if (!USE_BLOB || typeof url !== 'string' || !/^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(url)) return res.status(400).json({ error: 'Bad upload' });
  const t = {
    id: crypto.randomUUID(),
    title: cleanTitle(String(filename || 'Untitled')),
    artist: '', tags: '',
    filename: String(filename || 'track.mp3'),
    storageKey: url,
    size: Number(size) || 0,
    status: 'pending', comment: '',
    addedAt: new Date().toISOString(), reviewedAt: null,
  };
  db.tracks.unshift(t);
  await saveDb();
  res.json(publicTrack(t));
});

// stream (both roles) / download (admin only)
app.get('/api/tracks/:id/file', need('admin', 'client'), async (req, res) => {
  const t = findTrack(req.params.id);
  if (!t) return res.status(404).end();
  const download = req.query.download === '1';
  if (download && req.role !== 'admin') return res.status(403).json({ error: 'Only admin can download' });
  const ext = path.extname(t.filename) || '.mp3';
  const filename = (t.title || path.parse(t.filename).name).replace(/[\\/:*?"<>|]/g, '') + ext;
  await storage.serve(res, t.storageKey, { download, filename });
});

const ready = (async () => {
  await storage.init();
  await loadDb();
})();

if (process.env.VERCEL) {
  module.exports = app; // Vercel runs it as a serverless function
} else {
  ready.then(() => app.listen(PORT, () => console.log(`Music library running on http://localhost:${PORT}  (storage: ${USE_BLOB ? 'Vercel Blob' : 'local disk'})`)));
}
