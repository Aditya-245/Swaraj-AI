'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { AuditTrail } = require('../src/audit');

test('audit append + verify chain', () => {
  const f = path.join(os.tmpdir(), `audit-${Date.now()}.jsonl`);
  const a = new AuditTrail(f);
  a.append({ task: 't1', agent: 'a' });
  a.append({ task: 't2', agent: 'a' });
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 2);
});
