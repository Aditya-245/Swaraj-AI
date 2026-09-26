'use strict';
// ============================================================
//  Swaraj Context — multi-session conversation memory.
//  Complements Swaraj Memory (src/memory.js): facts are forever,
//  turns are recent. The last few user/assistant exchanges are kept
//  per owner (`user:<id>` when signed in, else `local`) and prepended
//  to every model prompt, so follow-ups ("and the second one?",
//  "say that in Hindi") resolve — even in a brand-new session.
//
//  Storage: PostgreSQL `user_turns` when the DB is up, otherwise
//  data/context.json. Capped (MAX_TURNS kept, recent() slices fewer)
//  to protect small local models' context windows. Texts are sliced
//  to SLICE_CHARS — excerpts for reference, not transcripts.
// ============================================================
const fs = require('fs');
const path = require('path');

const MAX_TURNS = 20; // stored per owner (10 exchanges)
const RECENT_TURNS = 6; // fed to the model (3 exchanges)
const SLICE_CHARS = 500; // per-turn excerpt length

function sliceTurn(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, SLICE_CHARS);
}

// turns: [{role:'user'|'assistant', text}] oldest-first.
function contextBlock(turns) {
  const kept = (turns || [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && String(t.text || '').trim() !== '')
    .slice(-RECENT_TURNS);
  if (!kept.length) return '';
  return `Recent conversation on this machine (resolve follow-ups like "it", "that", "the second one" against it):\n` +
    kept.map((t) => `${t.role}: ${sliceTurn(t.text)}`).join('\n') + '\n';
}

class ContextStore {
  // getPool: async () => pool|null (null => file mode). Never throws out.
  constructor({ filePath, getPool = null } = {}) {
    this.filePath = filePath || path.join(__dirname, '..', 'data', 'context.json');
    this._getPool = getPool;
    this._tableReady = false;
    this._mode = null; // 'pg' | 'file' — sticky, see _exec
  }

  // Backend decided on first use and never flipped, so an append and a later
  // read can't land in different stores (a DB that is still recovering would
  // otherwise read back an empty thread). Restarting the server re-decides.
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
        await pool.query(`CREATE TABLE IF NOT EXISTS user_turns (
          id SERIAL PRIMARY KEY, owner TEXT NOT NULL, role TEXT NOT NULL,
          text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_turns_owner ON user_turns (owner, id DESC)');
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
      fs.writeFileSync(this.filePath, JSON.stringify(all));
      return true;
    } catch { return false; }
  }

  async append(owner, role, text) {
    owner = String(owner || 'local');
    if (role !== 'user' && role !== 'assistant') throw new Error('context: role must be user|assistant');
    text = sliceTurn(text);
    if (!text) return null;
    await this._exec(
      async (pool) => {
        await pool.query('INSERT INTO user_turns (owner, role, text) VALUES ($1,$2,$3)', [owner, role, text]);
        await pool.query(
          `DELETE FROM user_turns WHERE owner=$1 AND id NOT IN
           (SELECT id FROM user_turns WHERE owner=$1 ORDER BY id DESC LIMIT $2)`,
          [owner, MAX_TURNS]);
      },
      () => {
        const all = this._readFile();
        const list = Array.isArray(all[owner]) ? all[owner] : [];
        list.push({ role, text, ts: Date.now() });
        all[owner] = list.slice(-MAX_TURNS);
        this._writeFile(all);
      });
    return { owner, role };
  }

  async recent(owner, n = RECENT_TURNS) {
    owner = String(owner || 'local');
    return this._exec(
      async (pool) => {
        const { rows } = await pool.query(
          'SELECT role, text FROM user_turns WHERE owner=$1 ORDER BY id DESC LIMIT $2', [owner, n]);
        return rows.reverse();
      },
      () => (this._readFile()[owner] || []).slice(-n).map(({ role, text }) => ({ role, text })));
  }

  async clear(owner) {
    owner = String(owner || 'local');
    await this._exec(
      (pool) => pool.query('DELETE FROM user_turns WHERE owner=$1', [owner]),
      () => {
        const all = this._readFile();
        delete all[owner];
        this._writeFile(all);
      });
    return { owner };
  }
}

module.exports = { ContextStore, contextBlock, MAX_TURNS, RECENT_TURNS, SLICE_CHARS };
