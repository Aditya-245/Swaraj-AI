'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runSandboxed } = require('../src/sandbox');

test('sandbox runs benign code', async () => {
  const r = await runSandboxed('return 2 + 3;');
  assert.equal(r.ok, true);
  assert.match(r.output, /5/);
});

test('sandbox blocks fs/network/env access', async () => {
  for (const code of [
    "const fs = require('fs'); return 1;",
    "return process.env.SECRET;",
    "return fetch('https://example.com');",
  ]) {
    const r = await runSandboxed(code);
    assert.equal(r.ok, false, code);
    assert.match(r.error, /blocked pattern/);
  }
});

test('sandbox kills infinite loop', async () => {
  const r = await runSandboxed('while(true){} return 1;', { timeoutMs: 800 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout\/killed|exit/);
});
