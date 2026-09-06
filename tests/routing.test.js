'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator } = require('../src/orchestrator');
const { RagIndex } = require('../src/rag');
const { AuditTrail } = require('../src/audit');
const { EgressGuard } = require('../src/egress');
const { OllamaClient } = require('../src/ollama');

function dead() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-route-'));
  const rag = new RagIndex();
  rag.upsert('sop-welding', 'Welding inspection SOP: defect rate below 10 percent is acceptable.');
  return new Orchestrator({
    rag, audit: new AuditTrail(path.join(dir, 'a.jsonl')),
    egress: new EgressGuard(), outDir: dir,
    llm: new OllamaClient({ base: 'http://127.0.0.1:59999', egress: new EgressGuard() }),
  });
}

test('general question routes to llama Q&A, no artefacts', async () => {
  const r = await dead().runTask({ taskId: 'q1', prompt: 'What is the acceptable weld defect rate?' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'qa');
  assert.equal(r.replyModel, 'llama3.2:1b');
  assert.equal(r.docx, undefined);
});

test('coding question routes to qwen', async () => {
  const r = await dead().runTask({ taskId: 'c1', prompt: 'write python code to compute average of a list' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'code');
  assert.equal(r.replyModel, 'qwen2.5-coder:1.5b');
});

test('vision question routes to moondream', async () => {
  const r = await dead().runTask({ taskId: 'v1', prompt: 'describe this weld photo for defects' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'vision');
  assert.equal(r.replyModel, 'moondream');
});

test('document request still runs full job pipeline', async () => {
  const r = await dead().runTask({ taskId: 'j1', prompt: 'Review inspection report IR-9 against SOP and produce approval note.' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'job');
  assert.ok(r.docx && r.docx.path);
});
