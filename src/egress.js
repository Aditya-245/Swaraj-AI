'use strict';

// Zero-egress guard: allowlist-based. No external calls by default.
// Local-only: localhost, 127.0.0.1, ::1, unix sockets. Everything else denied.

const BLOCKED_PATTERNS = [
  /https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/i,
  /\bapi\.openai\.com\b/i,
  /\bapi\.anthropic\.com\b/i,
  /\bgenerativelanguage\.googleapis\.com\b/i,
  /\bazure\.com\b/i,
  /\bamazonaws\.com\b/i,
  /\btelemetry\b/i,
];

const EXTERNAL_ENV_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_KEY',
  'GOOGLE_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_TOKEN',
];

function isLocalUrl(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

function stringHitsExternal(s) {
  if (typeof s !== 'string') return null;
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(s)) return re.source;
  }
  return null;
}

class EgressGuard {
  constructor(opts = {}) {
    this.extraDeny = opts.extraDeny || [];
    this.events = [];
  }

  // Throws on external URL, returns true for local.
  assertLocalUrl(url) {
    if (isLocalUrl(url)) return true;
    const hit = stringHitsExternal(url) || 'non-local-host';
    const err = new Error(`Egress denied (zero-egress policy): ${url} [${hit}]`);
    err.code = 'EGRESS_DENIED';
    this.events.push({ ts: new Date().toISOString(), url, hit, denied: true });
    throw err;
  }

  // Scan a config object for remote dependencies / cloud fallback.
  scanConfig(obj) {
    const findings = [];
    const walk = (v, p) => {
      if (typeof v === 'string') {
        const hit = stringHitsExternal(v);
        if (hit) findings.push({ path: p, value: v.slice(0, 200), pattern: hit });
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${p}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) walk(val, p ? `${p}.${k}` : k);
      }
    };
    walk(obj, '');
    return findings;
  }

  // Check environment for cloud API keys that imply external dependency.
  scanEnv(env = process.env) {
    return EXTERNAL_ENV_KEYS.filter((k) => env[k] && String(env[k]).trim() !== '');
  }

  // Guarded fetch: only local URLs allowed. Falls back to global fetch.
  async fetch(url, opts) {
    this.assertLocalUrl(String(url));
    return fetch(url, opts);
  }
}

module.exports = { EgressGuard, isLocalUrl, stringHitsExternal, BLOCKED_PATTERNS };
