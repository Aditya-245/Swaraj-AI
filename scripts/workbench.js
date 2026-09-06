'use strict';
// Reliable local launcher: verifies deps, picks a free port, starts the
// workbench, waits for /api/health, prints the URL. No external calls.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public', 'index.html');

function check(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let n = 0;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, bytes: n }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false }); });
  });
}

async function main() {
  if (!fs.existsSync(PUB)) {
    console.error('MISSING public/index.html — reinstall the project.');
    process.exit(1);
  }
  const base = parseInt(process.env.PORT || '8080', 10);
  for (let port = base; port < base + 10; port++) {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'inherit',
    });
    // give it 2.5s to bind, then probe
    await new Promise((r) => setTimeout(r, 2500));
    const h = await check(`http://127.0.0.1:${port}/api/health`);
    const ui = await check(`http://127.0.0.1:${port}/`);
    if (h.ok && ui.ok) {
      console.log(`\nWORKBENCH READY -> http://127.0.0.1:${port}  (health kb=${JSON.stringify(h)}, ui bytes=${ui.bytes})`);
      console.log('Press Ctrl+C to stop. Keep this window open while you use the workbench.');
      await new Promise(() => {}); // keep alive; child inherits stdio
      return;
    }
    try { process.kill(child.pid); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('Could not start workbench on ports 8080-8089. Stop the blocking process and retry.');
  process.exit(1);
}

if (require.main === module) main();
