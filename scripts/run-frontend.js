'use strict';
// Split-mode helper: `npm run start:frontend` -> static file server for public/ on 127.0.0.1:3000.
// Stdlib only (no `serve` dependency). Usage:
//   node scripts/run-frontend.js [port]   (default 3000)
// Open http://127.0.0.1:3000/workbench.html?backend=http://127.0.0.1:8000
const http = require('http');
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const port = parseInt(process.argv[2] || process.env.FRONTEND_PORT || '3000', 10);
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let fp = path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
  if (!fp.startsWith(PUB)) { res.writeHead(403); res.end('denied'); return; }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end('not found'); return; }
  const b = fs.readFileSync(fp);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': b.length });
  res.end(b);
}).listen(port, '127.0.0.1', () => console.log(`Swaraj AI frontend (static) on http://127.0.0.1:${port} -> backend ${process.env.BACKEND_URL || '(same-origin, or ?backend=...)'}`));
