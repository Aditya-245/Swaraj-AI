'use strict';
// Split-mode helper: `npm run start:backend` -> API-only on 127.0.0.1:8000.
// Env overrides: PORT, HOST, SERVE_STATIC, FRONTEND_URL.
const { spawn } = require('child_process');
const path = require('path');
const env = {
  ...process.env,
  PORT: process.env.PORT || '8000',
  HOST: process.env.HOST || '127.0.0.1',
  SERVE_STATIC: process.env.SERVE_STATIC || '0',
};
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'inherit' });
child.on('exit', (c) => process.exit(c == null ? 1 : c));
