'use strict';
// Swaraj Context: multi-session conversation memory (turns fed back to the model).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContextStore, contextBlock, RECENT_TURNS, MAX_TURNS } = require('../src/context');
const { promptHead } = require('../src/orchestrator');

test('contextBlock formats recent turns, empty when none', () => {
  assert.equal(contextBlock([]), '');
  assert.equal(contextBlock(null), '');
  const b = contextBlock([
    { role: 'user', text: 'my company name is Kalash Seeds' },
    { role: 'assistant', text: 'Noted!' },
  ]);
  assert.ok(b.includes('user: my company name is Kalash Seeds'));
  assert.ok(b.includes('assistant: Noted!'));
  const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` }));
  const lines = contextBlock(many).split('\n').filter((l) => /^(user|assistant):/.test(l));
  assert.equal(lines.length, RECENT_TURNS, 'only the most recent turns are fed in');
});

test('promptHead combines facts + context safely', () => {
  assert.equal(promptHead({}, ''), '');
  const h = promptHead({ company: 'Kalash Seeds' }, contextBlock([{ role: 'user', text: 'hi' }]));
  assert.ok(h.includes('company: Kalash Seeds') && h.includes('user: hi'));
});

test('ContextStore file round-trip with cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-ctx-'));
  const store = new ContextStore({ filePath: path.join(dir, 'context.json'), getPool: async () => null });
  assert.deepEqual(await store.recent('local'), []);
  for (let i = 0; i < MAX_TURNS + 5; i++) {
    await store.append('local', i % 2 ? 'assistant' : 'user', `message number ${i} with padding to be realistic`);
  }
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8')).local;
  assert.equal(all.length, MAX_TURNS, 'store caps history');
  assert.equal(all[all.length - 1].text.slice(0, 16), 'message number 2', 'oldest turns drop first');
  const rec = await store.recent('local');
  assert.equal(rec.length, RECENT_TURNS);
  await store.clear('local');
  assert.deepEqual(await store.recent('local'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prior turns reach the model prompt (recorded fake LLM)', async () => {
  const { RagIndex } = require('../src/rag');
  const { AuditTrail } = require('../src/audit');
  const { EgressGuard } = require('../src/egress');
  const { Orchestrator } = require('../src/orchestrator');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-ctxllm-'));
  const seen = [];
  const fake = {
    generate: async (model, prompt) => { seen.push(prompt); return { ok: true, text: 'recorded reply' }; },
    generateStream: async (model, prompt) => { seen.push(prompt); return { ok: true, text: 'recorded reply' }; },
  };
  const orch = new Orchestrator({
    rag: new RagIndex(), audit: new AuditTrail(path.join(dir, 'a.jsonl')),
    egress: new EgressGuard(), outDir: path.join(dir, 'o'), llm: fake,
  });
  const ctx = contextBlock([{ role: 'user', text: 'my company name is Kalash Seeds' }]);
  const r = await orch.runQA({ prompt: 'what is my company name?', memory: {}, context: ctx });
  assert.equal(r.reply, 'recorded reply');
  assert.ok(seen[0].includes('my company name is Kalash Seeds'), 'prior turn must be in the model prompt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API persists turns across requests and clears on demand', async () => {
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  // A document job runs on local templates, so it succeeds with no model.
  const job = (prompt) => post({ prompt, files: [{ name: 'report.txt', text: '3 defects in 42 joints, dye penetrant W-12.' }] });
  try {
    await fetch(`http://127.0.0.1:${port}/api/context`, { method: 'DELETE' });
    assert.equal((await job('Review inspection report for weld defects and produce approval note.')).status, 200);
    const c1 = await (await fetch(`http://127.0.0.1:${port}/api/context`)).json();
    assert.equal(c1.ok, true);
    assert.ok(c1.count >= 2, 'user + assistant turns stored, got ' + c1.count);
    assert.ok(c1.turns.some((t) => t.role === 'user' && t.text.includes('weld defects')));
    assert.ok(c1.turns.some((t) => t.role === 'assistant' && t.text.length > 20), 'agent reply kept');

    // A second, separate "session" adds to the same thread.
    assert.equal((await job('Now compare against the previous report')).status, 200);
    const c2 = await (await fetch(`http://127.0.0.1:${port}/api/context`)).json();
    assert.ok(c2.count >= c1.count + 2, 'turns accumulate across sessions, got ' + c2.count);
    assert.ok(c2.turns.some((t) => t.text.includes('compare against')), 'newest session visible');

    const del = await (await fetch(`http://127.0.0.1:${port}/api/context`, { method: 'DELETE' })).json();
    assert.equal(del.ok, true);
    const gone = await (await fetch(`http://127.0.0.1:${port}/api/context`)).json();
    assert.equal(gone.count, 0);
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/context`, { method: 'DELETE' }).catch(() => {});
    await new Promise((r) => server.close(r));
  }
});

test('a failed run still leaves the user prompt in context', async () => {
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/api/context`, { method: 'DELETE' });
    // Ollama is not reachable from the test runner: the call errors out.
    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Explain Gibbs free energy in simple words' }),
    }).catch(() => {});
    const c = await (await fetch(`http://127.0.0.1:${port}/api/context`)).json();
    assert.ok(c.turns.some((t) => t.role === 'user' && t.text.includes('Gibbs')), 'prompt must survive a failed run');
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/context`, { method: 'DELETE' }).catch(() => {});
    await new Promise((r) => server.close(r));
  }
});
