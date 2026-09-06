'use strict';
// Workbench HTTP server (stdlib only, offline). Serves UI + JSON API:
// GET /api/health /api/agents /api/security /api/audit /api/kb?q=
// POST /api/tasks {prompt, files?}  POST /api/tasks/stream (SSE word-by-word)
// POST /api/documents {id,text}  POST /api/uploads {name, data}
const http = require('http');
const fs = require('fs');
const path = require('path');
const { RagIndex } = require('./rag');
const { AuditTrail } = require('./audit');
const { EgressGuard } = require('./egress');
const { Orchestrator } = require('./orchestrator');
// Optional deps (pg / bcryptjs) enable login + task history. The core
// agent is stdlib-only: when they are not installed (e.g. a fresh
// desktop-ZIP extract with no `npm install`), auth routes report 503
// and everything else — chat, RAG, sandbox, artefacts, audit, downloads —
// keeps working offline.
let initDb, getPool, auth;
try {
  ({ initDb, getPool } = require('./db'));
} catch (e) {
  initDb = async () => { throw new Error('optional dependency missing: pg (run `npm install` for login/history)'); };
  getPool = () => { throw new Error('user database unavailable'); };
}
try {
  auth = require('./auth');
} catch (e) {
  const needInstall = () => { throw Object.assign(new Error('auth unavailable — run `npm install` for login/history'), { status: 503 }); };
  auth = {
    providers: () => ({ google: false, github: false }),
    register: needInstall, login: needInstall, createSession: needInstall,
    userFromToken: async () => null, destroySession: async () => {},
    oauthStart: needInstall, oauthCallback: needInstall,
    sessionCookie: () => '', clearCookie: () => '', readCookie: () => null,
  };
}

// PostgreSQL (users, sessions, task history). Auth routes wait for it;
// the rest of the workbench keeps working even if the DB is down.
const dbReady = initDb().catch((e) => {
  console.error('PostgreSQL unavailable — auth disabled:', (e && e.message) || e);
  return null;
});
async function needDb(res) {
  const pool = await dbReady;
  if (!pool) { send(res, 503, { ok: false, error: 'user database unavailable' }); return null; }
  return pool;
}

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'out');
const PUB = path.join(ROOT, 'public');
const UPLOADS = path.join(DATA, 'uploads');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const rag = new RagIndex();
const audit = new AuditTrail(path.join(DATA, 'audit.jsonl'));
const egress = new EgressGuard();
const { PermissionManager } = require('./permissions');
const permissions = new PermissionManager({ filePath: path.join(DATA, 'permissions.json'), audit });
const orch = new Orchestrator({ rag, audit, egress, outDir: OUT, permissions });

// Seed KB from data/*.txt + data/*.md if present
try {
  for (const f of fs.readdirSync(DATA)) {
    if (/\.(txt|md)$/i.test(f)) {
      rag.upsert(f.replace(/\.\w+$/, ''), fs.readFileSync(path.join(DATA, f), 'utf8'));
    }
  }
} catch {}
if (rag.count() === 0) {
  rag.upsert('sop-welding', 'Welding inspection SOP: visual check + dye penetrant. Defect code W-12. Accept if defect rate < 10%. Torque calibration every 90 days.');
  rag.upsert('sop-safety', 'Safety SOP: isolate pressure vessels before inspection. PPE required. Pressure limit 6 bar.');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.sha256': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

// ---- Desktop downloads: dist/SwarajAI-desktop-*.zip built by scripts/package-desktop.js ----
function listDesktopBuilds() {
  try {
    const manifestPath = path.join(DIST, 'latest.json');
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Refresh byte counts in case dist was rebuilt without restarting the server.
      for (const f of (m.files || [])) {
        try {
          const fp = path.join(DIST, path.basename(f.name));
          if (fs.existsSync(fp)) f.bytes = fs.statSync(fp).size;
        } catch {}
      }
      return { ok: true, manifest: true, ...m };
    }
  } catch {}
  // Fallback: live directory listing when no manifest was built yet.
  let files = [];
  try {
    files = fs.existsSync(DIST) ? fs.readdirSync(DIST).filter((f) => /^SwarajAI-desktop-.*\.zip$/.test(f)).sort().reverse() : [];
  } catch { files = []; }
  let version = '0.1.0';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version; } catch {}
  return {
    ok: true, manifest: false, name: 'Swaraj AI — Desktop', version, builtAt: null,
    requires: { node: '>=18', disk: '~300MB free', network: 'none (offline after install)' },
    note: files.length ? undefined : 'No build yet — run: npm run package:desktop',
    files: files.map((name) => {
      const fp = path.join(DIST, name);
      let bytes = 0;
      try { bytes = fs.statSync(fp).size; } catch {}
      let sha256 = null;
      try {
        const sidecar = fp + '.sha256';
        if (fs.existsSync(sidecar)) sha256 = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] || null;
      } catch {}
      return { name, url: `/download/${encodeURIComponent(name)}`, bytes, sha256, platforms: ['windows', 'linux', 'macos'], universal: true };
    }),
    launchers: { windows: 'SwarajAI.bat (or Start-SwarajAI.ps1)', linux: './SwarajAI.sh', macos: './SwarajAI.sh' },
  };
}

