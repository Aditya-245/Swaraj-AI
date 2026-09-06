'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lm = require('../src/local-machine');
const { createDocx, createXlsx } = require('../src/deliver');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sov-lm-')); }

test('local search finds files by name', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'inspection-IR-042.txt'), 'weld defect W-12');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'unrelated');
  const r = lm.searchLocal({ query: 'inspection', roots: [dir] });
  assert.equal(r.count, 1);
  assert.match(r.results[0].path, /inspection/);
});

test('local search optionally scans content', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'the secret defect code is W-12');
  const byName = lm.searchLocal({ query: 'W-12', roots: [dir] });
  assert.equal(byName.count, 0);
  const byContent = lm.searchLocal({ query: 'W-12', roots: [dir], includeContent: true });
  assert.equal(byContent.count, 1);
  assert.equal(byContent.results[0].match, 'content');
});

test('office read + modify round-trips docx', () => {
  const dir = tmp();
  const docx = path.join(dir, 'plan.docx');
  createDocx(['Hello plant', 'Line two'], docx, 'Plan');
  const read = lm.readOfficeText(docx);
  assert.match(read.text, /Hello plant/);
  const mod = lm.modifyDocx(docx, { append: ['Added with permission'] });
  assert.equal(mod.appended, 1);
  const read2 = lm.readOfficeText(mod.path);
  assert.match(read2.text, /Added with permission/);
});

test('office read + modify round-trips xlsx', () => {
  const dir = tmp();
  const xlsx = path.join(dir, 'data.xlsx');
  createXlsx([['Item', 'Qty'], ['Bolts', 40]], xlsx);
  const read = lm.readOfficeText(xlsx);
  assert.ok(read.rows.length >= 2);
  const mod = lm.modifyXlsx(xlsx, { appendRows: [['Nuts', 12]], setCells: [{ cell: 'B2', value: 41 }] });
  assert.ok(mod.rows >= 3);
  const read2 = lm.readOfficeText(mod.path);
  assert.ok(read2.text.includes('Nuts'));
  assert.ok(read2.text.includes('41'));
});

test('shell exec runs allowlisted commands and blocks shell metachars', async () => {
  const ok = await lm.execCommand(process.execPath, ['--version']);
  assert.equal(ok.ok, true);
  assert.match(ok.output, /v\d+/);
  const blocked = await lm.execCommand('rm', ['-rf', '/']);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /blocked/);
});
