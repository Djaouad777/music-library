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
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

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
          // head() isn't CDN-cached; the cache-busting query makes the read see the latest write
          const h = await blobSdk.head(key);
          const r = await fetch(h.url + '?cb=' + Date.now(), { cache: 'no-store' });
          return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
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
// No logins: anyone with the link can listen, upload, download and delete.
const need = () => (req, res, next) => next();

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.get('/api/config', (req, res) => res.json({ directUpload: USE_BLOB }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---- Vercel mode: the stored files themselves are the library ---- */
if (USE_BLOB) {
  const b64 = (u) => Buffer.from(u).toString('base64url');
  const urlOf = (id) => {
    try {
      const u = Buffer.from(String(id), 'base64url').toString();
      return /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/music\//.test(u) ? u : null;
    } catch { return null; }
  };
  const titleOf = (url) => {
    let n = decodeURIComponent(new URL(url).pathname.split('/').pop());
    n = n.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/-[A-Za-z0-9]{20,}$/, '');
    return n.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
  };
  const toTrack = (url, size, uploadedAt) => ({ id: b64(url), title: titleOf(url), size, addedAt: uploadedAt });

  app.get('/api/tracks', async (req, res) => {
    try {
      const out = [];
      let cursor;
      do {
        const page = await blobSdk.list({ prefix: 'music/', cursor, limit: 1000 });
        for (const x of page.blobs) out.push({ ...toTrack(x.url, x.size, x.uploadedAt), t: +new Date(x.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      out.sort((p, q) => q.t - p.t);
      res.json(out.map(({ t, ...rest }) => rest));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/tracks/register', (req, res) => {
    const { url, size } = req.body || {};
    if (!urlOf(b64(String(url)))) return res.status(400).json({ error: 'Bad upload' });
    res.json(toTrack(url, Number(size) || 0, new Date().toISOString()));
  });
  app.delete('/api/tracks/:id', async (req, res) => {
    const url = urlOf(req.params.id);
    if (!url) return res.status(404).json({ error: 'Not found' });
    try { await blobSdk.del(url); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/tracks/:id/file', (req, res) => {
    const url = urlOf(req.params.id);
    if (!url) return res.status(404).end();
    res.redirect(req.query.download === '1' ? url + '?download=1' : url);
  });
}

const publicTrack = (t) => {
  const { storageKey, ...rest } = t;
  return rest;
};
app.get('/api/tracks', need(), (req, res) => {
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

app.post('/api/tracks', need(), upload.array('files', 50), async (req, res) => {
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
        addedAt: new Date().toISOString(),
      };
      db.tracks.unshift(t);
      added.push(publicTrack(t));
    }
    await saveDb();
    res.json(added);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const findTrack = (id) => db.tracks.find((t) => t.id === id);

app.delete('/api/tracks/:id', need(), async (req, res) => {
  const i = db.tracks.findIndex((t) => t.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const [t] = db.tracks.splice(i, 1);
  await storage.del(t.storageKey);
  await saveDb();
  res.json({ ok: true });
});

// Vercel only: browser uploads straight to Blob (functions can't take big bodies)
app.post('/api/blob-upload', need(), async (req, res) => {
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
// stream / download
app.get('/api/tracks/:id/file', need(), async (req, res) => {
  const t = findTrack(req.params.id);
  if (!t) return res.status(404).end();
  const download = req.query.download === '1';
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
