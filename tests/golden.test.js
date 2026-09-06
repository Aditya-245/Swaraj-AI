'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RagIndex } = require('../src/rag');
const { AuditTrail } = require('../src/audit');
const { EgressGuard } = require('../src/egress');
const { Orchestrator } = require('../src/orchestrator');

test('golden path: report -> RAG -> sandbox -> DOCX/PDF -> audit -> zero-egress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-e2e-'));
  const rag = new RagIndex();
  rag.upsert('sop-welding', 'Welding inspection SOP: visual check + dye penetrant. Defect code W-12. Accept if defect rate below 10 percent.');
  const audit = new AuditTrail(path.join(dir, 'audit.jsonl'));
  const egress = new EgressGuard();
  const orch = new Orchestrator({ rag, audit, egress, outDir: dir });
  const r = await orch.runTask({
    taskId: 'IR-TEST',
    prompt: 'Review inspection report for weld defects against SOP and produce approval note.',
    files: [{ name: 'report.txt', text: 'Joints 42, defects 3 porosity W-12, gauge 4.2 bar.' }, { name: 'weld-photo.jpg' }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.hits.length > 0);
  assert.equal(r.calc.ok, true);
  assert.ok(fs.existsSync(r.docx.path) && fs.statSync(r.docx.path).size > 200);
  assert.ok(fs.existsSync(r.pdf.path) && fs.statSync(r.pdf.path).size > 50);
  assert.equal(audit.verify().ok, true);
  assert.ok(audit.verify().count >= 10);
  assert.deepEqual([r.egress.externalLLM, r.egress.remoteMCP, r.egress.internetTraffic], [0, 0, 0]);
  // audit must not contain chain-of-thought
  const raw = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /chain-of-thought|private reasoning/i);
});
