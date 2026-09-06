'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EgressGuard } = require('../src/egress');

test('egress denies external, allows local', () => {
  const g = new EgressGuard();
  assert.throws(() => g.assertLocalUrl('https://api.openai.com/v1/chat'), (e) => e.code === 'EGRESS_DENIED');
  assert.throws(() => g.assertLocalUrl('https://example.com/x'), (e) => e.code === 'EGRESS_DENIED');
  assert.equal(g.assertLocalUrl('http://localhost:11434/api'), true);
  assert.equal(g.assertLocalUrl('http://127.0.0.1:8000/'), true);
});

test('egress scanConfig finds remote deps', () => {
  const g = new EgressGuard();
  const findings = g.scanConfig({ llm: 'https://api.openai.com/v1', local: 'http://localhost:11434' });
  assert.equal(findings.length, 1);
});

test('egress scanEnv detects cloud keys', () => {
  const g = new EgressGuard();
  assert.deepEqual(g.scanEnv({ OPENAI_API_KEY: 'x' }), ['OPENAI_API_KEY']);
  assert.deepEqual(g.scanEnv({}), []);
});