function send(res, code, body, type = 'application/json') {
  let b;
  if (Buffer.isBuffer(body)) b = body;
  else if (typeof body === 'string') b = Buffer.from(body, 'utf8');
  else b = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': b.length });
  res.end(b);
}

function readBody(req, maxBytes = 12e6) {
  return new Promise((resolve) => {
    let s = '';
    let killed = false;
    req.on('data', (d) => {
      if (killed) return;
      s += d;
      if (s.length > maxBytes) { killed = true; try { req.destroy(); } catch {} resolve(null); }
    });
    req.on('end', () => { if (killed) return; try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    req.on('error', () => { if (!killed) resolve({}); });
  });
}

const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif']);
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

function sanitizeName(n) {
  const base = path.basename(String(n || 'image.png')).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'image.png';
  return base;
}

function resolveUploadRef(ref) {
  // Accepts {name} (stored upload id), {path} (legacy server path), or string.
  // Returns absolute path inside UPLOADS/DATA, or null if unsafe/missing.
  let key = null;
  if (typeof ref === 'string') key = ref;
  else if (ref && typeof ref.name === 'string' && !ref.path && !ref.text) key = ref.name;
  else if (ref && typeof ref.path === 'string') {
    const p = ref.path;
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.join(UPLOADS, path.basename(p));
    if ((abs === UPLOADS || abs.startsWith(UPLOADS + path.sep) || abs.startsWith(DATA + path.sep)) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    // also allow legacy data/ relative names
    const alt = path.join(DATA, path.basename(p));
    if (fs.existsSync(alt) && fs.statSync(alt).isFile()) return alt;
    return null;
  } else return null;
  if (!key) return null;
  const abs = path.join(UPLOADS, path.basename(key));
  if (!abs.startsWith(UPLOADS + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, local: true, kb: rag.count() });
    if (req.method === 'GET' && url.pathname === '/api/agents') return send(res, 200, { agents: [{ id: 'opencode-local-agent', models: ['llama3.2:1b', 'qwen2.5-coder:1.5b', 'moondream'] }] });
    if (req.method === 'GET' && url.pathname === '/api/kb') {
      const q = url.searchParams.get('q') || '';
      return send(res, 200, { query: q, hits: q ? rag.search(q, 5) : [], count: rag.count() });
    }
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const all = audit.readAll().slice(-100);
      return send(res, 200, { count: all.length, verify: audit.verify(), records: all });
    }
    if (req.method === 'GET' && url.pathname === '/api/security') {
      return send(res, 200, {
        zeroEgress: true, externalLLM: 0, remoteMCP: 0,
        externalAPI: egress.scanConfig({}).length,
        cloudKeys: egress.scanEnv(),
        queuedDenials: egress.events.length,
      });
    }
    // ---- Permissions (opencode-style: allow once / allow always / reject) ----
    if (req.method === 'GET' && url.pathname === '/api/permissions/policy') {
      return send(res, 200, { ok: true, ...permissions.listPolicy() });
    }
    if (req.method === 'GET' && url.pathname === '/api/permissions/pending') {
      return send(res, 200, { ok: true, pending: permissions.listPending() });
    }
    if (req.method === 'POST' && url.pathname === '/api/permissions/respond') {
      const b = await readBody(req);
      if (b === null) return send(res, 400, { ok: false, error: 'payload too large' });
      try {
        const r = permissions.respond(b.requestId, b.decision);
        return send(res, 200, { ok: true, ...r });
      } catch (e) {
        return send(res, e.code === 'PERMISSION_NOT_FOUND' ? 404 : 400, { ok: false, error: e.message, code: e.code });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/permissions/revoke') {
      const b = await readBody(req);
      if (!b || !b.ruleId) return send(res, 400, { ok: false, error: 'need {ruleId}' });
      const ok = permissions.revoke(b.ruleId);
      return send(res, ok ? 200 : 404, { ok, ruleId: b.ruleId });
    }
    if (req.method === 'POST' && url.pathname === '/api/permissions/reset') {
      permissions.clear();
      return send(res, 200, { ok: true });
    }
    // ---- Local machine (direct APIs; each waits for permission like the agent) ----
    const permErr = (e) => {
      const code = e && e.code;
      if (code === 'PERMISSION_DENIED') return send(res, 403, { ok: false, error: e.message, code, tool: e.tool, scope: e.scope, requestId: e.requestId });
      if (code === 'PERMISSION_TIMEOUT') return send(res, 408, { ok: false, error: e.message, code, requestId: e.requestId });
      return send(res, 400, { ok: false, error: String((e && e.message) || e).slice(0, 500) });
    };
    if (req.method === 'POST' && url.pathname === '/api/local/search') {
      const b = await readBody(req);
      if (b === null) return send(res, 400, { ok: false, error: 'payload too large' });
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.local_search(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/list') {
      const b = await readBody(req);
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.local_list(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/read') {
      const b = await readBody(req);
      if (!b || (!b.path && !b.file)) return send(res, 400, { ok: false, error: 'need {path}' });
      try {
        orch.tools.__setProg(null);
        const isOffice = /\.(docx|xlsx|pptx)$/i.test(b.path || b.file || '');
        const r = isOffice ? await orch.tools.office_read(b) : await orch.tools.local_read(b);
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/office-create') {
      const b = await readBody(req);
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.office_create(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/office-modify') {
      const b = await readBody(req);
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.office_modify(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/write') {
      const b = await readBody(req);
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.local_write(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/exec') {
      const b = await readBody(req);
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.shell_exec(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/open') {
      const b = await readBody(req);
      try {
        orch.tools.__setProg(null);
        const r = await orch.tools.open_path(b || {});
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return permErr(e); }
    }
    if (req.method === 'GET' && url.pathname === '/api/artifacts') {
      const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => !f.startsWith('.'))
        .map((f) => ({ name: f, bytes: fs.statSync(path.join(OUT, f)).size })) : [];
      return send(res, 200, { count: files.length, files });
    }
    if (req.method === 'GET' && (url.pathname === '/api/download' || url.pathname === '/api/download/latest.json')) {
      return send(res, 200, listDesktopBuilds());
    }
    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice('/download/'.length)));
      // Strict allowlist: only our desktop builds + manifest + checksums.
      const okName = /^SwarajAI-desktop-v[\w.]+\.zip$/.test(name)
        || /^SwarajAI-desktop-v[\w.]+\.zip\.sha256$/.test(name)
        || name === 'latest.json';
      if (!okName) return send(res, 404, { ok: false, error: 'not found' });
      const fp = path.join(DIST, name);
      if (!fp.startsWith(DIST + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        return send(res, 404, { ok: false, error: 'no desktop build yet — run: npm run package:desktop' });
      }
      const ext = name.endsWith('.sha256') ? '.sha256' : path.extname(fp).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': fs.statSync(fp).size,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/artifact/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice('/artifact/'.length)));
      const fp = path.join(OUT, name);
      if (!name || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'Content-Length': fs.statSync(fp).size, 'Content-Disposition': `attachment; filename="${name}"` });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/uploads') {
      const b = await readBody(req);
      if (b === null) return send(res, 413, { ok: false, error: 'payload too large (max ~8MB JSON)' });
      const origName = sanitizeName(b && (b.name || b.filename));
      const ext = path.extname(origName).toLowerCase() || '.png';
      if (!IMG_EXTS.has(ext)) return send(res, 400, { ok: false, error: 'only images allowed: png/jpg/webp/gif/bmp/tiff' });
      let data = (b && (b.data || b.base64 || '')) + '';
      if (!data) return send(res, 400, { ok: false, error: 'need {name, data} with base64 image' });
      const comma = data.indexOf(',');
      if (data.startsWith('data:') && comma !== -1) data = data.slice(comma + 1);
      data = data.replace(/\s+/g, '');
      let buf;
      try { buf = Buffer.from(data, 'base64'); } catch { return send(res, 400, { ok: false, error: 'invalid base64' }); }
      if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return send(res, 400, { ok: false, error: buf.length ? 'image too large (max 6MB)' : 'empty image' });
      const stored = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${origName}`;
      const fp = path.join(UPLOADS, stored);
      fs.writeFileSync(fp, buf);
      try { audit.append({ event: 'image_uploaded', file: stored, orig: origName, bytes: buf.length }); } catch {}
      return send(res, 200, { ok: true, file: { name: stored, origName, bytes: buf.length, url: `/uploads/${encodeURIComponent(stored)}` } });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice('/uploads/'.length)));
      const fp = path.join(UPLOADS, name);
      if (!name || !fp.startsWith(UPLOADS + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, { ok: false, error: 'not found' });
      return send(res, 200, fs.readFileSync(fp), IMG_MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/providers') {
      return send(res, 200, { ok: true, ...auth.providers() });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      if (!await needDb(res)) return;
      const b = await readBody(req);
      try {
        const user = await auth.register(b || {});
        const token = await auth.createSession(user.id);
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        try { audit.append({ event: 'user_registered', user: user.email }); } catch {}
        return send(res, 201, { ok: true, user });
      } catch (e) { return send(res, e.status || 500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!await needDb(res)) return;
      const b = await readBody(req);
      try {
        const user = await auth.login(b || {});
        const token = await auth.createSession(user.id);
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        try { audit.append({ event: 'user_login', user: user.email }); } catch {}
        return send(res, 200, { ok: true, user });
      } catch (e) { return send(res, e.status || 500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (await dbReady) await auth.destroySession(auth.readCookie(req)).catch(() => {});
      res.setHeader('Set-Cookie', auth.clearCookie());
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!await needDb(res)) return;
      const user = await auth.userFromToken(auth.readCookie(req));
      if (!user) return send(res, 401, { ok: false, error: 'not signed in' });
      return send(res, 200, { ok: true, user });
    }
    if (req.method === 'GET' && (url.pathname === '/api/auth/google' || url.pathname === '/api/auth/github')) {
      const provider = url.pathname.endsWith('google') ? 'google' : 'github';
      try { res.writeHead(302, { Location: auth.oauthStart(provider) }); res.end(); return; }
      catch (e) { return send(res, e.status || 500, { ok: false, error: e.message }); }
    }
    if (req.method === 'GET' && (url.pathname === '/api/auth/google/callback' || url.pathname === '/api/auth/github/callback')) {
      if (!await needDb(res)) return;
      const provider = url.pathname.includes('google') ? 'google' : 'github';
      try {
        const user = await auth.oauthCallback(provider, { code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        const token = await auth.createSession(user.id);
        try { audit.append({ event: 'user_login', user: user.email, via: provider }); } catch {}
        res.writeHead(302, { Location: '/workbench.html', 'Set-Cookie': auth.sessionCookie(token) });
        res.end(); return;
      } catch (e) {
        res.writeHead(302, { Location: '/workbench.html?auth_error=' + encodeURIComponent(e.message) });
        res.end(); return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks/mine') {
      const pool = await needDb(res); if (!pool) return;
      const user = await auth.userFromToken(auth.readCookie(req));
      if (!user) return send(res, 401, { ok: false, error: 'sign in to see your history' });
      const { rows } = await pool.query(
        'SELECT kind, prompt, verdict, route, model, created_at FROM user_tasks WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [user.id]);
      return send(res, 200, { ok: true, tasks: rows });
    }
    if (req.method === 'POST' && url.pathname === '/api/documents') {
      const b = await readBody(req);
      if (!b.id || !b.text) return send(res, 400, { ok: false, error: 'need {id,text}' });
      rag.upsert(b.id, b.text);
      audit.append({ event: 'document_parsed', doc: b.id });
      return send(res, 200, { ok: true, count: rag.count() });
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks/stream') {
      const b = await readBody(req);
      if (b === null) return send(res, 400, { ok: false, error: 'payload too large' });
      const rawFiles = Array.isArray(b.files) ? b.files : (Array.isArray(b.images) ? b.images : []);
      const files = [];
      for (const f of rawFiles) {
        if (f && typeof f.text === 'string') { files.push({ name: sanitizeName(f.name || 'inline.txt'), text: f.text }); continue; }
        const abs = resolveUploadRef(f);
        if (abs) files.push({ path: abs, name: path.basename(abs) });
      }
      let prompt = typeof b.prompt === 'string' ? b.prompt : '';
      if (!prompt.trim() && files.length === 0) return send(res, 400, { ok: false, error: 'need {prompt} and/or uploaded image files' });
      if (!prompt.trim()) prompt = 'Describe this image in detail and flag any weld defects, corrosion, cracks, or safety issues.';
      // Server-sent events: {t:'kind'|'step'|'token'} … then {t:'done', result} or {t:'error'}.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      if (res.flushHeaders) { try { res.flushHeaders(); } catch {} }
      const sendEv = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      try {
        const r = await orch.runTask({ prompt, files, prog: sendEv });
        sendEv({ t: 'done', result: r });
      } catch (e) {
        sendEv({ t: 'error', error: String((e && e.message) || e).slice(0, 300) });
      } finally {
        clearInterval(hb);
        try { res.end(); } catch {}
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const b = await readBody(req);
      if (b === null) return send(res, 400, { ok: false, error: 'payload too large' });
      const rawFiles = Array.isArray(b.files) ? b.files : (Array.isArray(b.images) ? b.images : []);
      const files = [];
      for (const f of rawFiles) {
        if (f && typeof f.text === 'string') { files.push({ name: sanitizeName(f.name || 'inline.txt'), text: f.text }); continue; }
        const abs = resolveUploadRef(f);
        if (abs) files.push({ path: abs, name: path.basename(abs) });
      }
      let prompt = typeof b.prompt === 'string' ? b.prompt : '';
      if (!prompt.trim() && files.length === 0) return send(res, 400, { ok: false, error: 'need {prompt} and/or uploaded image files' });
      if (!prompt.trim()) prompt = 'Describe this image in detail and flag any weld defects, corrosion, cracks, or safety issues.';
      const r = await orch.runTask({ prompt, files });
      dbReady.then(async (pool) => {
        if (!pool) return;
        try {
          const user = await auth.userFromToken(auth.readCookie(req)).catch(() => null);
          await pool.query(
            'INSERT INTO user_tasks (user_id, kind, prompt, verdict, route, model) VALUES ($1,$2,$3,$4,$5,$6)',
            [user ? user.id : null, r.kind || 'job', prompt.slice(0, 2000), r.verdict || '', (r.route && r.route.route) || '', (r.replyModel || (r.route && r.route.model)) || '']);
        } catch {}
      });
      return send(res, 200, r);
    }
    // static
    let fp = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!fp.startsWith(PUB)) return send(res, 403, 'denied', 'text/plain');
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'application/octet-stream');
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

if (require.main === module) {
  const wanted = parseInt(process.env.PORT || '8080', 10);
  const hosts = ['127.0.0.1'];
  let port = wanted;
  const tryListen = () => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && port < wanted + 10) {
        port += 1;
        tryListen();
      } else {
        console.error(`FAILED to bind 127.0.0.1:${port}: ${e.message}`);
        console.error('Fix: stop the other process or set PORT env, e.g. $env:PORT=8081; npm start');
        process.exit(1);
      }
    });
    server.listen(port, '127.0.0.1', () => console.log(`Swaraj AI workbench (local-only) on http://127.0.0.1:${port}`));
  };
  tryListen();
}
module.exports = { server, rag, audit, egress, orch, permissions, listDesktopBuilds, DIST };
