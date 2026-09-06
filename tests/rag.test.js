'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RagIndex } = require('../src/rag');

test('rag ingest + retrieve + update + delete', () => {
  const rag = new RagIndex();
  rag.upsert('sop-1', 'Welding inspection requires visual check and dye penetrant test. Defect code W-12.');
  rag.upsert('sop-2', 'Canteen menu for Monday: rice and dal.');
  const hits = rag.search('welding dye penetrant defect');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'sop-1');
  assert.equal(rag.search('xyznonexistentterm').length, 0);
  rag.upsert('sop-1', 'Updated: torque wrench calibration every 90 days.');
  assert.equal(rag.search('torque wrench calibration')[0].id, 'sop-1');
  rag.remove('sop-1');
  assert.equal(rag.search('torque wrench').length, 0);
  assert.equal(rag.count(), 1);
});
