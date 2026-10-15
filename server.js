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
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SB_BUCKET = process.env.SUPABASE_BUCKET || 'music';
const USE_SUPABASE = !!(SB_URL && SB_KEY);

if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set, using default "admin".');

/* ---------------- storage drivers ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');

const sbHeaders = (extra = {}) => ({ Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, ...extra });
const sbObj = (key) => `${SB_URL}/storage/v1/object/${SB_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

const storage = USE_SUPABASE
  ? {
      async init() {
        await fetch(`${SB_URL}/storage/v1/bucket`, {
          method: 'POST',
          headers: sbHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: SB_BUCKET, name: SB_BUCKET, public: false }),
        }).catch(() => {});
      },
      async put(key, buf, type) {
        const r = await fetch(sbObj(key), {
          method: 'POST',
          headers: sbHeaders({ 'Content-Type': type || 'application/octet-stream', 'x-upsert': 'true' }),
          body: buf,
        });
        if (!r.ok) throw new Error(`Storage upload failed: ${r.status} ${await r.text()}`);
      },
      async get(key) {
        const r = await fetch(sbObj(key), { headers: sbHeaders() });
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      },
      async del(key) {
        await fetch(sbObj(key), { method: 'DELETE', headers: sbHeaders() }).catch(() => {});
      },
      // returns {redirect} for the HTTP layer
      async serve(res, key, { download, filename }) {
        const r = await fetch(
          `${SB_URL}/storage/v1/object/sign/${SB_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`,
          { method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 3600 }) }
        );
        if (!r.ok) return res.status(404).end();
        const { signedURL } = await r.json();
        let url = `${SB_URL}/storage/v1${signedURL}`;
        if (download) url += `&download=${encodeURIComponent(filename)}`;
        res.redirect(url);
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
  const m = (req.headers.cookie || '').match(/(?:^|;s*)admin=([^;]+)/);
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

(async () => {
  await storage.init();
  await loadDb();
  app.listen(PORT, () => console.log(`Music library running on http://localhost:${PORT}  (storage: ${USE_SUPABASE ? 'Supabase' : 'local disk'})`));
})();
