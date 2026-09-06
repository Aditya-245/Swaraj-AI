'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator, isChitChat } = require('../src/orchestrator');
const { RagIndex } = require('../src/rag');
const { AuditTrail } = require('../src/audit');
const { EgressGuard } = require('../src/egress');
const { OllamaClient } = require('../src/ollama');

function harness(llm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-chat-'));
  return new Orchestrator({
    rag: new RagIndex(), audit: new AuditTrail(path.join(dir, 'a.jsonl')),
    egress: new EgressGuard(), outDir: dir, llm: llm || new OllamaClient({ base: 'http://127.0.0.1:59999', egress: new EgressGuard() }),
  });
}

test('isChitChat: greetings yes, work no', () => {
  for (const g of ['hello', 'Hi!', 'namaste', 'thanks', 'who are you?', 'good morning', 'bye']) {
    assert.equal(isChitChat(g), true, g);
  }
  for (const w of ['Review inspection report IR-42', 'hello, review the weld report please', 'write python code', 'hi, what is the defect rate for PV-7?']) {
    assert.equal(isChitChat(w), false, w);
  }
});

test('chit-chat fast path: short reply, no artefacts, template fallback offline', async () => {
  const orch = harness();
  const t0 = Date.now();
  const r = await orch.runTask({ taskId: 'hi-1', prompt: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'chat');
  assert.ok(r.reply.length < 200, 'reply must be short, got: ' + r.reply);
  assert.equal(r.replySource, 'template'); // ollama dead on :59999
  assert.equal(r.docx, undefined);
  assert.ok(Date.now() - t0 < 15000, 'fallback must be fast');
});
