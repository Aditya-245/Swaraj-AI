'use strict';

// Minimal local RAG: chunking + token-overlap scoring. No external embeddings.
// Deterministic, stdlib-only, suitable for air-gapped baseline.

function tokenize(s) {
  return String(s).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
}

function chunkText(text, chunkSize = 500, overlap = 50) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
    if (i >= text.length) break;
    if (chunks.length > 10000) break; // safety cap
  }
  return chunks;
}

class RagIndex {
  constructor() {
    this.docs = new Map(); // id -> { text, chunks }
  }

  upsert(id, text) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('empty document');
    this.docs.set(id, { text, chunks: chunkText(text) });
  }

  remove(id) {
    return this.docs.delete(id);
  }

  search(query, topK = 3) {
    const qTokens = new Set(tokenize(query));
    if (qTokens.size === 0) return [];
    const scored = [];
    for (const [id, doc] of this.docs) {
      doc.chunks.forEach((ch, idx) => {
        const cTokens = new Set(tokenize(ch));
        let inter = 0;
        for (const t of qTokens) if (cTokens.has(t)) inter++;
        const score = inter / Math.sqrt(qTokens.size * Math.max(1, cTokens.size));
        if (inter > 0) scored.push({ id, chunk: idx, score, text: ch.slice(0, 300) });
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  count() {
    return this.docs.size;
  }
}

module.exports = { RagIndex, tokenize, chunkText };
