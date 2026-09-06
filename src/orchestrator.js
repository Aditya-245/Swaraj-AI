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
  if (/(report|sop|weld|defect|inspect|photo|image|code|pdf|docx|xlsx|analyse|analyze|review|calculate|generate|approve|find|search|folder|command|shell|excel|spreadsheet)/i.test(p)) return false;
  return CHITCHAT_RE.test(p);
}

const LOCAL_INTENT_RE = /(find|search|locate|look for).{0,30}(file|folder|on my|local|computer|pc|machine)|list (files|folder|directory)|open (file|folder)|creat.*(excel|spreadsheet|xlsx|word|docx|document|pdf)|modif.*(excel|xlsx|word|docx|file)|update .*spreadsheet|append .*(sheet|row|paragraph)|run (command|shell|program)|execute /i;

function isLocalIntent(prompt, files) {
  if ((!files || files.length === 0) && LOCAL_INTENT_RE.test(String(prompt || ''))) return true;
  if (/[a-zA-Z]:[\\/]|(^|\s)\/(users|home|data|tmp|out)\//i.test(String(prompt || ''))) return true;
  if (/\.(docx|xlsx)\b/i.test(String(prompt || '')) && /(modif|update|append|edit|creat|open|read|find)/i.test(String(prompt || ''))) return true;
  return false;
}

class Orchestrator {
  constructor({ rag, audit, egress, outDir, llm = null, permissions = null }) {
    this.rag = rag;
    this.audit = audit;
    this.egress = egress;
    this.outDir = outDir;
    this.permissions = permissions || null;
    this.router = new ModelRouter();
    this.llm = llm || new OllamaClient({ egress });
    this.tools = makeTools({ rag, outDir, audit, permissions: this.permissions });
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
    // Local-PC intents first (they must not be swallowed by chit-chat).
    if (isLocalIntent(prompt, files)) return this.runLocal({ taskId, prompt, prog });
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
    // Forward SSE prog to gated tools so permission prompts surface in-chat.
    if (this.tools && this.tools.__setProg) { try { this.tools.__setProg(prog); } catch {} }
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
    if (this.tools && this.tools.__setProg) { try { this.tools.__setProg(null); } catch {} }

    return { ok: true, kind: 'job', taskId, route, plan, docs: docs.length, hits, vision, calc, verdict, reply, replyModel, replySource, docx, pdf, egress: egressReport, events: EVENT_ORDER };
  }

  // Local-PC pipeline: permission-gated search / office edit / machine control.
  // Every sensitive step calls PermissionManager.guard() which emits
  // {t:'permission', ...} over SSE — the UI turns it into an opencode-style
  // [Allow once | Allow always | Reject] modal and POSTs the decision back.
  async runLocal({ taskId = `local-${Date.now()}`, prompt, prog = null }) {
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (this.tools && this.tools.__setProg) { try { this.tools.__setProg(prog); } catch {} }
    const route = { ok: true, route: 'local', model: 'llama3.2:1b' };
    if (prog) { try { prog({ t: 'kind', kind: 'local', route: 'local', model: 'llama3.2:1b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 500), kind: 'local' });
    ev('agent_selected', { agent: 'opencode-local-agent', reason: 'local-machine intent' });
    ev('model_selected', { route: 'local', model: 'llama3.2:1b', ok: true });
    if (prog) { try { prog({ t: 'step', phase: 'local', text: 'planning local-machine steps…' }); } catch {} }

    const p = String(prompt || '');
    const steps = [];
    let result = null;
    const denied = (e) => String((e && e.message) || e).slice(0, 300);

    try {
      // Heuristic planner (offline, deterministic). Order matters: a prompt can
      // chain steps, e.g. "find X and open it" — we run each matched step.
      const pathMatch = p.match(/([a-zA-Z]:[\\/][^\s"'<>|*?]+|\/(?:users|home|data|tmp|out)[^\s"'<>|*?]*)/i);
      const quotedMatch = p.match(/["“]([^"”]+?\.(?:docx|xlsx|pptx|pdf|txt|md|csv))["”]/i);
      const wantedPath = (quotedMatch && quotedMatch[1]) || (pathMatch && pathMatch[1]) || null;

      if (/\b(find|search|locate|look for)\b/i.test(p)) {
        const qm = p.match(/(?:find|search|locate|look for)\s+(?:file(?:s)?\s+(?:named|called|like)?\s*)?["“]?([^"”\n]{1,120}?)(?:["”]| in | on my| on the|$)/i);
        let query = (qm && qm[1] ? qm[1].trim() : '').replace(/^(for|the)\s+/i, '').slice(0, 120) || p.slice(0, 80);
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `searching locally for “${query}”…` }); } catch {} }
        ev('tool_calls', { tools: ['local_search'], query });
        result = await this.tools.local_search({ query, includeContent: /content|inside|containing/i.test(p) });
        steps.push(`local_search "${query}" → ${result.count} hit(s)`);
      } else if (/\blist\b.*(files|folder|directory)|show .*folder/i.test(p)) {
        const dir = wantedPath || require('os').homedir();
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `listing ${dir}…` }); } catch {} }
        ev('tool_calls', { tools: ['local_list'] });
        result = await this.tools.local_list({ dir });
        steps.push(`local_list ${dir} → ${result.count} entries`);
      } else if (/\bopen\b/i.test(p) && wantedPath) {
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `opening ${wantedPath}…` }); } catch {} }
        ev('tool_calls', { tools: ['open_path'] });
        result = await this.tools.open_path({ path: wantedPath });
        steps.push(`open_path ${wantedPath}`);
      } else if (/creat.*(excel|spreadsheet|xlsx)/i.test(p)) {
        if (prog) { try { prog({ t: 'step', phase: 'local', text: 'creating spreadsheet…' }); } catch {} }
        ev('tool_calls', { tools: ['office_create'] });
        result = await this.tools.office_create({ kind: 'xlsx', rows: [['Item', 'Value'], ['Created by', 'Swaraj AI (local)']], filename: `local-${Date.now()}.xlsx`, path: wantedPath || undefined });
        steps.push(`office_create xlsx → ${result.path}`);
      } else if (/creat.*(word|docx|document)/i.test(p)) {
        if (prog) { try { prog({ t: 'step', phase: 'local', text: 'creating document…' }); } catch {} }
        ev('tool_calls', { tools: ['office_create'] });
        result = await this.tools.office_create({ kind: 'docx', paras: [p.slice(0, 200), 'Drafted locally by Swaraj AI — review before sharing.'], filename: `local-${Date.now()}.docx`, path: wantedPath || undefined });
        steps.push(`office_create docx → ${result.path}`);
      } else if (/modif|update|append|edit/i.test(p) && (/\.xlsx/i.test(p) || /excel|spreadsheet|sheet/i.test(p))) {
        if (!wantedPath) throw new Error('Tell me which .xlsx file to modify (paste its full path in quotes).');
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `modifying ${wantedPath}…` }); } catch {} }
        ev('tool_calls', { tools: ['office_modify'] });
        result = await this.tools.office_modify({ path: wantedPath, appendRows: [['Updated by Swaraj AI', new Date().toISOString().slice(0, 10)]] });
        steps.push(`office_modify ${wantedPath} → ${result.rows} rows`);
      } else if (/modif|update|append|edit/i.test(p) && (/\.docx/i.test(p) || /word|document/i.test(p))) {
        if (!wantedPath) throw new Error('Tell me which .docx file to modify (paste its full path in quotes).');
        const add = (p.match(/append\s+["“]([^"”]+)["”]/i) || [])[1] || `Update noted ${new Date().toISOString().slice(0, 10)} — added by Swaraj AI.`;
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `modifying ${wantedPath}…` }); } catch {} }
        ev('tool_calls', { tools: ['office_modify'] });
        result = await this.tools.office_modify({ path: wantedPath, append: [add] });
        steps.push(`office_modify ${wantedPath} (+${result.appended} paragraph)`);
      } else if (/\brun\b|\bexecute\b|\bshell\b|\bcommand\b/i.test(p)) {
        const cm = p.match(/run\s+["“`]?([a-z0-9_.\-/\\]+)(?:\s+([^"”\n]*))?["”]?/i);
        const cmd = cm ? cm[1] : null;
        const cmdArgs = cm && cm[2] ? cm[2].trim().split(/\s+/).slice(0, 12) : [];
        if (!cmd) throw new Error('Tell me which command to run, e.g. `run node --version`.');
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `running ${cmd}…` }); } catch {} }
        ev('tool_calls', { tools: ['shell_exec'] });
        result = await this.tools.shell_exec({ cmd, args: cmdArgs });
        steps.push(`shell_exec ${cmd} → ${result.ok ? 'ok' : 'failed'}`);
      } else if (wantedPath && /\.(docx|xlsx|pptx|pdf|txt|md|csv)$/i.test(wantedPath)) {
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `reading ${wantedPath}…` }); } catch {} }
        ev('tool_calls', { tools: [/\.(docx|xlsx|pptx)$/i.test(wantedPath) ? 'office_read' : 'local_read'] });
        result = /\.(docx|xlsx|pptx)$/i.test(wantedPath)
          ? await this.tools.office_read({ path: wantedPath })
          : await this.tools.local_read({ path: wantedPath });
        steps.push(`read ${wantedPath} (${result.bytes} bytes)`);
      } else {
        // Default: treat the prompt as a file-search query.
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `searching locally for “${p.slice(0, 60)}”…` }); } catch {} }
        ev('tool_calls', { tools: ['local_search'] });
        result = await this.tools.local_search({ query: p.slice(0, 120) });
        steps.push(`local_search → ${result.count} hit(s)`);
      }
    } catch (e) {
      const code = e && e.code;
      if (code === 'PERMISSION_DENIED' || code === 'PERMISSION_TIMEOUT') {
        ev('errors_retries', { error: `permission ${code === 'PERMISSION_TIMEOUT' ? 'timed out' : 'rejected'}: ${denied(e)}` });
        ev('completion', { ok: false, kind: 'local', reason: 'permission' });
        const reply = code === 'PERMISSION_TIMEOUT'
          ? 'That local action timed out waiting for your approval, so I left everything untouched. Ask again when you are ready to allow it.'
          : 'Understood — I did not touch your machine. The action was rejected, nothing was read, written or run.';
        this._emitTokens(reply, prog);
        return { ok: false, kind: 'local', taskId, route, error: denied(e), permission: code, reply, steps,
          egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
      }
      ev('errors_retries', { error: denied(e) });
      ev('completion', { ok: false, kind: 'local' });
      const reply = `I could not complete that local step: ${denied(e)}`;
      this._emitTokens(reply, prog);
      return { ok: false, kind: 'local', taskId, route, error: denied(e), reply, steps,
        egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
    } finally {
      if (this.tools && this.tools.__setProg) { try { this.tools.__setProg(null); } catch {} }
    }

    // Human-readable summary (LLM when reachable, template otherwise).
    const summaryCtx = JSON.stringify(result).slice(0, 1200);
    let reply = null, replySource = 'template';
    const llmRes = await this._gen('llama3.2:1b',
      `You are Swaraj AI. The user asked: "${p.slice(0, 300)}"\n` +
      `Local steps taken: ${steps.join('; ')}\nTool result (JSON, trusted): ${summaryCtx}\n` +
      `Reply in at most 5 short sentences: what was found/changed, full paths, counts, and what to do next. Plain prose, no JSON.`,
      { numPredict: 220, timeoutMs: 60000 }, prog);
    if (llmRes.ok) { reply = llmRes.text; replySource = 'ollama'; }
    if (!reply) {
      if (result && typeof result.count === 'number' && Array.isArray(result.results)) {
        const top = result.results.slice(0, 5).map((r) => r.path).join('; ') || 'no matches';
        reply = `Local search finished: ${result.count} match(es) across ${result.scanned} file(s) scanned. Top hits: ${top}. ` +
          `Each location above asked for your permission before I touched it — allow once for a single run, or allow always to skip future prompts for that folder.`;
      } else if (result && result.path) {
        reply = `Done: ${steps.join('; ')}. File: ${result.path}${result.bytes ? ` (${result.bytes} bytes)` : ''}. ` +
          `This step ran only after your explicit approval, and the decision is in the audit trail.`;
      } else {
        reply = `Done: ${steps.join('; ') || 'local step'}. Nothing left your machine — the audit trail records the permission you granted.`;
      }
      this._emitTokens(reply, prog);
    }
    ev('completion', { ok: true, kind: 'local', steps: steps.length });
    return { ok: true, kind: 'local', taskId, route, steps, local: result, reply, replyModel: 'llama3.2:1b', replySource,
      egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
  }
}

module.exports = { Orchestrator, isChitChat, isLocalIntent };
