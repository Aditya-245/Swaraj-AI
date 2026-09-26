'use strict';
// ============================================================
//  Swaraj Memory — durable user/org facts across every session.
//  "My company name is Kalash Seeds" is remembered once and then:
//   - injected into every model prompt (chat/QA/code/vision/jobs),
//   - stamped into generated DOCX/PDF approval notes,
//   - listed in the UI with one-click forget.
//
//  Storage: PostgreSQL `user_memory` when the DB is up, otherwise a
//  local JSON file (data/memory.json) — desktop installs remember
//  with zero setup. Owner is `user:<id>` when signed in, else `local`.
//  Extraction is deterministic regex (no extra LLM call, auditable).
// ============================================================
const fs = require('fs');
const path = require('path');

const KEY_RE = /^[a-z][a-z0-9_-]{0,40}$/;

function cleanValue(v, max = 200) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.,;!?]+$/g, '')
    .trim()
    .slice(0, max);
}

function slugKey(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// Returns { remember: {key: value}, forget: [key] } — empty when the
// prompt carries no durable fact. Specific rules run before generic ones.
function extractFacts(prompt) {
  const remember = {};
  const forget = [];
  const text = String(prompt || '').trim();
  if (!text) return { remember, forget };

  // "forget my X" — explicit erasure first.
  let m = text.match(/\bforget\s+(?:that\s+)?my\s+(.+?)\s*[.?!]*$/i);
  if (m) {
    const what = m[1].toLowerCase().trim();
    if (/company(\s+name)?|organisation|organization/.test(what)) forget.push('company');
    else if (/\bname\b/.test(what)) forget.push('name');
    else if (/location|site|plant|factory|address|city/.test(what)) forget.push('location');
    else { const k = slugKey(what); if (KEY_RE.test(k)) forget.push(k); }
    return { remember, forget };
  }

  // Company: "my company name is Kalash Seeds", "our company is X", "company: X".
  m = text.match(/(?:my|our)\s+company(?:'s)?\s+name\s+is\s+([^,.;!?|\n]+)/i)
    || text.match(/(?:my|our)\s+company\s+is\s+([^,.;!?|\n]+)/i)
    || text.match(/\bcompany\s*:\s*([^,;|\n]+)/i);
  if (m) {
    const v = cleanValue(m[1]);
    if (v.length >= 2) remember.company = v;
  }
  // Person: "my name is ..." (capitalised words only, avoids sentences).
  m = text.match(/\bmy\s+name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/);
  if (m) remember.name = cleanValue(m[1], 80);
  // Place: "we are located in X", "our plant is at X" (commas kept for
  // "City, State", but trailing clauses cut: "Jalna, and we...").
  m = text.match(/(?:we\s+are\s+located\s+in|our\s+(?:plant|site|factory|office)\s+is\s+(?:in|at)|located\s+in)\s+([^.;!?|\n]+)/i);
  if (m) {
    const v = cleanValue(m[1].split(/,\s*(?:and|but|or|which|who|that|where|with|for)\b/i)[0]);
    if (v.length >= 2) remember.location = v;
  }
  // Generic: "remember (that) my X is Y" / "remember (that) X is Y".
  m = text.match(/\bremember\s+(?:that\s+)?(.{3,200}?)\s*$/i);
  if (m && !Object.keys(remember).length) {
    const inner = m[1].trim();
    const kv = inner.match(/^(?:my\s+)?(.+?)\s+is\s+(.+)$/i);
    if (kv) {
      const k = slugKey(kv[1]);
      const v = cleanValue(kv[2]);
      if (KEY_RE.test(k) && !/^(company|name|location)$/.test(k) && v.length >= 1) remember[k] = v;
      else if (/^(company|name|location)$/.test(k) && v.length >= 1 && !remember[k]) remember[k] = v;
    }
  }
  return { remember, forget };
}

class MemoryStore {
  // getPool: async () => pool|null (null => file mode). Never throws out.
  constructor({ filePath, getPool = null } = {}) {
    this.filePath = filePath || path.join(__dirname, '..', 'data', 'memory.json');
    this._getPool = getPool;
    this._tableReady = false;
    this._mode = null; // 'pg' | 'file' — sticky, see _exec
  }

  // The backend is decided on first use and never flipped mid-process, so a
  // write and a later read can never land in different stores. If PostgreSQL
  // fails mid-flight (e.g. still recovering) we drop to the file permanently
  // for this process; a restart re-decides once the DB is healthy.
  async _exec(pgFn, fileFn) {
    if (this._mode !== 'file') {
      const pool = await this._pool();
      if (pool) {
        try {
          const out = await pgFn(pool);
          this._mode = 'pg';
          return out;
        } catch { this._mode = 'file'; }
      } else this._mode = 'file';
    }
    return fileFn();
  }

  async _pool() {
    if (!this._getPool) return null;
    try {
      const pool = await this._getPool();
      if (pool && !this._tableReady) {
        await pool.query(`CREATE TABLE IF NOT EXISTS user_memory (
          owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (owner, key))`);
        this._tableReady = true;
      }
      return pool;
    } catch { return null; }
  }

  _readFile() {
    try {
      const j = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (j && typeof j === 'object') return j;
    } catch {}
    return {};
  }

  _writeFile(all) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2));
      return true;
    } catch { return false; }
  }

  async remember(owner, key, value) {
    owner = String(owner || 'local'); key = String(key || '');
    value = cleanValue(value);
    if (!KEY_RE.test(key) || !value) throw new Error('memory: need a valid key + value');
    await this._exec(
      (pool) => pool.query(
        `INSERT INTO user_memory (owner, key, value, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (owner, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
        [owner, key, value]),
      () => {
        const all = this._readFile();
        all[owner] = all[owner] || {};
        all[owner][key] = value;
        this._writeFile(all);
      });
    return { owner, key, value };
  }

  async getAll(owner) {
    owner = String(owner || 'local');
    return this._exec(
      async (pool) => {
        const { rows } = await pool.query('SELECT key, value FROM user_memory WHERE owner=$1 ORDER BY key', [owner]);
        const out = {};
        for (const r of rows) out[r.key] = r.value;
        return out;
      },
      () => this._readFile()[owner] || {});
  }

  async forget(owner, key) {
    owner = String(owner || 'local'); key = String(key || '');
    await this._exec(
      (pool) => pool.query('DELETE FROM user_memory WHERE owner=$1 AND key=$2', [owner, key]),
      () => {
        const all = this._readFile();
        if (all[owner]) { delete all[owner][key]; this._writeFile(all); }
      });
    return { owner, key };
  }
}

module.exports = { MemoryStore, extractFacts, cleanValue, slugKey, KEY_RE };
