'use strict';
// Local-machine access: file search + Office read/modify + machine control.
// All stdlib-only, offline. Every mutating / out-of-workspace operation is
// meant to run behind PermissionManager.guard() — this module itself is the
// *mechanism*, permissions.js is the *policy*.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const deliver = require('./deliver');

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information',
  '$windows.~bt', '$windows.~ws', 'recovery', 'pagefile.sys', '__pycache__',
]);

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.js', '.ts', '.py']);
const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx']);
const MAX_READ_BYTES = 2 * 1024 * 1024;

function safeResolve(p) {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p);
  return abs;
}

function isOffice(p) { return OFFICE_EXTS.has(path.extname(String(p)).toLowerCase()); }
function isTextLike(p) {
  const e = path.extname(String(p)).toLowerCase();
  return TEXT_EXTS.has(e) || e === '' || /\.docx?$/i.test(p) === false && OFFICE_EXTS.has(e) === false && e.length <= 5;
}

// ---------- minimal ZIP reader (local-header walk, stdlib) ----------
function readZipEntries(buf) {
  // Returns [{ name, method, data: Buffer(decompressed) }]. Supports stored +
  // deflated entries without data-descriptors (covers Word/Excel/PowerPoint).
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig === 0x02014b50 || sig === 0x06054b50) break; // central dir / EOCD
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const flags = buf.readUInt16LE(off + 6);
    const compLen = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compLen;
    if (dataEnd > buf.length) break;
    const comp = buf.subarray(dataStart, dataEnd);
    let data;
    try {
      if (method === 0) data = Buffer.from(comp);
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else data = Buffer.from(comp); // unknown method: keep raw
    } catch { data = Buffer.alloc(0); }
    entries.push({ name, method, data, hasDescriptor: !!(flags & 0x08) });
    off = dataEnd;
  }
  return entries;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function unescXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// ---------- Office text extraction ----------
function docxText(xml) {
  const out = [];
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(unescXml(m[1]));
  // Paragraph breaks: split on </w:p>
  const paras = xml.split(/<\/w:p>/).map((chunk) => {
    const ts = [];
    const r2 = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m2;
    while ((m2 = r2.exec(chunk)) !== null) ts.push(unescXml(m2[1]));
    return ts.join('');
  }).filter((t) => t.length);
  return { full: out.join(''), paragraphs: paras };
}

function xlsxText(sheetXml, sstXml) {
  const strings = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(sstXml)) !== null) {
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm; const parts = [];
    while ((tm = tRe.exec(m[1])) !== null) parts.push(unescXml(tm[1]));
    strings.push(parts.join(''));
  }
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  while ((m = rowRe.exec(sheetXml)) !== null) {
    const cells = [];
    // NOTE: `<c ... t="s">` must be parsed in two steps — a single lazy
    // `<c[^>]*?(t="..")?[^>]*>` never captures the optional group because the
    // lazy prefix + greedy suffix conspire to skip it.
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(m[1])) !== null) {
      const tag = cm[1] || '';
      const tmAttr = /\bt="([^"]*)"/.exec(tag);
      const t = tmAttr ? tmAttr[1] : '';
      const inner = cm[2] || '';
      if (t === 's') {
        const vm = /<v>(-?\d+)<\/v>/.exec(inner);
        cells.push(vm ? (strings[parseInt(vm[1], 10)] ?? '') : '');
      } else if (t === 'inlineStr') {
        const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        cells.push(tm ? unescXml(tm[1]) : '');
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        cells.push(vm ? vm[1] : '');
      }
    }
    rows.push(cells);
  }
  const full = rows.map((r) => r.join(' | ')).join('\n');
  return { rows, full };
}

function pptxText(slideXml) {
  const out = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(slideXml)) !== null) out.push(unescXml(m[1]));
  return { full: out.join('\n'), paragraphs: out };
}

