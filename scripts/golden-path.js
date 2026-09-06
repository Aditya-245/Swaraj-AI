'use strict';
// Golden-path demo: inspection report -> parse/OCR -> vision -> SOP RAG ->
// sandbox calc -> DOCX+PDF artifact -> audit -> zero-egress proof. Offline.
const fs = require('fs');
const path = require('path');
const { RagIndex } = require('../src/rag');
const { AuditTrail } = require('../src/audit');
const { EgressGuard } = require('../src/egress');
const { Orchestrator } = require('../src/orchestrator');

async function main() {
  const root = path.join(__dirname, '..');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const rag = new RagIndex();
  for (const f of ['sop-welding.txt', 'sop-safety.txt']) {
    rag.upsert(f.replace('.txt', ''), fs.readFileSync(path.join(root, 'data', f), 'utf8'));
  }
  const audit = new AuditTrail(path.join(outDir, 'audit-demo.jsonl'));
  try { fs.unlinkSync(path.join(outDir, 'audit-demo.jsonl')); } catch {}
  const egress = new EgressGuard();
  const orch = new Orchestrator({ rag, audit, egress, outDir });
  const report = fs.readFileSync(path.join(root, 'data', 'inspection-IR-2026-042.txt'), 'utf8');
  const r = await orch.runTask({
    taskId: 'IR-2026-042',
    prompt: 'Review inspection report IR-2026-042 for weld defects against SOP and produce approval note.',
    files: [{ name: 'inspection-IR-2026-042.txt', text: report }, { name: 'weld-photo.jpg' }],
  });
  console.log(JSON.stringify({ ok: r.ok, verdict: r.verdict, route: r.route, hits: r.hits.map((h) => h.id), docx: r.docx, pdf: r.pdf, egress: r.egress }, null, 2));
  console.log('audit:', JSON.stringify(audit.verify()));
  if (!r.ok) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = {};
