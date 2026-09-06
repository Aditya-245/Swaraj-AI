'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { OllamaClient } = require('../src/ollama');
const { server } = require('../src/server');

test('generateStream yields incremental tokens then full text', async () => {
  const llm = new OllamaClient({});
  const tags = await llm.tags();
  if (!tags.ok) { console.log('skip: ollama down'); return; }
  const seen = [];
  const r = await llm.generateStream('llama3.2:1b', 'Say the word mango once.', {
    numPredict: 20, timeoutMs: 90000, onToken: (t) => seen.push(t),
  });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.ok(r.text.length > 0, 'expected reply text');
  assert.ok(seen.length > 0, 'expected incremental token callbacks');
  assert.equal(seen.join('').trim(), r.text);
});

test('POST /api/tasks/stream emits kind/token/done SSE events', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const kinds = [];
    let tokens = 0;
    let done = null;
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.t === 'kind') kinds.push(ev.kind);
        if (ev.t === 'token') tokens += 1;
        if (ev.t === 'done') { done = ev.result; try { reader.cancel(); } catch {} break; }
        if (ev.t === 'error') throw new Error(ev.error);
      }
      if (done) break;
    }
    assert.ok(kinds.length > 0, 'expected a kind event, got: ' + JSON.stringify(kinds));
    assert.ok(tokens > 0, 'expected token events before done');
    assert.ok(done && done.ok, 'expected done with ok result');
    assert.ok((done.reply || '').length > 0, 'expected reply text in done result');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
