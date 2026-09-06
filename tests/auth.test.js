'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PGPORT = '5433'; // isolated from the dev server on 5432
const { initDb, getPool, closeDb } = require('../src/db');
const auth = require('../src/auth');

test('auth e2e on real PostgreSQL: register→login→session→logout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-auth-'));
  process.env.PGPORT = '5433';
  await initDb({ dataDir: dir, port: 5433 });
  const pool = getPool();
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
  for (const t of ['users', 'sessions', 'user_tasks']) {
    assert.ok(tables.rows.some((r) => r.tablename === t), 'missing table ' + t);
  }

  const email = `eng${Date.now()}@plant.local`;
  const u = await auth.register({ email, password: 'sov-pass-123', name: 'Test Eng' });
  assert.equal(u.email, email);
  assert.equal(u.password_hash, undefined); // never leaked

  await assert.rejects(() => auth.register({ email, password: 'sov-pass-123' }), /already registered/);
  await assert.rejects(() => auth.register({ email: 'bad', password: 'sov-pass-123' }), /valid email/);
  await assert.rejects(() => auth.register({ email: 'x@y.zz', password: 'short' }), /8 characters/);
  await assert.rejects(() => auth.login({ email, password: 'wrong-pass' }), /Wrong email/);

  const logged = await auth.login({ email, password: 'sov-pass-123' });
  assert.equal(logged.id, u.id);
  const token = await auth.createSession(u.id);
  assert.equal(token.length, 64);
  const me = await auth.userFromToken(token);
  assert.equal(me.email, email);
  // token stored hashed, not plaintext
  const raw = await pool.query('SELECT token_hash FROM sessions');
  assert.ok(!raw.rows.some((r) => r.token_hash === token));
  await auth.destroySession(token);
  assert.equal(await auth.userFromToken(token), null);

  // task history linkage (application data)
  await pool.query('INSERT INTO user_tasks (user_id, kind, prompt, verdict) VALUES ($1,\'job\',\'test prompt\',\'ACCEPT\')', [u.id]);
  const hist = await pool.query('SELECT * FROM user_tasks WHERE user_id=$1', [u.id]);
  assert.equal(hist.rows.length, 1);

  // OAuth unconfigured → honest 501, never half-broken
  assert.deepEqual(auth.providers(), { google: false, github: false });
  await assert.rejects(auth.oauthCallback('google', { code: 'x', state: 'y' }), /expired|configured/);
  await closeDb();
});
