'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDocument, ocrIfNeeded, inspectImage } = require('../src/documents');
const { createPdf, createDocx, createXlsx, createPptx } = require('../src/deliver');

test('documents: text + scanned-image OCR stub + vision stub', () => {
  const d = readDocument({ text: 'hello weld', name: 'a.txt' });
  assert.equal(d.needsOcr, false);
  const img = ocrIfNeeded({ name: 'weld-photo.jpg', text: '', kind: 'image', needsOcr: true });
  assert.equal(img.ocrPerformed, true);
  assert.match(img.text, /OCR/);
  const v = inspectImage('weld-photo.jpg');
  assert.equal(v.local, true);
  assert.ok(v.findings.length > 0);
});

test('deliverables are real valid non-empty files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-del-'));
  const pdf = path.join(dir, 'r.pdf');
  const docx = path.join(dir, 'r.docx');
  const xlsx = path.join(dir, 'd.xlsx');
  const pptx = path.join(dir, 'b.pptx');
  createPdf('line1\nline2', pdf);
  createDocx(['p1', 'p2'], docx, 'T');
  createXlsx([['a', 'b'], [1, 2]], xlsx);
  createPptx(['s1'], pptx, 'T');
  assert.ok(fs.statSync(pdf).size > 50 && fs.readFileSync(pdf).subarray(0, 4).toString() === '%PDF');
  for (const f of [docx, xlsx, pptx]) {
    const b = fs.readFileSync(f);
    assert.ok(b.length > 200, f);
    assert.equal(b[0], 0x50); assert.equal(b[1], 0x4b); // PK zip magic
  }
});
