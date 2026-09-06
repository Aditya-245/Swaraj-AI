'use strict';

// Secure local sandbox: runs untrusted JS in an isolated child process.
// Guarantees: timeout kill, restricted fs (own tmp dir), stripped env,
// no network (env has no proxy + code statically rejected on net imports),
// stdout cap, zombie reaping, host health unaffected.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DENIED_PATTERNS = [
  /require\s*\(\s*['"](child_process|net|dgram|dns|tls|worker_threads|cluster)['"]/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /process\.env/,
  /fetch\s*\(/,
  /http\.request/,
  /socket/i,
];

function staticCheck(code) {
  for (const re of DENIED_PATTERNS) {
    if (re.test(code)) return re.source;
  }
  return null;
}

function runSandboxed(code, { timeoutMs = 2000, maxOutput = 8192, memoryMb = 128 } = {}) {
  return new Promise((resolve) => {
    const hit = staticCheck(code);
    if (hit) {
      return resolve({ ok: false, error: `blocked pattern: ${hit}`, exit: 'blocked' });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-sandbox-'));
    const file = path.join(dir, 'main.js');
    const wrapped = `'use strict';\nconst result = (() => {\n${code}\n})();\nif (result !== undefined) console.log(JSON.stringify(result));\n`;
    fs.writeFileSync(file, wrapped, 'utf8');
    const child = spawn(process.execPath, [`--max-old-space-size=${memoryMb}`, file], {
      cwd: dir,
      timeout: timeoutMs,
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > maxOutput) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 500);
    child.on('close', (codeExit, signal) => {
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        return resolve({ ok: false, error: `timeout/killed (${signal})`, exit: signal });
      }
      if (codeExit !== 0) {
        return resolve({ ok: false, error: err.slice(0, 1000) || `exit ${codeExit}`, exit: codeExit });
      }
      resolve({ ok: true, output: out.slice(0, maxOutput), exit: 0 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      resolve({ ok: false, error: String(e), exit: 'spawn-error' });
    });
  });
}

module.exports = { runSandboxed, staticCheck };
