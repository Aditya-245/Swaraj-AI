'use strict';
// PostgreSQL layer. Production uses the compose `postgres:16` service
// (DATABASE_URL). Local dev without Docker uses embedded-postgres binaries
// (same engine, data in ./data/pg). Either way the app talks real PostgreSQL.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'email',
  provider_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'job',
  prompt TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON user_tasks(user_id);
`;

let pool = null;
let embedded = null;

async function initDb({ databaseUrl = process.env.DATABASE_URL, dataDir = null, port = parseInt(process.env.PGPORT || '5432', 10) } = {}) {
  if (pool) return pool;
  let url = databaseUrl;
  if (!url) {
    // Embedded PostgreSQL for zero-install local runs.
    const EmbeddedPostgres = require('embedded-postgres').default;
    const dir = dataDir || path.join(__dirname, '..', 'data', 'pg');
    fs.mkdirSync(dir, { recursive: true });
    embedded = new EmbeddedPostgres({
      databaseDir: path.join(dir, 'db'),
      user: 'sov',
      password: 'sov-local-only',
      port,
      persistent: true,
    });
    // initialise() fails on a non-empty dir, so only run it for fresh clusters.
    const already = fs.existsSync(path.join(dir, 'db', 'PG_VERSION'));
    if (!already) await embedded.initialise();
    await embedded.start();
    url = `postgres://sov:sov-local-only@127.0.0.1:${port}/postgres`;
  }
  pool = new Pool({ connectionString: url });
  const c = await pool.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS citext');
    await c.query(SCHEMA);
  } finally {
    c.release();
  }
  pool._dbUrl = url;
  return pool;
}

function getPool() {
  if (!pool) throw new Error('db not initialised — call initDb() first');
  return pool;
}

async function closeDb() {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
  if (embedded) { await embedded.stop().catch(() => {}); embedded = null; }
}

module.exports = { initDb, getPool, closeDb };
