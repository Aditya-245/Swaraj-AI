'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ModelRouter } = require('../src/model-router');

test('router classifies coding/vision/document/general', () => {
  const r = new ModelRouter();
  assert.equal(r.route('write python code to parse csv').route, 'coding');
  assert.equal(r.route('analyze this photo of a weld').route, 'vision');
  assert.equal(r.route('summarize the SOP manual PDF').route, 'document');
  assert.equal(r.route('hello, plan my day').route, 'general');
});

test('router fails gracefully on missing model', () => {
  const r = new ModelRouter(undefined, []);
  const res = r.route('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /not available/);
});
