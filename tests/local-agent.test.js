'use strict';
// Single-prompt Local PC agent: the planner turns one natural-language request
// into an ordered list of permission-gated steps, and runLocal executes them in
// sequence (each asking permission) before summarising.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RagIndex } = require('../src/rag');
const { AuditTrail } = require('../src/audit');
const { EgressGuard } = require('../src/egress');
const { Orchestrator, planLocalSteps } = require('../src/orchestrator');
const { PermissionManager } = require('../src/permissions');

const tools = (p) => planLocalSteps(p).map((s) => s.tool);

test('planner: one prompt can mean several steps', () => {
  assert.deepEqual(tools('find the file budget.xlsx and open it'), ['local_search', 'open_path']);
  assert.deepEqual(tools('find report on my machine'), ['local_search']);
  assert.deepEqual(tools('weld defect report'), ['local_search']);
});

test('planner: search query drops filler words', () => {
  const [s] = planLocalSteps('search for invoice in my downloads folder');
  assert.equal(s.tool, 'local_search');
  assert.equal(s.args.query, 'invoice');
});

test('planner: browse a named folder, without a redundant read', () => {
  const plan = planLocalSteps('what is in my downloads');
  assert.deepEqual(plan.map((s) => s.tool), ['local_list']);
  assert.match(String(plan[0].args.dir), /downloads/i);
  const listed = planLocalSteps('list files in D:\\work\\reports');
  assert.deepEqual(listed.map((s) => s.tool), ['local_list']);
  assert.equal(listed[0].args.dir, 'D:\\work\\reports');
});

test('planner: create covers spreadsheets, documents and text files', () => {
  const [xlsx] = planLocalSteps('create an excel sheet for this month');
  assert.equal(xlsx.tool, 'office_create');
  assert.equal(xlsx.args.kind, 'xlsx');
  assert.equal(planLocalSteps('create a word document called notes.docx')[0].args.kind, 'docx');
  assert.equal(planLocalSteps('create a text file readme.txt with deployment steps')[0].tool, 'local_write');
});

test('planner: modify/open/read/command each map to one gated tool', () => {
  assert.equal(planLocalSteps('modify D:\\data\\plan.xlsx and add a row')[0].tool, 'office_modify');
  assert.equal(planLocalSteps('append "reviewed by QA" to D:\\docs\\sop.docx')[0].tool, 'office_modify');
  assert.equal(planLocalSteps('open D:\\reports\\ir-042.pdf')[0].tool, 'open_path');
  assert.equal(planLocalSteps('read D:\\notes.txt')[0].tool, 'local_read');
  const [cmd] = planLocalSteps('run the command git status');
  assert.equal(cmd.tool, 'shell_exec');
  assert.equal(cmd.args.cmd, 'git');
  assert.deepEqual(cmd.args.args, ['status']);
  assert.deepEqual(planLocalSteps('run node --version')[0].args, { cmd: 'node', args: ['--version'] });
});

test('planner: returns nothing for a prompt with no local intent', () => {
  assert.deepEqual(planLocalSteps('what is the capital of France'), []);
});

function makeOrch(onGuard) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-local-agent-'));
  const permissions = new PermissionManager({ timeoutMs: 5000 });
  if (onGuard) permissions.guard = onGuard; else {
    permissions.guard = async () => ({ granted: true, via: 'test-auto', requestId: null });
  }
  const orch = new Orchestrator({
    rag: new RagIndex(),
    audit: new AuditTrail(path.join(dir, 'audit.jsonl')),
    egress: new EgressGuard(),
    outDir: dir,
    permissions,
    llm: { generate: async () => ({ ok: false, error: 'stub-offline' }) },
  });
  return { orch, dir, permissions };
}

test('local:true forces the local agent even for an intent-free prompt', async () => {
  const { orch } = makeOrch();
  const r = await orch.runTask({ taskId: 'FORCE-LOCAL', prompt: 'anything at all', files: [], local: true });
  assert.equal(r.kind, 'local');
  assert.equal(r.route.route, 'local');
});

test('every planned step is permission-gated, in order', async () => {
  const seen = [];
  const { orch } = makeOrch(async (tool, scope) => { seen.push([tool, scope]); return { granted: true, via: 'test-auto', requestId: null }; });
  const r = await orch.runTask({ taskId: 'GATED', prompt: 'list files in folder ' + os.tmpdir(), files: [], local: true });
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, 1);
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'local_list');
});

test('a rejected step stops the plan and explains that nothing happened', async () => {
  const { orch } = makeOrch(async () => { throw Object.assign(new Error('rejected by user'), { code: 'PERMISSION_DENIED' }); });
  const r = await orch.runTask({ taskId: 'REJECT', prompt: 'list files in folder ' + os.tmpdir(), files: [], local: true });
  assert.equal(r.ok, false);
  assert.equal(r.permission, 'PERMISSION_DENIED');
  assert.match(r.reply, /did not touch your machine/i);
  assert.ok(r.route.route === 'local');
});

test('multi-step plan executes in sequence and reports every step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-local-seq-'));
  const target = path.join(dir, 'stock-sheet');
  const { orch } = makeOrch();
  const r = await orch.runTask({
    taskId: 'SEQ',
    prompt: `create a text file ${target} with the month numbers then read ${target}`,
    files: [],
    local: true,
  });
  assert.equal(r.ok, true, r.error || '');
  assert.deepEqual(r.plan.map((s) => s.tool), ['local_write', 'local_read']);
  assert.ok(fs.existsSync(target));
  assert.match(r.local.text || '', /2026/);
});

test('search → open reuses the top hit when no path was typed', async () => {
  const { orch, dir } = makeOrch();
  const file = path.join(dir, 'weld-defect-report.txt');
  fs.writeFileSync(file, 'defect W-12');
  const r = await orch.runTask({ taskId: 'SEQ2', prompt: `find the file weld-defect-report.txt in ${dir} and open it`, files: [], local: true });
  assert.equal(r.ok, true, r.error || '');
  assert.deepEqual(r.plan.map((s) => s.tool), ['local_search', 'open_path']);
  assert.equal(String(r.plan[1].detail || '').toLowerCase().includes('weld-defect-report'), true);
});
