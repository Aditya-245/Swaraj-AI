'use strict';
// Desktop download package: packager output + website endpoints.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { collectFiles, buildEntries, writeZip } = require('../scripts/package-desktop');

test('packager collects launchers + app core, excludes runtime/secret dirs', () => {
  const { map, version } = collectFiles();
  assert.match(version, /^\d+\.\d+\.\d+/);
  const dests = map.map((m) => m.dest);
  for (const must of [
    'SwarajAI/SwarajAI.bat', 'SwarajAI/Start-SwarajAI.ps1', 'SwarajAI/SwarajAI.sh',
    'SwarajAI/README-DESKTOP.txt', 'SwarajAI/src/server.js', 'SwarajAI/public/index.html',
    'SwarajAI/public/workbench.html', 'SwarajAI/data/sop-welding.txt', 'SwarajAI/package.json',
  ]) assert.ok(dests.includes(must), 'missing from package: ' + must);
  for (const d of dests) {
    assert.doesNotMatch(d, /data\/pg|data\/uploads\/[^.]|audit\.jsonl|node_modules|\.git\//);
  }
});

test('packager zip is a valid STORE archive (PK magic + central directory)', () => {
  const entries = buildEntries();
  const tmp = path.join(ROOT, 'dist', '.test-roundtrip.zip');
  try {
    writeZip(entries, tmp);
    const buf = fs.readFileSync(tmp);
    assert.equal(buf.subarray(0, 2).toString('ascii'), 'PK'); // local header magic
    assert.ok(buf.includes(Buffer.from('SwarajAI/src/server.js', 'utf8')), 'server.js in archive');
    assert.ok(buf.includes(Buffer.from('SwarajAI/SwarajAI.bat', 'utf8')), 'launcher in archive');
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // EOCD
    assert.ok(end > 0, 'end-of-central-directory present');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('dist manifest exists with checksum sidecar', () => {
  const manPath = path.join(ROOT, 'dist', 'latest.json');
  assert.ok(fs.existsSync(manPath), 'run: npm run package:desktop');
  const m = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  assert.ok(m.version && m.files && m.files.length >= 1);
  const f = m.files[0];
  const fp = path.join(ROOT, 'dist', f.name);
  assert.ok(fs.existsSync(fp), 'zip missing: ' + f.name);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
  assert.equal(sha, f.sha256, 'manifest sha256 matches bytes on disk');
  assert.equal(fs.readFileSync(fp + '.sha256', 'utf8').split(/\s+/)[0], sha);
});

test('server serves /api/download + /download/:file, blocks traversal', async () => {
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const m = await (await fetch(`http://127.0.0.1:${port}/api/download`)).json();
    assert.equal(m.ok, true);
    assert.ok(Array.isArray(m.files) && m.files.length >= 1, 'no desktop build served');
    const f = m.files[0];
    assert.match(f.url, /^\/download\/SwarajAI-desktop-v.*\.zip$/);

    const res = await fetch(`http://127.0.0.1:${port}${f.url}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /zip/);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), f.sha256);

    for (const bad of ['/download/../package.json', '/download/.env', '/download/server.js']) {
      const r2 = await fetch(`http://127.0.0.1:${port}${bad}`);
      assert.equal(r2.status, 404, bad + ' must not leak files');
    }
    const home = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(home.includes('id="download"'), 'website download section missing');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
