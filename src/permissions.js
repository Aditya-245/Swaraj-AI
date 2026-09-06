'use strict';
// PermissionManager — opencode-style gating for sensitive local-machine tools.
//
// Flow (mirrors opencode):
//   1. Agent/tool calls `guard(tool, scope, details)` before any sensitive op.
//   2. If an "allow always" rule covers (tool, scope) -> proceed silently.
//   3. If a "deny always" rule covers it -> throw PERMISSION_DENIED.
//   4. Otherwise a pending request is created:
//        { id, tool, scope, summary, risk, ts, status: 'pending' }
//      and the caller waits (up to timeoutMs) for the user to respond with
//      one of: 'once' | 'always' | 'reject'  (+ 'reject-always' for power users).
//   5. UI shows a modal with the same three choices opencode shows:
//        [ Allow once ]  [ Allow always ]  [ Reject ]
//
// Persistence: "always" rules live in data/permissions.json so they survive
// restarts. Pending requests are in-memory only (a restart = auto-expire).
// Every decision is appended to the audit trail (operational event only).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DECISIONS = ['once', 'always', 'reject', 'reject-always'];

// Risk ladder shown in the permission modal. Higher = scarier wording.
const TOOL_RISK = {
  local_search: 'low',
  local_list: 'low',
  local_read: 'medium',
  office_read: 'medium',
  office_create: 'medium',
  office_modify: 'high',
  local_write: 'high',
  shell_exec: 'high',
  open_path: 'medium',
};

const TOOL_LABEL = {
  local_search: 'Search local files',
  local_list: 'List folder',
  local_read: 'Read local file',
  office_read: 'Read Office document',
  office_create: 'Create Office document',
  office_modify: 'Modify Office document',
  local_write: 'Write local file',
  shell_exec: 'Run local command',
  open_path: 'Open file / folder',
};

