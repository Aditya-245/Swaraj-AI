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
    'SwarajAI/models.json', 'SwarajAI/pull-models.sh', 'SwarajAI/Pull-Models.ps1',
    'SwarajAI/scripts/setup-models.js',
    'SwarajAI/SwarajAI.vbs', 'SwarajAI/Stop-SwarajAI.vbs',
    'SwarajAI/Setup-SwarajAI.bat', 'SwarajAI/Setup-Windows.ps1',
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
    assert.ok(buf.includes(Buffer.from('SwarajAI/SwarajAI.vbs', 'utf8')), 'hidden GUI launcher in archive');
    assert.ok(buf.includes(Buffer.from('SwarajAI/models.json', 'utf8')), 'model fleet manifest in archive');
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // EOCD
    assert.ok(end > 0, 'end-of-central-directory present');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('VBS launchers carry the hidden-start + pid-file contract', () => {
  const vbs = fs.readFileSync(path.join(ROOT, 'desktop', 'SwarajAI.vbs'), 'utf8');
  for (const marker of ['Win32_Process', 'ShowWindow = 0', 'swaraj.pid', '/api/health', 'Stop-SwarajAI', 'Setup-SwarajAI.bat']) {
    assert.ok(vbs.includes(marker), 'SwarajAI.vbs missing: ' + marker);
  }
  const stop = fs.readFileSync(path.join(ROOT, 'desktop', 'Stop-SwarajAI.vbs'), 'utf8');
  assert.ok(stop.includes('swaraj.pid') && stop.includes('Terminate'), 'Stop script must kill via pid file');
  const setup = fs.readFileSync(path.join(ROOT, 'desktop', 'Setup-Windows.ps1'), 'utf8');
  assert.ok(setup.includes('winget') && setup.includes('setup-models.js'), 'Setup must install prereqs + pull models');
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
  // Model fleet pinned in the manifest.
  assert.ok(Array.isArray(m.models) && m.models.length === 3, 'manifest must pin 3 models');
  assert.deepEqual(m.models.map((x) => x.name), ['llama3.2:1b', 'qwen2.5-coder:1.5b', 'moondream:latest']);
  for (const mod of m.models) assert.ok(mod.size && mod.role, 'model needs size+role: ' + mod.name);
  assert.ok(m.modelRequirements && m.modelRequirements.ram && m.modelRequirements.disk, 'manifest needs hardware requirements');
});

test('setup-models --check agrees with /api/models on this machine', async () => {
  const { spawnSync } = require('child_process');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-models.js'), '--check', '--json'], { encoding: 'utf8', timeout: 60000 });
  assert.ok(cli.stdout, 'setup-models produced no output');
  const fromCli = JSON.parse(cli.stdout);
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const api = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
    assert.equal(api.ok, true);
    assert.equal(api.required.length, 3);
    assert.deepEqual(api.required.map((x) => x.name), fromCli.required.map((x) => x.name));
    assert.equal(api.ready, fromCli.ready, 'CLI and API must agree on model readiness');
    assert.equal(cli.status, fromCli.ready ? 0 : 1, '--check exit code must reflect readiness');
    for (const r of api.required) assert.equal(typeof r.installed, 'boolean');
  } finally {
    await new Promise((r) => server.close(r));
  }
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
    assert.ok(home.includes('id="dlModels"'), 'website models status box missing');
    assert.ok(home.includes('Setup-SwarajAI.bat'), 'website must guide first-time setup');
    const wb = await (await fetch(`http://127.0.0.1:${port}/workbench.html`)).text();
    assert.ok(wb.includes('/#download'), 'workbench must link the desktop download');
    assert.ok(wb.includes('fillPrompt('), 'workbench suggestion chips missing');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
