'use strict';
// ============================================================
//  Swaraj AI — desktop packager (stdlib only, offline)
//  Builds a downloadable desktop ZIP of the ENTIRE agent that
//  the Swaraj AI website serves at /download/*.
//
//  Usage:
//    node scripts/package-desktop.js            # build dist/
//    node scripts/package-desktop.js --list     # show what goes in
//    npm run package:desktop
//
//  Output:
//    dist/SwarajAI-desktop-v<version>.zip       # universal (Win/Linux/Mac)
//    dist/SwarajAI-desktop-v<version>.zip.sha256
//    dist/latest.json                           # manifest for /api/download
//
//  Design: single universal ZIP (Node is cross-platform). The ZIP
//  root is SwarajAI/ with double-click launchers at the top level.
//  No npm install needed to run (stdlib-only server); no Electron
//  required (browser --app mode gives the desktop feel).
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_ROOT = 'SwarajAI';

// ---- CRC32 (needed for ZIP store entries, pure JS) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date()) {
  const t = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const d = ((((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { t, d };
}

// Minimal ZIP writer (STORE = no compression, max compatibility, stdlib only).
// entries: [{name (posix, dirs end with /), data: Buffer|null, mode (unix, default 0644)}]
function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { t: mtime, d: mdate } = dosTime();
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data || Buffer.alloc(0);
    const crc = crc32(data);
    const isDir = e.name.endsWith('/');
    const method = 0; // store
    // Local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(mtime, 10);
    lh.writeUInt16LE(mdate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);
    const mode = (e.mode || (isDir ? 0o755 : 0o644)) & 0xffff;
    central.push({ nameBuf, crc, size: data.length, offset, mtime, mdate, mode, isDir });
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(63, 4); // version made by (unix, 6.3)
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(c.mtime, 12);
    ch.writeUInt16LE(c.mdate, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20);
    ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // int attrs
    ch.writeUInt32LE(((c.mode & 0xffff) << 16) | (c.isDir ? 0x10 : 0), 38); // ext attrs
    ch.writeUInt32LE(c.offset, 42);
    chunks.push(ch, c.nameBuf);
    cdSize += ch.length + c.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(chunks));
  return { bytes: fs.statSync(outPath).size, count: entries.length };
}

// ---- What goes into the desktop ZIP ----
function collectFiles() {
  // [source on disk (relative to ROOT)] -> [path inside SwarajAI/]
  const map = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const addFile = (srcRel, destRel, opts = {}) => {
    const abs = path.join(ROOT, srcRel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      if (!opts.optional) throw new Error(`packaging: missing required file ${srcRel}`);
      return false;
    }
    map.push({ src: abs, dest: `${APP_ROOT}/${destRel}`, mode: opts.mode });
    return true;
  };
  const addDir = (dirRel, destPrefix, filter) => {
    const abs = path.join(ROOT, dirRel);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs).sort()) {
      const full = path.join(abs, f);
      if (!fs.statSync(full).isFile()) continue;
      if (filter && !filter(f)) continue;
      map.push({ src: full, dest: `${APP_ROOT}/${destPrefix}${f}` });
    }
  };

  // Top-level launchers (double-click first impression)
  // SwarajAI.vbs is the primary Windows launcher: hidden, no console.
  addFile('desktop/SwarajAI.vbs', 'SwarajAI.vbs');
  addFile('desktop/Stop-SwarajAI.vbs', 'Stop-SwarajAI.vbs');
  addFile('desktop/Setup-SwarajAI.bat', 'Setup-SwarajAI.bat');
  addFile('desktop/Setup-Windows.ps1', 'Setup-Windows.ps1');
  addFile('desktop/SwarajAI.bat', 'SwarajAI.bat');
  addFile('desktop/Start-SwarajAI.ps1', 'Start-SwarajAI.ps1');
  addFile('desktop/SwarajAI.sh', 'SwarajAI.sh', { mode: 0o755 });
  addFile('desktop/README-DESKTOP.txt', 'README-DESKTOP.txt');
  addFile('desktop/electron-main.js', 'desktop/electron-main.js');
  // Local model fleet: pinned manifest + one-click fetch scripts.
  // (4 GB of weights download once via `ollama pull`; afterwards offline.)
  addFile('desktop/models.json', 'models.json');
  addFile('desktop/Pull-Models.ps1', 'Pull-Models.ps1');
  addFile('desktop/pull-models.sh', 'pull-models.sh', { mode: 0o755 });

  // App core
  addFile('package.json', 'package.json');
  addFile('README.md', 'README.md');
  addFile('docker-compose.yml', 'docker-compose.yml', { optional: true });
  addDir('src', 'src/', (f) => f.endsWith('.js'));
  addDir('public', 'public/', (f) => /\.(html|css|js|png|jpg|jpeg|svg|ico|json)$/i.test(f));
  addDir('scripts', 'scripts/', (f) => ['workbench.js', 'golden-path.js', 'egress-check.js', 'setup-models.js'].includes(f));
  // Seed data only: SOPs + demo report. Never ship pg binaries, uploads, or audit logs.
  addDir('data', 'data/', (f) => f.endsWith('.txt'));

  return { map, version: pkg.version || '0.1.0' };
}

