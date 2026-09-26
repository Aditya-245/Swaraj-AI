'use strict';
// ============================================================
//  Swaraj AI — model setup (stdlib only, offline-first)
//  Installs the 3 pinned local models from desktop/models.json
//  into Ollama. One-time download, then fully offline.
//
//  Usage:
//    node scripts/setup-models.js            # pull missing models
//    node scripts/setup-models.js --check    # exit 0 if all 3 present
//    node scripts/setup-models.js --check --json
//    npm run models / npm run models:check
//
//  Air-gapped sites: copy .gguf files via USB, then per model:
//    ollama create llama3.2:1b --from ./llama3.2-1b.gguf
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function loadManifest() {
  for (const p of [path.join(ROOT, 'models.json'), path.join(ROOT, 'desktop', 'models.json')]) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  return { models: [{ name: 'llama3.2:1b' }, { name: 'qwen2.5-coder:1.5b' }, { name: 'moondream:latest' }] };
}

function findOllama() {
  const cmd = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  let r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (!r.error && r.status === 0) return { cmd, version: String(r.stdout || '').trim() };
  if (process.platform === 'win32') {
    const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
    if (local && fs.existsSync(local)) {
      r = spawnSync(local, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (!r.error && r.status === 0) return { cmd: local, version: String(r.stdout || '').trim() };
    }
  }
  return null;
}

function listInstalled(ollamaCmd) {
  const r = spawnSync(ollamaCmd, ['list'], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '')
    .split('\n')
    .slice(1) // header
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function base(tag) {
  return String(tag).split(':')[0].toLowerCase();
}

function status() {
  const manifest = loadManifest();
  const ollama = findOllama();
  const installed = ollama ? listInstalled(ollama.cmd) : null;
  const required = manifest.models.map((m) => {
    const hit = installed
      ? installed.find((t) => t === m.name || base(t) === base(m.name))
      : null;
    return { name: m.name, role: m.role || '', job: m.job || '', size: m.size || '', installed: !!hit, foundAs: hit || null };
  });
  return {
    ollama: ollama ? { found: true, version: ollama.version } : { found: false },
    serviceUp: installed !== null,
    required,
    ready: required.length > 0 && required.every((m) => m.installed),
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const st = status();
  const asJson = args.has('--json');

  if (args.has('--check')) {
    if (asJson) console.log(JSON.stringify(st, null, 2));
    else {
      console.log(st.ollama.found ? `Ollama: ${st.ollama.version}` : 'Ollama: NOT FOUND (https://ollama.com/download)');
      for (const m of st.required) {
        console.log(`  ${m.installed ? '[OK]' : '[--]'} ${m.name}  (${m.size || '?'}) — ${m.job}`);
      }
      console.log(st.ready ? 'MODELS READY 3/3' : 'MODELS MISSING — run: node scripts/setup-models.js');
    }
    process.exitCode = st.ready ? 0 : 1;
    return st;
  }

  // Pull mode.
  if (!st.ollama.found) {
    console.error('Ollama not found. Install it first: https://ollama.com/download');
    console.error('Then re-run this script (needs internet once; afterwards fully offline).');
    process.exitCode = 1;
    return st;
  }
  const missing = st.required.filter((m) => !m.installed);
  if (!missing.length) {
    console.log('All 3 Swaraj AI models already present — nothing to download.');
    return status();
  }
  console.log(`Pulling ${missing.length} model(s) (~4 GB total, one-time download)...`);
  let failed = 0;
  const ollamaCmd = findOllama().cmd;
  for (const m of missing) {
    console.log(`\n>>> ollama pull ${m.name}  (${m.size || '?'}) — ${m.job}`);
    const r = spawnSync(ollamaCmd, ['pull', m.name], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
    if (r.error || r.status !== 0) {
      console.error(`FAILED to pull ${m.name}. Check your connection and retry.`);
      failed++;
    }
  }
  const done = status();
  console.log(done.ready ? '\nMODELS READY 3/3 — restart the workbench if it is running.' : `\n${failed} pull(s) failed — re-run: node scripts/setup-models.js`);
  process.exitCode = done.ready ? 0 : 1;
  return done;
}

if (require.main === module) main();
module.exports = { status, loadManifest, findOllama };
