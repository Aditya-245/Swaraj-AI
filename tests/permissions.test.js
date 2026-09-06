'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PermissionManager } = require('../src/permissions');

test('permissions: allow-once grants a single run', async () => {
  const pm = new PermissionManager({ timeoutMs: 2000 });
  const p = pm.request('local_read', 'C:/work/report.docx', { summary: 'Read file' });
  const pending = pm.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'local_read');
  pm.respond(pending[0].id, 'once');
  const r = await p;
  assert.equal(r.granted, true);
  assert.equal(r.via, 'once');
  // No rule persisted for "once"
  assert.equal(pm.listPolicy().rules.length, 0);
});

test('permissions: allow-always persists and auto-grants', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-perm-'));
  const file = path.join(dir, 'permissions.json');
  const pm = new PermissionManager({ filePath: file, timeoutMs: 2000 });
  const p = pm.request('local_search', 'C:/work', { summary: 'search' });
  pm.respond(pm.listPending()[0].id, 'always');
  assert.equal((await p).via, 'always');
  assert.equal(pm.listPolicy().rules.length, 1);
  // Second call with a sub-path is auto-granted, no new prompt
  const r2 = await pm.request('local_search', 'C:/work/sub', {});
  assert.equal(r2.via, 'always');
  assert.equal(pm.listPending().length, 0); // settled requests are not pending
  // Survives reload
  const pm2 = new PermissionManager({ filePath: file });
  assert.equal(pm2.isAllowed('local_search', 'C:/work/other'), true);
});

test('permissions: reject blocks the run', async () => {
  const pm = new PermissionManager({ timeoutMs: 2000 });
  const p = pm.request('shell_exec', 'shell:node --version', { summary: 'run' });
  pm.respond(pm.listPending()[0].id, 'reject');
  await assert.rejects(p, /rejected/i);
});

test('permissions: deny-by-rule and expiry', async () => {
  const pm = new PermissionManager({ timeoutMs: 60 });
  pm.rules.push({ id: 'r1', tool: 'shell_exec', scope: 'shell:*', decision: 'deny', createdAt: new Date().toISOString() });
  await assert.rejects(pm.request('shell_exec', 'shell:whatever', {}), /denied by saved rule/);
  const pm2 = new PermissionManager({ timeoutMs: 60 });
  await assert.rejects(pm2.request('local_read', 'C:/x', {}), /timed out/);
});