function buildEntries() {
  const { map } = collectFiles();
  const entries = [];
  const dirs = new Set();
  const ensureDir = (dirPosix) => {
    // add every ancestor so unzip tools show a clean tree
    const parts = dirPosix.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length - 0; i++) {
      acc += parts[i] + '/';
      if (i < parts.length - 1 || dirPosix.endsWith('/')) {
        if (!dirs.has(acc)) { dirs.add(acc); entries.push({ name: acc, data: Buffer.alloc(0), mode: 0o755 }); }
      }
      if (i === parts.length - 1) break;
    }
  };
  // stable order: dirs first (sorted), then files (sorted by dest)
  const sorted = map.slice().sort((a, b) => (a.dest < b.dest ? -1 : 1));
  for (const m of sorted) {
    const dir = m.dest.slice(0, m.dest.lastIndexOf('/') + 1);
    ensureDir(dir);
  }
  // de-dup dirs, keep insertion order
  const seen = new Set();
  const dirEntries = entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
  const fileEntries = sorted.map((m) => ({
    name: m.dest,
    data: fs.readFileSync(m.src),
    mode: m.mode || (/\.sh$/.test(m.dest) ? 0o755 : 0o644),
  }));
  // keep .gitkeep placeholders so data/uploads + out exist after extract
  const keeps = [`${APP_ROOT}/out/.gitkeep`, `${APP_ROOT}/data/uploads/.gitkeep`].map((n) => ({
    name: n, data: Buffer.from('placeholder — runtime files live here\n'), mode: 0o644,
  }));
  // README-DESKTOP doubles as START-HERE at root for confused users
  return [...dirEntries, ...fileEntries, ...keeps];
}

function sha256File(fp) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(fp));
  return h.digest('hex');
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--list')) {
    const { map, version } = collectFiles();
    console.log(`SwarajAI desktop package v${version} — ${map.length} files:`);
    for (const m of map) console.log('  ' + m.dest + `  (${fs.statSync(m.src).size}B)`);
    return { listed: true, count: map.length, version };
  }
  const { version } = collectFiles();
  const entries = buildEntries();
  const zipName = `SwarajAI-desktop-v${version}.zip`;
  const zipPath = path.join(DIST, zipName);
  const { bytes, count } = writeZip(entries, zipPath);
  const sha = sha256File(zipPath);
  fs.writeFileSync(zipPath + '.sha256', `${sha}  ${zipName}\n`);
  let modelsInfo = { models: [], requirements: {} };
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'models.json'), 'utf8'));
    modelsInfo = {
      runtime: mj.runtime || 'ollama',
      models: (mj.models || []).map((m) => ({ name: m.name, role: m.role, job: m.job, size: m.size })),
      requirements: mj.requirements || {},
    };
  } catch {}
  const manifest = {
    name: 'Swaraj AI - Desktop',
    version,
    builtAt: new Date().toISOString(),
    requires: { node: '>=18', disk: '~300MB free', network: 'none (offline after install)' },
    models: modelsInfo.models,
    modelRequirements: modelsInfo.requirements,
    files: [
      {
        name: zipName,
        url: `/download/${zipName}`,
        bytes,
        sha256: sha,
        platforms: ['windows', 'linux', 'macos'],
        universal: true,
        label: `Windows / Linux / macOS - universal ZIP`,
      },
    ],
    launchers: {
      windows: 'SwarajAI.bat (or Start-SwarajAI.ps1)',
      linux: './SwarajAI.sh',
      macos: './SwarajAI.sh',
    },
    verify: {
      windows: `certutil -hashfile ${zipName} SHA256`,
      linux: `sha256sum ${zipName}`,
      macos: `shasum -a 256 ${zipName}`,
    },
  };
  fs.writeFileSync(path.join(DIST, 'latest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Desktop package built: dist/${zipName} (${(bytes / 1024).toFixed(1)} KB, ${count} entries)`);
  console.log(`SHA-256: ${sha}`);
  console.log('Manifest: dist/latest.json');
  return { zipPath, zipName, bytes, sha, version, count };
}

if (require.main === module) main();
module.exports = { main, collectFiles, buildEntries, writeZip, crc32, DIST, APP_ROOT };
