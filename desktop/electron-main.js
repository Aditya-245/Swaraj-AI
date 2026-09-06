'use strict';
// ============================================================
//  Swaraj AI — optional Electron shell (progressive enhancement)
//  The downloadable ZIP runs WITHOUT Electron (browser app-mode
//  gives the desktop feel with zero new dependencies).
//
//  If you want a true .exe / .dmg instead, install Electron and
//  point it at this file:
//
//    npm i -D electron electron-builder
//    npx electron desktop/electron-main.js
//    npx electron-builder --win portable --linux AppImage --mac dmg
//
//  Env: PORT (default 8080), SWARAJ_URL (attach to existing server)
// ============================================================
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_PORT = parseInt(process.env.PORT || '8080', 10);

function startServer(port) {
  return spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
  });
}

async function waitReady(port, tries = 25) {
  const http = require('http');
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function boot() {
  // Attach to an already-running workbench when asked.
  if (process.env.SWARAJ_URL) {
    openWindow(process.env.SWARAJ_URL);
    return;
  }
  let child = null;
  let port = BASE_PORT;
  for (; port < BASE_PORT + 10; port++) {
    child = startServer(port);
    await new Promise((r) => setTimeout(r, 1800));
    if (await waitReady(port, 3)) break;
    try { child.kill(); } catch {}
    child = null;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!child) {
    console.error('Swaraj AI: could not bind ports 8080-8089.');
    process.exit(1);
  }
  openWindow(`http://127.0.0.1:${port}`);
}

function openWindow(url) {
  let electron;
  try {
    electron = require('electron');
  } catch {
    console.log(`Swaraj AI ready -> ${url}`);
    console.log('Electron is not installed; the browser app-mode launcher (SwarajAI.bat/.sh) already gives a desktop window.');
    console.log('To build a native shell: npm i -D electron electron-builder');
    return;
  }
  const { app, BrowserWindow } = electron;
  const create = () => {
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      title: 'Swaraj AI — Sovereign Workbench',
      autoHideMenuBar: true,
      backgroundColor: '#FAF6EE',
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    win.loadURL(url + '/workbench.html');
  };
  app.whenReady().then(create);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (electron.BrowserWindow.getAllWindows().length === 0) create(); });
}

if (require.main === module) boot();
module.exports = { boot };
