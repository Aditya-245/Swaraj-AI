'use strict';
// Offline Ollama client. Talks only to http://127.0.0.1:11434 (local).
// Every URL passes through EgressGuard — any non-local address throws.
// All failures are graceful ({ ok:false }) so the agent falls back to
// deterministic local templates instead of breaking the run.
const DEFAULT_BASE = 'http://127.0.0.1:11434';

async function postJson(url, payload, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

class OllamaClient {
  constructor({ base = DEFAULT_BASE, egress = null } = {}) {
    this.base = base.replace(/\/$/, '');
    this.egress = egress;
  }

  _guard(path) {
    const url = `${this.base}${path}`;
    if (this.egress) this.egress.assertLocalUrl(url);
    else if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
      throw new Error('Egress denied (zero-egress policy): ' + url);
    }
    return url;
  }

  async tags() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(this._guard('/api/tags'), { signal: ctrl.signal });
        if (!res.ok) return { ok: false, error: `http ${res.status}` };
        const j = await res.json();
        return { ok: true, models: (j.models || []).map((m) => m.name) };
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e).slice(0, 200) };
    }
  }

  // Plain text completion. images: optional base64 array (vision models).
  // keepAlive pins the model in memory so repeat chats skip reload.
  async generate(model, prompt, { images = null, numPredict = 400, timeoutMs = 120000, keepAlive = '30m' } = {}) {
    try {
      const payload = { model, prompt, stream: false, keep_alive: keepAlive, options: { num_predict: numPredict } };
      if (images) payload.images = images;
      const j = await postJson(this._guard('/api/generate'), payload, timeoutMs);
      const text = (j.response || '').trim();
      if (!text) return { ok: false, model, error: 'empty response from ' + model };
      return { ok: true, model, text };
    } catch (e) {
      return { ok: false, model, error: String(e.message || e).slice(0, 300) };
    }
  }

  // Streaming completion: calls onToken(chunk) as NDJSON tokens arrive.
  // Resolves { ok:true, model, text } with the full text, or { ok:false, ... }.
  async generateStream(model, prompt, { images = null, numPredict = 400, timeoutMs = 180000, keepAlive = '30m', onToken = null } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const payload = { model, prompt, stream: true, keep_alive: keepAlive, options: { num_predict: numPredict } };
      if (images) payload.images = images;
      const res = await fetch(this._guard('/api/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ollama http ${res.status}`);
      if (!res.body || typeof res.body.getReader !== 'function') {
        // No web-stream support: fall back to one-shot.
        const j = await res.json();
        const text = (j.response || '').trim();
        if (!text) return { ok: false, model, error: 'empty response from ' + model };
        if (onToken) onToken(text);
        return { ok: true, model, text };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(String(j.error).slice(0, 200));
          if (j.response) { text += j.response; if (onToken) { try { onToken(j.response); } catch {} } }
          if (j.done) { try { reader.cancel(); } catch {} break; }
        }
      }
      text = text.trim();
      if (!text) return { ok: false, model, error: 'empty response from ' + model };
      return { ok: true, model, text };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, model, error: 'timed out: ' + model };
      return { ok: false, model, error: String(e.message || e).slice(0, 300) };
    } finally {
      clearTimeout(t);
    }
  }
}

module.exports = { OllamaClient, DEFAULT_BASE };
