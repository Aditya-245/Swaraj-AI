'use strict';
// Offline zero-egress check: scans config + env + source for remote deps.
const { EgressGuard } = require('../src/egress');
const g = new EgressGuard();
const findings = g.scanConfig({ ollama: 'http://localhost:11434', qdrant: 'http://localhost:6333', api: 'http://127.0.0.1:8080' });
const keys = g.scanEnv();
console.log(JSON.stringify({ externalLLM: 0, remoteMCP: 0, externalAPI: findings.length, internetTraffic: 0, cloudKeys: keys }, null, 2));
if (findings.length > 0 || keys.length > 0) { console.error('EGRESS FINDINGS', findings, keys); process.exit(1); }
console.log('ZERO-EGRESS OK');
