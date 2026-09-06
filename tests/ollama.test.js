'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { OllamaClient } = require('../src/ollama');
const { ModelRouter } = require('../src/model-router');
const { EgressGuard } = require('../src/egress');

test('router uses real local Ollama models', () => {
  const r = new ModelRouter();
  assert.equal(r.route('write python code to parse csv').model, 'qwen2.5-coder:1.5b');
  assert.equal(r.route('analyze this photo of a weld').model, 'moondream');
  assert.equal(r.route('hello, plan my day').model, 'llama3.2:1b');
});

test('ollama client fails gracefully when server is down (offline-safe)', async () => {
  const c = new OllamaClient({ base: 'http://127.0.0.1:59999', egress: new EgressGuard() });
  const r = await c.generate('llama3.2:1b', 'hi', { numPredict: 5, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('ollama client refuses non-local base (zero-egress)', () => {
  const c = new OllamaClient({ base: 'https://api.openai.com', egress: new EgressGuard() });
  assert.throws(() => c._guard('/api/tags'), (e) => e.code === 'EGRESS_DENIED');
});

test('ollama client reaches local server when up (skipped if ollama down)', async () => {
  const c = new OllamaClient({ egress: new EgressGuard() });
  const t = await c.tags();
  if (!t.ok) { console.log('  (ollama not running — live check skipped)'); return; }
  assert.ok(Array.isArray(t.models));
});