function readOfficeText(absPath) {
  const buf = fs.readFileSync(absPath);
  const entries = readZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e.data.toString('utf8')]));
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.docx') {
    const xml = byName.get('word/document.xml') || '';
    const { full, paragraphs } = docxText(xml);
    return { kind: 'docx', text: full, paragraphs, entryCount: entries.length };
  }
  if (ext === '.xlsx') {
    const sheet = byName.get('xl/worksheets/sheet1.xml') || '';
    const sst = byName.get('xl/sharedStrings.xml') || '';
    const { rows, full } = xlsxText(sheet, sst);
    return { kind: 'xlsx', text: full, rows, entryCount: entries.length };
  }
  if (ext === '.pptx') {
    const slide = byName.get('ppt/slides/slide1.xml') || '';
    const { full, paragraphs } = pptxText(slide);
    return { kind: 'pptx', text: full, paragraphs, entryCount: entries.length };
  }
  throw new Error('not an office file: ' + absPath);
}

// ---------- Office modify (append/replace) ----------
function modifyDocx(absPath, { append = [], replace = null, outPath = null } = {}) {
  const buf = fs.readFileSync(absPath);
  const entries = readZipEntries(buf);
  const idx = entries.findIndex((e) => e.name === 'word/document.xml');
  if (idx === -1) throw new Error('word/document.xml not found — not a valid .docx');
  let xml = entries[idx].data.toString('utf8');
  if (replace) {
    const pairs = Array.isArray(replace) ? replace : [replace];
    for (const { from, to } of pairs) {
      if (!from) continue;
      xml = xml.split(escXml(String(from))).join(escXml(String(to ?? '')));
      // also try raw (in case stored unescaped ascii)
      xml = xml.split(String(from)).join(escXml(String(to ?? '')));
    }
  }
  const paras = (Array.isArray(append) ? append : [append]).filter((p) => p !== undefined && p !== null && String(p).length);
  if (paras.length) {
    const add = paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${escXml(String(p))}</w:t></w:r></w:p>`).join('');
    if (xml.includes('<w:sectPr')) xml = xml.replace('<w:sectPr', `${add}<w:sectPr`);
    else xml = xml.replace('</w:body>', `${add}</w:body>`);
  }
  entries[idx] = { name: entries[idx].name, data: Buffer.from(xml, 'utf8') };
  const target = outPath ? safeResolve(outPath) : absPath;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, deliver.buildZip(entries.map((e) => ({ name: e.name, data: e.data }))));
  return { path: target, bytes: fs.statSync(target).size, appended: paras.length };
}

function modifyXlsx(absPath, { appendRows = [], setCells = [], outPath = null, sheetName = 'Sheet1' } = {}) {
  const buf = fs.readFileSync(absPath);
  const entries = readZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const sheetXml = (byName.get('xl/worksheets/sheet1.xml') || {}).data?.toString('utf8') || '';
  const sstXml = (byName.get('xl/sharedStrings.xml') || {}).data?.toString('utf8') || '';
  const { rows } = xlsxText(sheetXml, sstXml);
  // apply setCells like { cell: 'B2', value: 'hello' }
  const colOf = (cell) => { const m = /^([A-Z]+)(\d+)$/i.exec(String(cell).trim()); if (!m) return null;
    let c = 0; for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return { c: c - 1, r: parseInt(m[2], 10) - 1 }; };
  for (const sc of (Array.isArray(setCells) ? setCells : [setCells])) {
    if (!sc || !sc.cell) continue;
    const pos = colOf(sc.cell);
    if (!pos) continue;
    while (rows.length <= pos.r) rows.push([]);
    while (rows[pos.r].length <= pos.c) rows[pos.r].push('');
    rows[pos.r][pos.c] = sc.value;
  }
  for (const r of (appendRows || [])) rows.push(Array.isArray(r) ? r : [r]);
  // rebuild sheet + sst with the same helper logic as deliver.createXlsx
  const strings = [];
  const sIdx = new Map();
  const cellRef = (r, c) => String.fromCharCode(65 + (c % 26)) + (r + 1);
  const getStr = (s) => { if (!sIdx.has(s)) { sIdx.set(s, strings.length); strings.push(s); } return sIdx.get(s); };
  // NOTE: columns beyond Z wrap naively (A..Z, A..); sheets this wide are out of scope for v1.
  const sheetRows = rows.map((row, r) => {
    const cells = (row || []).slice(0, 26).map((v, c) => {
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${cellRef(r, c)}"><v>${v}</v></c>`;
      const i = getStr(String(v ?? ''));
      return `<c r="${cellRef(r, c)}" t="s"><v>${i}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${escXml(s)}</t></si>`).join('')}</sst>`;
  const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRel = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const RELS_XL = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const target = outPath ? safeResolve(outPath) : absPath;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, deliver.buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(ct) },
    { name: '_rels/.rels', data: Buffer.from(RELS_XL) },
    { name: 'xl/workbook.xml', data: Buffer.from(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRel) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sst) },
  ]));
  return { path: target, bytes: fs.statSync(target).size, rows: rows.length };
}

// ---------- search / list / read / write ----------
function defaultRoots() {
  const roots = [process.cwd()];
  try { if (os.homedir() && os.homedir() !== process.cwd()) roots.push(os.homedir()); } catch {}
  return roots.filter((r) => { try { return fs.existsSync(r) && fs.statSync(r).isDirectory(); } catch { return false; } });
}

function searchLocal({ query, roots = null, maxResults = 50, maxDepth = 6, includeContent = false, exts = null, maxScanned = 20000, timeBudgetMs = 8000 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('searchLocal: need {query}');
  const start = Date.now();
  const list = (Array.isArray(roots) && roots.length ? roots : defaultRoots()).map(safeResolve);
  const extFilter = exts ? new Set([].concat(exts).map((e) => String(e).toLowerCase().replace(/^\.?/, '.'))) : null;
  const results = [];
  let scanned = 0;
  const qWords = q.split(/\s+/).filter(Boolean);

  function matchesName(name) {
    const n = name.toLowerCase();
    return qWords.every((w) => n.includes(w));
  }
  function readSnippet(abs) {
    try {
      const st = fs.statSync(abs);
      if (st.size > 512 * 1024) return null;
      const text = fs.readFileSync(abs, 'utf8');
      const low = text.toLowerCase();
      const i = low.indexOf(qWords[0]);
      if (i === -1) return null;
      return text.slice(Math.max(0, i - 120), i + 200).replace(/\s+/g, ' ').slice(0, 300);
    } catch { return null; }
  }

  function walk(dir, depth) {
    if (results.length >= maxResults || scanned >= maxScanned) return;
    if (Date.now() - start > timeBudgetMs) return;
    if (depth > maxDepth) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (results.length >= maxResults || scanned >= maxScanned) return;
      if (Date.now() - start > timeBudgetMs) return;
      const lower = name.toLowerCase();
      if (SKIP_DIR_NAMES.has(lower)) continue;
      if (name.startsWith('.') && depth > 2) continue;
      const abs = path.join(dir, name);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!st.isFile()) continue;
      scanned += 1;
      if (extFilter && !extFilter.has(path.extname(name).toLowerCase())) continue;
      if (matchesName(name)) {
        results.push({ path: abs, name, size: st.size, mtime: st.mtime.toISOString(), match: 'name' });
        continue;
      }
      if (includeContent && st.size < MAX_READ_BYTES && TEXT_EXTS.has(path.extname(name).toLowerCase())) {
        const snippet = readSnippet(abs);
        if (snippet) results.push({ path: abs, name, size: st.size, mtime: st.mtime.toISOString(), match: 'content', snippet });
      }
    }
  }
  const validRoots = list.filter((r) => { try { return fs.existsSync(r) && fs.statSync(r).isDirectory(); } catch { return false; } });
  for (const r of validRoots) walk(r, 0);
  return { query, roots: validRoots, count: results.length, scanned, tookMs: Date.now() - start, truncated: scanned >= maxScanned || (Date.now() - start) >= timeBudgetMs, results };
}

function listDir(dirPath, { max = 200 } = {}) {
  const abs = safeResolve(dirPath);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('not a directory: ' + abs);
  const names = fs.readdirSync(abs).slice(0, max + 1);
  const entries = names.slice(0, max).map((name) => {
    const fp = path.join(abs, name);
    try {
      const s = fs.statSync(fp);
      return { name, path: fp, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtime.toISOString(), ext: s.isDirectory() ? '' : path.extname(name).toLowerCase() };
    } catch { return { name, path: fp, dir: false, size: 0, mtime: null, ext: '' }; }
  });
  return { dir: abs, count: entries.length, truncated: names.length > max, entries };
}

function readLocalFile(p, { maxBytes = MAX_READ_BYTES } = {}) {
  const abs = safeResolve(p);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file: ' + abs);
  if (st.size > maxBytes * 4) throw new Error(`file too large (${st.size} bytes, cap ${maxBytes * 4})`);
  const ext = path.extname(abs).toLowerCase();
  if (OFFICE_EXTS.has(ext)) {
    const o = readOfficeText(abs);
    return { path: abs, kind: o.kind, bytes: st.size, mtime: st.mtime.toISOString(), text: String(o.text || '').slice(0, 20000), rows: o.rows || undefined, paragraphs: o.paragraphs || undefined };
  }
  const buf = fs.readFileSync(abs);
  const slice = buf.subarray(0, maxBytes);
  return { path: abs, kind: 'text', bytes: st.size, mtime: st.mtime.toISOString(), text: slice.toString('utf8').slice(0, 20000), truncated: st.size > maxBytes };
}

function writeLocalFile(p, content, { overwrite = true } = {}) {
  const abs = safeResolve(p);
  if (fs.existsSync(abs) && !overwrite) throw new Error('file exists (overwrite=false): ' + abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ''), 'utf8');
  return { path: abs, bytes: fs.statSync(abs).size };
}

// ---------- machine control ----------
const BLOCKED_CMD_RE = [
  /^\s*(rm|del|format|mkfs|dd|shutdown|reboot|halt|poweroff|taskkill|reg\s+delete)\b/i,
  /[;&|`$]/, // no shell metachars — we spawn without a shell; these imply injection
  /\.\.[\\/]/, // no traversal in the binary itself
];