function normScope(scope) {
  // Normalise a scope for prefix matching: absolute-ish, forward slashes,
  // no trailing slash (except drive root / fs root).
  let s = String(scope || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  // tool-only scope, e.g. "shell:node --version"
  if (/^[a-z0-9_-]+:/i.test(s) && !/^[a-zA-Z]:\//.test(s) && !s.startsWith('/')) return s;
  try {
    // Windows drive roots like C:/ — keep as-is (lowercased drive).
    const m = /^([a-zA-Z]):(\/.*)?$/.exec(s);
    if (m) {
      let rest = (m[2] || '/').replace(/\/+/g, '/');
      if (rest.length > 1) rest = rest.replace(/\/$/, '');
      return `${m[1].toLowerCase()}:${rest}`;
    }
  } catch {}
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

function scopeCovers(ruleScope, askScope) {
  // Rule covers request when equal, prefix, or wildcard tool-only match.
  const r = normScope(ruleScope);
  const a = normScope(askScope);
  if (!r || !a) return false;
  if (r === a) return true;
  if (r === '*') return true;
  // tool-class wildcard, e.g. rule "shell:*" covers "shell:node ..."
  if (r.endsWith(':*')) return a.startsWith(r.slice(0, -1));
  // path prefix: rule "c:/work" covers "c:/work/report.docx"
  if (/^[a-z]:\//i.test(r) || r.startsWith('/')) {
    return a.toLowerCase().startsWith(r.toLowerCase() + '/');
  }
  return false;
}

class PermissionManager {
  constructor({ filePath = null, audit = null, timeoutMs = 120000 } = {}) {
    this.filePath = filePath;
    this.audit = audit;
    this.timeoutMs = timeoutMs;
    this.rules = []; // [{ id, tool, scope, decision:'allow'|'deny', createdAt }]
    this.pending = new Map(); // id -> request
    this.waiters = new Map(); // id -> { resolve, timer }
    if (filePath) {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (Array.isArray(raw.rules)) this.rules = raw.rules.filter((r) => r && r.tool && r.scope);
        }
      } catch {}
    }
  }

  _save() {
    if (!this.filePath) return;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, rules: this.rules }, null, 2), 'utf8');
    } catch {}
  }

  _log(event) {
    try { this.audit && this.audit.append(event); } catch {}
  }

  riskOf(tool) { return TOOL_RISK[tool] || 'medium'; }
  labelOf(tool) { return TOOL_LABEL[tool] || tool; }

  findRule(tool, scope) {
    const s = normScope(scope);
    // Most specific rule wins (longest scope first).
    const cands = this.rules
      .filter((r) => r.tool === tool || r.tool === '*')
      .filter((r) => scopeCovers(r.scope, s))
      .sort((a, b) => String(b.scope).length - String(a.scope).length);
    return cands[0] || null;
  }

  isAllowed(tool, scope) {
    const rule = this.findRule(tool, scope);
    if (!rule) return null; // unknown -> needs prompt
    return rule.decision === 'allow';
  }

  listPolicy() {
    return { rules: this.rules.slice(), decisions: DECISIONS.slice(), tools: { ...TOOL_RISK } };
  }

  listPending() {
    return [...this.pending.values()].filter((r) => r.status === 'pending');
  }

  describe(tool, scope, details = {}) {
    return {
      tool,
      label: this.labelOf(tool),
      scope: String(scope || ''),
      risk: this.riskOf(tool),
      summary: String(details.summary || details.cmd || details.query || scope || tool).slice(0, 300),
      details,
    };
  }

  // Create a pending request and wait for the user's decision.
  // onPrompt(req) is called synchronously so the caller (orchestrator SSE)
  // can forward {t:'permission', ...req} to the UI.
  // Resolves true (granted once/always) or throws with code PERMISSION_*.
  request(tool, scope, details = {}, onPrompt = null) {
    const allowed = this.isAllowed(tool, scope);
    if (allowed === true) return Promise.resolve({ granted: true, via: 'always', requestId: null });
    if (allowed === false) {
      const err = new Error(`Permission denied by saved rule for ${tool} (${scope})`);
      err.code = 'PERMISSION_DENIED';
      err.tool = tool; err.scope = scope;
      return Promise.reject(err);
    }
    const id = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    const meta = this.describe(tool, scope, details);
    const req = {
      id, tool, scope: String(scope || ''), label: meta.label, risk: meta.risk,
      summary: meta.summary, details: meta.details || {},
      ts: new Date().toISOString(), status: 'pending',
    };
    this.pending.set(id, req);
    this._log({ event: 'permission_requested', tool, scope: req.scope, requestId: id, risk: req.risk });
    try { onPrompt && onPrompt({ ...req }); } catch {}

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const cur = this.pending.get(id);
        if (cur && cur.status === 'pending') {
          cur.status = 'expired';
          this.waiters.delete(id);
          this._log({ event: 'permission_expired', tool, scope: req.scope, requestId: id });
          const err = new Error(`Permission request timed out for ${tool} (${scope}) — treated as rejected`);
          err.code = 'PERMISSION_TIMEOUT';
          err.requestId = id; err.tool = tool; err.scope = scope;
          reject(err);
        }
      }, this.timeoutMs);
      // Unref so a forgotten prompt never keeps the server alive.
      try { timer.unref && timer.unref(); } catch {}
      this.waiters.set(id, { resolve, reject, timer, tool, scope: String(scope || '') });
    });
  }

  // Convenience: check saved rules first, else request+wait. Returns the
  // request id when granted via prompt (useful for audit), null when via rule.
  async guard(tool, scope, details = {}, onPrompt = null) {
    const r = await this.request(tool, scope, details, onPrompt);
    return r;
  }

  respond(requestId, decision) {
    const req = this.pending.get(requestId);
    if (!req) {
      const err = new Error('Permission request not found or already answered');
      err.code = 'PERMISSION_NOT_FOUND';
      throw err;
    }
    if (req.status !== 'pending') {
      const err = new Error(`Permission request already ${req.status}`);
      err.code = 'PERMISSION_SETTLED';
      throw err;
    }
    if (!DECISIONS.includes(decision)) {
      const err = new Error(`Unknown decision "${decision}" — want once|always|reject`);
      err.code = 'PERMISSION_BAD_DECISION';
      throw err;
    }
    const waiter = this.waiters.get(requestId);
    if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(requestId); }

    if (decision === 'once') {
      req.status = 'granted-once';
      req.decidedAt = new Date().toISOString();
      this._log({ event: 'permission_granted', tool: req.tool, scope: req.scope, requestId, mode: 'once' });
      waiter && waiter.resolve({ granted: true, via: 'once', requestId });
      return { ok: true, decision, request: { ...req } };
    }
    if (decision === 'always') {
      req.status = 'granted-always';
      req.decidedAt = new Date().toISOString();
      this.rules.push({
        id: (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')),
        tool: req.tool, scope: normScope(req.scope) || req.scope,
        decision: 'allow', createdAt: req.decidedAt,
      });
      this._save();
      this._log({ event: 'permission_granted', tool: req.tool, scope: req.scope, requestId, mode: 'always' });
      waiter && waiter.resolve({ granted: true, via: 'always', requestId });
      return { ok: true, decision, request: { ...req } };
    }
    if (decision === 'reject-always') {
      req.status = 'denied-always';
      req.decidedAt = new Date().toISOString();
      this.rules.push({
        id: (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')),
        tool: req.tool, scope: normScope(req.scope) || req.scope,
        decision: 'deny', createdAt: req.decidedAt,
      });
      this._save();
      this._log({ event: 'permission_denied', tool: req.tool, scope: req.scope, requestId, mode: 'reject-always' });
      if (waiter) {
        const err = new Error(`Permission rejected (never ask again) for ${req.tool} (${req.scope})`);
        err.code = 'PERMISSION_DENIED'; err.requestId = requestId; err.tool = req.tool; err.scope = req.scope;
        waiter.reject(err);
      }
      return { ok: true, decision, request: { ...req } };
    }
    // reject (this time only)
    req.status = 'denied';
    req.decidedAt = new Date().toISOString();
    this._log({ event: 'permission_denied', tool: req.tool, scope: req.scope, requestId, mode: 'once' });
    if (waiter) {
      const err = new Error(`Permission rejected for ${req.tool} (${req.scope})`);
      err.code = 'PERMISSION_DENIED'; err.requestId = requestId; err.tool = req.tool; err.scope = req.scope;
      waiter.reject(err);
    }
    return { ok: true, decision, request: { ...req } };
  }

  revoke(ruleId) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    if (this.rules.length !== before) {
      this._save();
      this._log({ event: 'permission_revoked', ruleId });
      return true;
    }
    return false;
  }

  clear() {
    this.rules = [];
    this._save();
    this._log({ event: 'permissions_cleared' });
  }
}

module.exports = { PermissionManager, DECISIONS, TOOL_RISK, TOOL_LABEL, normScope, scopeCovers };
