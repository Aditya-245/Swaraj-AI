'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RagIndex } = require('../src/rag');
const { AuditTrail } = require('../src/audit');
const { EgressGuard } = require('../src/egress');
const { Orchestrator, isLocalIntent } = require('../src/orchestrator');
const { PermissionManager } = require('../src/permissions');

function makeOrch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-orch-local-'));
  const rag = new RagIndex();
  const audit = new AuditTrail(path.join(dir, 'audit.jsonl'));
  const egress = new EgressGuard();
  const permissions = new PermissionManager({ timeoutMs: 5000 });
  // Auto-approve everything for this test (simulates "allow always").
  permissions.guard = async (tool, scope, details, onPrompt) => {
    const allowed = permissions.isAllowed(tool, scope);
    if (allowed === true) return { granted: true, via: 'always', requestId: null };
    if (allowed === false) throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    return { granted: true, via: 'test-auto', requestId: null };
  };
  // Stub LLM: instant offline fallback so tests never wait on Ollama.
  const llm = { generate: async () => ({ ok: false, error: 'stub-offline' }) };
  const orch = new Orchestrator({ rag, audit, egress, outDir: dir, permissions, llm });
  return { orch, dir, audit };
}

test('isLocalIntent detects local-machine prompts', () => {
  assert.equal(isLocalIntent('find file report on my machine', []), true);
  assert.equal(isLocalIntent('create an excel sheet for stock', []), true);
  assert.equal(isLocalIntent('hello', []), false);
});

test('orchestrator runLocal searches with auto-approval', async () => {
  const { orch, dir } = makeOrch();
  fs.writeFileSync(path.join(dir, 'stock-take.xlsx.txt'), 'dummy');
  fs.writeFileSync(path.join(dir, 'weld-notes.txt'), 'weld W-12');
  // local_search roots default to cwd+home; pass explicit root via direct tool instead:
  const r = await orch.tools.local_search({ query: 'weld-notes', roots: [dir] });
  assert.ok(r.count >= 1);
});

test('orchestrator runLocal end-to-end via prompt', async () => {
  const { orch } = makeOrch();
  const r = await orch.runTask({ taskId: 'LOCAL-TEST', prompt: 'list files in folder ' + os.tmpdir(), files: [] });
  // "list files in folder X" contains an absolute path -> local intent
  assert.equal(r.kind, 'local');
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.steps) && r.steps.length > 0);
});

test('orchestrator runLocal surfaces permission denial cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-orch-deny-'));
  const rag = new RagIndex();
  const audit = new AuditTrail(path.join(dir, 'audit.jsonl'));
  const egress = new EgressGuard();
  const permissions = new PermissionManager({ timeoutMs: 5000 });
  permissions.guard = async () => { throw Object.assign(new Error('Permission rejected for local_search (x)'), { code: 'PERMISSION_DENIED' }); };
  const llm = { generate: async () => ({ ok: false, error: 'stub-offline' }) };
  const orch = new Orchestrator({ rag, audit, egress, outDir: dir, permissions, llm });
  const r = await orch.runTask({ taskId: 'LOCAL-DENY', prompt: 'find file secret on my machine', files: [] });
  assert.equal(r.kind, 'local');
  assert.equal(r.ok, false);
  assert.match(r.reply, /did not touch|rejected/i);
});
