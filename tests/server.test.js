'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../src/server');

test('workbench UI serves real HTML (not JSON-blob)', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    for (const p of ['/', '/api/health', '/api/security']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 200, p);
      const buf = Buffer.from(await res.arrayBuffer());
      if (p === '/') {
        const head = buf.subarray(0, 15).toString('utf8').toLowerCase();
        assert.match(head, /<!doctype html/);
        assert.doesNotMatch(buf.toString('utf8', 0, 60), /"type":"Buffer"/);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
