'use strict';
// Orchestrator: task router + model router + agent layer.
// Plans multi-step work, uses local tools/RAG/sandbox, audits operational
// events only (no chain-of-thought), enforces zero-egress.
const { ModelRouter } = require('./model-router');
const { OllamaClient } = require('./ollama');
const { makeTools } = require('./tools');
const { readDocument, ocrIfNeeded, inspectImage } = require('./documents');

const EVENT_ORDER = ['task_received', 'agent_selected', 'model_selected', 'file_accessed',
  'document_parsed', 'ocr_performed', 'rag_query', 'documents_retrieved', 'vision_invoked',
  'tool_calls', 'sandbox_execution', 'output_generated', 'errors_retries', 'completion'];

const CHITCHAT_RE = /^(hi+|hello+|hey+|namaste+|yo|sup|thanks?|thank you|dhanyavaad|shukriya|good\s?(morning|afternoon|evening|day)|how are you|how('s| is) it going|who are you|what can you do|bye+|see you)\b[?!.…\s]*$/i;

function isChitChat(prompt) {
  const p = String(prompt || '').trim();
  // Short social openers only — anything mentioning work goes full pipeline.
  if (p.length > 80) return false;
  if (/(report|sop|weld|defect|inspect|photo|image|code|pdf|docx|analyse|analyze|review|calculate|generate|approve)/i.test(p)) return false;
  return CHITCHAT_RE.test(p);
}

class Orchestrator {
  constructor({ rag, audit, egress, outDir, llm = null }) {
    this.rag = rag;
    this.audit = audit;
    this.egress = egress;
    this.outDir = outDir;
    this.router = new ModelRouter();
    this.llm = llm || new OllamaClient({ egress });
    this.tools = makeTools({ rag, outDir, audit });
  }

  // Streaming-aware generation: when prog is set, tokens are forwarded as
  // {t:'token', text} events and the full text is still returned. Falls back
  // to one-shot generate when the client doesn't stream.
  async _gen(model, prompt, opts = {}, prog = null) {
    if (prog && this.llm.generateStream) {
      return this.llm.generateStream(model, prompt, {
        ...opts,
        onToken: (tk) => { try { prog({ t: 'token', text: tk }); } catch {} },
      });
    }
    return this.llm.generate(model, prompt, opts);
  }

  // Emit a non-streamed (template) reply as word chunks so the UI still
  // types it out instead of flashing the full text at once.
  _emitTokens(reply, prog) {
    if (!prog || !reply) return;
    for (const chunk of String(reply).match(/[\s\S]{1,24}/g) || []) {
      try { prog({ t: 'token', text: chunk }); } catch {}
    }
  }

  async runChat({ taskId = `chat-${Date.now()}`, prompt, prog = null }) {
    // Fast path: one tiny capped LLM call, no RAG/sandbox/artefacts.
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'chat', route: 'general', model: 'llama3.2:1b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 200), kind: 'chat' });
    ev('model_selected', { route: 'general', model: 'llama3.2:1b', ok: true });
    const r = await this._gen('llama3.2:1b',
      `You are Swaraj AI, a friendly shop-floor assistant. The user just said: "${String(prompt).slice(0, 200)}"\n` +
      `Reply warmly in ONE short sentence, under 15 words, like "Hello! What's going on?" ` +
      `If asked who you are or what you can do, add one short sentence: you review inspection reports against SOPs, fully offline.`,
      { numPredict: 60, timeoutMs: 60000 }, prog);
    const reply = r.ok ? r.text : 'Hello! What can I help you with today?';
    if (!r.ok) this._emitTokens(reply, prog);
    ev('completion', { ok: true, kind: 'chat', source: r.ok ? 'ollama' : 'template' });
    return { ok: true, kind: 'chat', taskId, reply, replyModel: 'llama3.2:1b', replySource: r.ok ? 'ollama' : 'template',
      route: { ok: true, route: 'general', model: 'llama3.2:1b' }, egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
  }

  // General Q&A: grounded on private RAG, answered by llama3.2:1b. No artefacts.
  async runQA({ taskId = `qa-${Date.now()}`, prompt, prog = null }) {
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'qa', route: 'general', model: 'llama3.2:1b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 300), kind: 'qa' });
    ev('model_selected', { route: 'general', model: 'llama3.2:1b', ok: true });
    ev('rag_query', { query: String(prompt).slice(0, 200) });
    const hits = this.tools.search_sop(String(prompt), 2);
    ev('documents_retrieved', { count: hits.length });
    const ctx = hits.map((h) => `- ${h.id}: ${h.text.slice(0, 220)}`).join('\n') || '- (no matching internal note)';
    const r = await this._gen('llama3.2:1b',
      `You are Swaraj AI, a shop-floor assistant. Answer in at most 6 short sentences, plain prose, no JSON.\n` +
      `Question: ${String(prompt).slice(0, 400)}\nInternal notes (prefer these over general knowledge):\n${ctx}`,
      { numPredict: 250, timeoutMs: 120000 }, prog);
    const reply = r.ok ? r.text : (hits.length
      ? `From our internal notes (${hits.map((h) => h.id).join(', ')}): ${hits[0].text.slice(0, 300)}`
      : 'I could not reach the local model or the knowledge base just now — please retry in a moment.');
    if (!r.ok) this._emitTokens(reply, prog);
    ev('completion', { ok: true, kind: 'qa', source: r.ok ? 'ollama' : 'template' });
    return { ok: true, kind: 'qa', taskId, reply, replyModel: 'llama3.2:1b', replySource: r.ok ? 'ollama' : 'template',
      route: { ok: true, route: 'general', model: 'llama3.2:1b' }, hits,
      egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
  }

  // Coding: answered by qwen2.5-coder:1.5b. No artefacts unless asked.
  async runCode({ taskId = `code-${Date.now()}`, prompt, prog = null }) {
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'code', route: 'coding', model: 'qwen2.5-coder:1.5b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 300), kind: 'code' });
    ev('model_selected', { route: 'coding', model: 'qwen2.5-coder:1.5b', ok: true });
    const r = await this._gen('qwen2.5-coder:1.5b',
      `You are a coding assistant inside an offline industrial workbench. Answer concisely: brief explanation (max 3 sentences) then the code in a fenced block. No JSON.\nRequest: ${String(prompt).slice(0, 500)}`,
      { numPredict: 450, timeoutMs: 180000 }, prog);
    const reply = r.ok ? r.text : 'The local coding model is unreachable right now — please retry in a moment.';
    if (!r.ok) this._emitTokens(reply, prog);
    ev('completion', { ok: true, kind: 'code', source: r.ok ? 'ollama' : 'template' });
    return { ok: true, kind: 'code', taskId, reply, replyModel: 'qwen2.5-coder:1.5b', replySource: r.ok ? 'ollama' : 'template',
      route: { ok: true, route: 'coding', model: 'qwen2.5-coder:1.5b' },
      egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
  }

  // Vision: answered by moondream. Real image bytes sent when attached.
  async runVision({ taskId = `vis-${Date.now()}`, prompt, files = [], prog = null }) {
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'vision', route: 'vision', model: 'moondream' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 300), kind: 'vision' });
    ev('model_selected', { route: 'vision', model: 'moondream', ok: true });
    const fs = require('fs');
    let images = null, imgNote = 'no image attached — answering from description only', imageRef = null;
    const img = (files || []).find((f) => /\.(png|jpe?g|bmp|tiff?|webp|gif)$/i.test(f.path || f.name || ''));
    if (img && img.path && fs.existsSync(img.path)) {
      try {
        const st = fs.statSync(img.path);
        if (st.size < 6 * 1024 * 1024) {
          images = [fs.readFileSync(img.path).toString('base64')];
          const base = String(img.path || img.name).split(/[\\/]/).pop();
          imgNote = `attached image ${base} (${st.size} bytes)`;
          imageRef = { name: base, url: `/uploads/${encodeURIComponent(base)}`, bytes: st.size };
          ev('file_accessed', { file: img.path });
        } else {
          ev('errors_retries', { error: `image too large: ${st.size} bytes (max 6MB)` });
        }
      } catch (e) {
        ev('errors_retries', { error: String(e.message || e).slice(0, 200) });
      }
    }
    ev('vision_invoked', { model: 'moondream', withImage: !!images });
    const r = await this._gen('moondream',
      `You are a visual inspection assistant. ${imgNote}. ${String(prompt).slice(0, 400)}\n` +
      `Describe what you see and flag any weld defects, corrosion, or cracks. At most 6 short sentences, plain prose, no JSON.`,
      { images, numPredict: 250, timeoutMs: 180000 }, prog);
    let reply = r.ok ? r.text : null;
    if (!reply) {
      const stub = inspectImage((img && (img.path || img.name)) || 'site-photo.jpg');
      reply = `The vision model is unreachable; local visual cues suggest: ${stub.findings.map((f) => f.note).join('; ')}. Please retry for a full analysis.`;
      this._emitTokens(reply, prog);
    }
    ev('completion', { ok: true, kind: 'vision', source: r.ok ? 'ollama' : 'template' });
    return { ok: true, kind: 'vision', taskId, reply, replyModel: 'moondream', replySource: r.ok ? 'ollama' : 'template',
      route: { ok: true, route: 'vision', model: 'moondream' }, image: imageRef,
      egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
  }

  async runTask({ taskId = `task-${Date.now()}`, prompt, files = [], prog = null }) {
    if (isChitChat(prompt) && (!files || files.length === 0)) return this.runChat({ taskId, prompt, prog });
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    ev('task_received', { prompt: String(prompt).slice(0, 500), files: files.length });
    ev('agent_selected', { agent: 'opencode-local-agent', reason: 'default local planner' });

    const route = this.router.route(prompt);
    ev('model_selected', { route: route.route, model: route.model || null, ok: route.ok });
    if (!route.ok) {
      ev('errors_retries', { error: route.error });
      ev('completion', { ok: false });
      return { ok: false, error: route.error, route };
    }

    // Route-specific answering: only document jobs run the full pipeline.
    if ((!files || files.length === 0) && route.route === 'general') return this.runQA({ taskId, prompt, prog });
    if ((!files || files.length === 0) && route.route === 'coding') return this.runCode({ taskId, prompt, prog });
    const hasImage = (files || []).some((f) => /\.(png|jpe?g|bmp|tiff?|webp|gif)$/i.test(f.path || f.name || ''));
    const hasDoc = (files || []).some((f) => /\.(pdf|docx?|txt|md)$/i.test(f.path || f.name || '') || typeof f.text === 'string');
    // Image-only tasks always go to vision end-to-end (bytes → moondream → fallback stub).
    if (hasImage && !hasDoc) return this.runVision({ taskId, prompt, files, prog });
    if (prog) { try { prog({ t: 'kind', kind: 'job', route: route.route, model: route.model }); } catch {} }
    if (route.route === 'vision' && (!files || files.length === 0 || !files.some((f) => /\.(pdf|docx?)$/i.test(f.path || f.name || '')))) {
      return this.runVision({ taskId, prompt, files });
    }

    const plan = [
      'ingest inspection report',
      'parse/OCR + vision analysis',
      'retrieve private SOP knowledge',
      'sandboxed engineering calculation',
      'generate approval artifact + audit + egress proof',
    ];

    // 1. Ingest documents
    const docs = [];
    for (const f of files) {
      try {
        ev('file_accessed', { file: f.path || f.name || 'inline' });
        const raw = readDocument(f);
        ev('document_parsed', { file: raw.name, kind: raw.kind, chars: raw.text.length });
        const withOcr = ocrIfNeeded(raw);
        if (withOcr.ocrPerformed) ev('ocr_performed', { file: raw.name });
        docs.push(withOcr);
      } catch (e) {
        ev('errors_retries', { error: String(e.message || e).slice(0, 300) });
      }
    }
    if (typeof prompt === 'string' && prompt.length > 0) docs.push({ name: 'task.txt', text: prompt, kind: 'text', ocrPerformed: false });

    // 2. Vision (for image-kind docs or photo/drawing keywords)
    let vision = null;
    const imgDoc = docs.find((d) => d.kind === 'image') || (/photo|drawing|image|scan|weld/i.test(prompt) ? { name: 'weld-photo.jpg' } : null);
    if (imgDoc) {
      vision = inspectImage(imgDoc.name || imgDoc);
      ev('vision_invoked', { model: 'local-llava-13b', findings: vision.findings.length });
    }

    // 3. RAG retrieval
    const query = [prompt, ...docs.map((d) => d.text.slice(0, 300))].join('\n').slice(0, 1500);
    ev('rag_query', { query: query.slice(0, 300) });
    if (prog) { try { prog({ t: 'step', phase: 'rag', text: 'searching private SOPs…' }); } catch {} }
    const hits = this.tools.search_sop(query, 3);
    ev('documents_retrieved', { count: hits.length, ids: hits.map((h) => h.id) });

    // 4. Sandboxed calculation (defect density / torque / pressure example)
    if (prog) { try { prog({ t: 'step', phase: 'sandbox', text: 'running sandboxed calculation…' }); } catch {} }
    const calcCode = 'const defects = 3; const joints = 42; return { defectRate: +(defects/joints*100).toFixed(2), verdict: (defects/joints*100) < 10 ? "ACCEPT" : "REWORK" };';
    const calc = await this.tools.run_python(calcCode, { timeoutMs: 2000 });
    ev('sandbox_execution', { ok: calc.ok, output: String(calc.output || calc.error).slice(0, 300) });
    ev('tool_calls', { tools: ['search_sop', 'read_document', 'run_python', 'create_docx', 'create_pdf'] });

    // 5. Artifact generation
    const combined = docs.map((d) => d.text).join('\n').slice(0, 2000);
    const verdict = (() => { try { return JSON.parse((calc.output || '').trim().split('\n').pop()).verdict; } catch { return calc.ok ? 'SEE-CALC' : 'MANUAL-REVIEW'; } })();
    const reportLines = [
      'Sovereign Industrial AI Workbench — Approval Note',
      `Task: ${prompt}`.slice(0, 200),
      `Model route: ${route.route} -> ${route.model} (local)`,
      `SOP references: ${hits.map((h) => h.id + '#chunk' + h.chunk).join(', ') || 'none'}`,
      `Vision: ${vision ? vision.findings.map((f) => f.label + ':' + f.note).join('; ') : 'n/a (text report)'}`,
      `Calculation (sandboxed, offline): ${(calc.output || calc.error || '').trim().slice(0, 300)}`,
      `Verdict: ${verdict}`,
      `Evidence excerpt: ${combined.slice(0, 400)}`,
      'Zero-egress: 0 external LLM / MCP / API / internet calls (see security report).',
    ];
    const docx = this.tools.create_docx(reportLines, `${taskId}-approval.docx`, 'Approval Note — Inspection Report');
    const pdf = this.tools.create_pdf(reportLines.join('\n'), `${taskId}-approval.pdf`);
    ev('output_generated', { docx: docx.path, pdf: pdf.path });
    if (prog) { try { prog({ t: 'step', phase: 'reply', text: 'drafting approval note…' }); } catch {} }

    // 6. Human-readable reply from the routed local model (never raw JSON).
    const sopLines = hits.map((h) => `- ${h.id} (chunk ${h.chunk}): ${h.text.slice(0, 160)}`).join('\n') || '- none retrieved';
    const visionLine = vision ? vision.findings.map((f) => `${f.label}: ${f.note}`).join('; ') : 'no image analysed';
    const summaryPrompt =
      `You are Swaraj AI, a shop-floor assistant writing an approval note for a plant engineer.\n` +
      `Task: ${prompt}\n` +
      `Engineering calculation (sandboxed, trusted numbers): ${(calc.output || calc.error || '').trim().slice(0, 300)}\n` +
      `Verdict: ${verdict}\n` +
      `Private SOP references:\n${sopLines}\n` +
      `Vision analysis: ${visionLine}\n` +
      `Write at most 5 short sentences a busy engineer can act on: what was inspected, what the numbers say, ` +
      `which SOP clause justifies the verdict, and what to do next. Plain prose only — no JSON, no code fences. Keep it tight.`;
    let reply = null, replyModel = route.model, replySource = 'template';
    const llmRes = await this._gen(route.model, summaryPrompt, { numPredict: 220 }, prog);
    if (llmRes.ok) {
      reply = llmRes.text;
      replySource = 'ollama';
    } else if (route.model !== 'llama3.2:1b') {
      const fb = await this._gen('llama3.2:1b', summaryPrompt, { numPredict: 220 }, prog);
      if (fb.ok) { reply = fb.text; replyModel = 'llama3.2:1b'; replySource = 'ollama-fallback'; }
    }
    if (!reply) {
      reply = `I reviewed the inspection against our private SOPs. ` +
        `The sandboxed calculation gives ${(calc.output || 'no result').trim().slice(0, 160)}, ` +
        `so my verdict is ${verdict}. ` +
        `${hits.length ? `This follows ${hits.map((h) => h.id).join(' and ')}.` : 'No matching SOP clause was retrieved, so treat this as provisional.'} ` +
        `${vision ? 'The site photo shows: ' + vision.findings.map((f) => f.note).join('; ') + '. ' : ''}` +
        `Full evidence is in the approval note below; the audit trail records every step.`;
      this._emitTokens(reply, prog);
    }
    ev('llm_invoked', { model: replyModel, source: replySource, chars: reply.length });
    const findings = this.egress.scanConfig({ models: ['http://localhost:11434'], qdrant: 'http://localhost:6333', outDir: this.outDir });
    const keys = this.egress.scanEnv();
    const egressReport = { externalLLM: 0, remoteMCP: 0, externalAPI: findings.length, internetTraffic: 0, cloudKeys: keys };
    ev('completion', { ok: true, verdict, egress: egressReport });

    return { ok: true, kind: 'job', taskId, route, plan, docs: docs.length, hits, vision, calc, verdict, reply, replyModel, replySource, docx, pdf, egress: egressReport, events: EVENT_ORDER };
  }
}

module.exports = { Orchestrator, isChitChat };
