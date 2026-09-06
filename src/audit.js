'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AuditTrail {
  constructor(filePath) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  append(event) {
    const prev = this._lastHash();
    const record = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      ts: new Date().toISOString(),
      prev,
      ...event,
    };
    const payload = JSON.stringify(record);
    record.hash = crypto.createHash('sha256').update(prev + payload).digest('hex');
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    return record;
  }

  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((l) => JSON.parse(l));
  }

  verify() {
    const records = this.readAll();
    let prev = '';
    for (const r of records) {
      if (r.prev !== prev) return { ok: false, reason: 'chain break at ' + r.id };
      const { hash, ...rest } = r;
      const payload = JSON.stringify(rest);
      const expect = crypto.createHash('sha256').update(r.prev + payload).digest('hex');
      if (expect !== hash) return { ok: false, reason: 'hash mismatch at ' + r.id };
      prev = hash;
    }
    return { ok: true, count: records.length };
  }

  _lastHash() {
    const all = this.readAll();
    if (all.length === 0) return '';
    return all[all.length - 1].hash || '';
  }
}

module.exports = { AuditTrail };
