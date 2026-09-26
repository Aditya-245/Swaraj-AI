'use strict';
// Swaraj Memory: durable facts across sessions + documents.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryStore, extractFacts } = require('../src/memory');
const { memoryBlock } = require('../src/orchestrator');

test('extractFacts learns company / name / location', () => {
  assert.deepEqual(extractFacts('my company name is Kalash Seeds').remember, { company: 'Kalash Seeds' });
  assert.deepEqual(extractFacts('Our company is Kalash Seeds Pvt Ltd.').remember, { company: 'Kalash Seeds Pvt Ltd' });
  assert.deepEqual(extractFacts('company: Kalash Seeds').remember, { company: 'Kalash Seeds' });
  assert.deepEqual(extractFacts('my name is Priya Sharma').remember, { name: 'Priya Sharma' });
  assert.deepEqual(extractFacts('we are located in Jalna, Maharashtra').remember, { location: 'Jalna, Maharashtra' });
  assert.deepEqual(extractFacts('remember my GSTIN is 27ABCDE1234F1Z5').remember, { gstin: '27ABCDE1234F1Z5' });
});

test('extractFacts handles forget + ignores small talk', () => {
  assert.deepEqual(extractFacts('forget my company name').forget, ['company']);
  assert.deepEqual(extractFacts('forget my location').forget, ['location']);
  assert.deepEqual(extractFacts('hello, how are you?'), { remember: {}, forget: [] });
  assert.deepEqual(extractFacts('review the weld report').remember, {});
  assert.deepEqual(extractFacts('remember').remember, {});
});

test('memoryBlock renders facts for prompts, empty when none', () => {
  const b = memoryBlock({ company: 'Kalash Seeds', location: 'Jalna' });
  assert.ok(b.includes('company: Kalash Seeds') && b.includes('location: Jalna'));
  assert.equal(memoryBlock({}), '');
  assert.equal(memoryBlock(null), '');
});

test('MemoryStore file round-trip: remember, list, forget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-mem-'));
  const store = new MemoryStore({ filePath: path.join(dir, 'memory.json'), getPool: async () => null });
  assert.deepEqual(await store.getAll('local'), {});
  await store.remember('local', 'company', 'Kalash Seeds');
  assert.deepEqual(await store.getAll('local'), { company: 'Kalash Seeds' });
  await store.forget('local', 'company');
  assert.deepEqual(await store.getAll('local'), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('job artefacts + reply carry the remembered company (offline templates)', async () => {
  const { RagIndex } = require('../src/rag');
  const { AuditTrail } = require('../src/audit');
  const { EgressGuard } = require('../src/egress');
  const { Orchestrator } = require('../src/orchestrator');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-memjob-'));
  const dead = { generate: async () => ({ ok: false }), generateStream: async () => ({ ok: false }) };
  const orch = new Orchestrator({
    rag: new RagIndex(), audit: new AuditTrail(path.join(dir, 'audit.jsonl')),
    egress: new EgressGuard(), outDir: path.join(dir, 'out'), llm: dead,
  });
  const r = await orch.runTask({
    taskId: 'memtest-1',
    prompt: 'Review inspection report for weld defects against SOP and produce approval note.',
    files: [{ name: 'report.txt', text: '3 defects in 42 joints, dye penetrant W-12.' }],
    memory: { company: 'Kalash Seeds' },
  });
  assert.equal(r.ok, true);
  assert.ok(r.reply.includes('Kalash Seeds'), 'reply must name the company, got: ' + r.reply.slice(0, 120));
  assert.ok(fs.existsSync(r.docx.path) && fs.statSync(r.docx.path).size > 0, 'DOCX missing');
  assert.ok(fs.existsSync(r.pdf.path) && fs.statSync(r.pdf.path).size > 0, 'PDF missing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API learns company from chat and serves/forgets it (every session sees it)', async () => {
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((x) => x.json());
  try {
    // Session 1 teaches the fact.
    await post({ prompt: 'My company name is Kalash Seeds' });
    const mem = await (await fetch(`http://127.0.0.1:${port}/api/memory`)).json();
    assert.equal(mem.ok, true);
    assert.equal(mem.facts.company, 'Kalash Seeds');
    // Session 2 (separate request) gets it stamped into its documents.
    const job = await post({
      prompt: 'Review inspection report for weld defects against SOP and produce approval note.',
      files: [{ name: 'report.txt', text: '3 defects in 42 joints, dye penetrant W-12.' }],
    });
    assert.equal(job.ok, true);
    const pdfName = String(job.pdf.path).split(/[\\/]/).pop();
    const pdf = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/artifact/${encodeURIComponent(pdfName)}`)).arrayBuffer());
    assert.ok(pdf.includes(Buffer.from('Kalash Seeds', 'utf8')), 'PDF approval note must name the company');
    // Forgetting works and is visible immediately.
    const del = await (await fetch(`http://127.0.0.1:${port}/api/memory/company`, { method: 'DELETE' })).json();
    assert.equal(del.ok, true);
    const gone = await (await fetch(`http://127.0.0.1:${port}/api/memory`)).json();
    assert.equal(gone.facts.company, undefined);
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/memory/company`, { method: 'DELETE' }).catch(() => {});
    await new Promise((r) => server.close(r));
  }
});

test('chat template greets with the remembered company (offline)', async () => {
  const { RagIndex } = require('../src/rag');
  const { AuditTrail } = require('../src/audit');
  const { EgressGuard } = require('../src/egress');
  const { Orchestrator } = require('../src/orchestrator');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-memchat-'));
  const dead = { generate: async () => ({ ok: false }), generateStream: async () => ({ ok: false }) };
  const orch = new Orchestrator({
    rag: new RagIndex(), audit: new AuditTrail(path.join(dir, 'a.jsonl')),
    egress: new EgressGuard(), outDir: path.join(dir, 'o'), llm: dead,
  });
  const r = await orch.runChat({ prompt: 'hello', memory: { company: 'Kalash Seeds' } });
  assert.ok(r.reply.includes('Kalash Seeds'), 'greeting must use memory, got: ' + r.reply);
  fs.rmSync(dir, { recursive: true, force: true });
});