function checkCommand(cmd, args) {
  const full = [cmd, ...(args || [])].join(' ').slice(0, 500);
  for (const re of BLOCKED_CMD_RE) {
    if (re.test(cmd) || re.test(full)) return re.source;
  }
  return null;
}

function execCommand(cmd, args = [], { cwd = null, timeoutMs = 15000, maxOutput = 16384 } = {}) {
  return new Promise((resolve) => {
    const hit = checkCommand(String(cmd), args);
    if (hit) return resolve({ ok: false, error: `blocked command pattern: ${hit}`, exit: 'blocked' });
    const workdir = cwd ? safeResolve(cwd) : process.cwd();
    let child;
    try {
      child = spawn(String(cmd), (args || []).map(String), {
        cwd: workdir, timeout: timeoutMs, windowsHide: true,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      });
    } catch (e) {
      return resolve({ ok: false, error: String((e && e.message) || e).slice(0, 500), exit: 'spawn-error' });
    }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > maxOutput) { out = out.slice(0, maxOutput); try { child.kill('SIGKILL'); } catch {} } });
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > maxOutput) err = err.slice(0, maxOutput); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs + 500);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' || signal === 'SIGTERM') return resolve({ ok: false, error: `timeout/killed (${signal})`, exit: signal, output: out.slice(0, maxOutput) });
      if (code !== 0) return resolve({ ok: false, error: (err || `exit ${code}`).slice(0, 1000), exit: code, output: out.slice(0, maxOutput) });
      resolve({ ok: true, output: out.slice(0, maxOutput), exit: 0 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String((e && e.message) || e).slice(0, 500), exit: 'spawn-error' });
    });
  });
}

function openPath(p) {
  const abs = safeResolve(p);
  if (!fs.existsSync(abs)) throw new Error('not found: ' + abs);
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '', abs] : [abs];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  try { child.unref(); } catch {}
  return { opened: true, path: abs };
}

module.exports = {
  searchLocal, listDir, readLocalFile, writeLocalFile,
  readOfficeText, modifyDocx, modifyXlsx,
  execCommand, openPath, safeResolve, defaultRoots,
  readZipEntries, SKIP_DIR_NAMES,
};
