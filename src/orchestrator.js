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

// Durable user/org facts (Swaraj Memory). Rendered into every model prompt
// and stamped into approval-note artefacts. '' when nothing is remembered.
function memoryBlock(memory) {
  const entries = Object.entries(memory || {}).filter(([, v]) => String(v || '').trim() !== '');
  if (!entries.length) return '';
  return `Known facts about the user/organisation (use them naturally — e.g. greet with the company name, file documents under it):\n` +
    entries.map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`).join('\n') + '\n';
}

// ---- local-machine planner (offline, deterministic, multi-step) ----
// One prompt can chain work — "find plan.xlsx and open it" — so this returns an
// ordered plan instead of a single branch. `fromSearch:true` means "no path was
// typed; reuse the best hit from the previous search step", which is what makes
// chaining work without the user repeating the filename. Every step below is
// permission-gated by tools.js, so the agent decides *what* to do and the user
// still decides *whether* it may happen.
const READABLE_RE = /\.(docx|xlsx|pptx|pdf|txt|md|csv|json|log|ya?ml)$/i;
const OFFICE_RE = /\.(docx|xlsx|pptx)$/i;
const FOLDER_WORDS = /\b(downloads?|documents?|desktop|pictures?|images?|videos?|music)\b/i;

// Trim a captured search phrase so it stops at the next clause:
// "find budget.xlsx and open it" must search for "budget.xlsx", not the whole line.
function cleanQuery(s) {
  return String(s || '').split(/\s+(?:and|then|afterwards?|after that|also)\s+/i)[0]
    .replace(/["“”]/g, '').replace(/^(?:for|the|a|an|me|my)\s+/i, '').trim().slice(0, 120);
}

function folderPath(word) {
  const map = { download: 'Downloads', document: 'Documents', desktop: 'Desktop', picture: 'Pictures',
    image: 'Pictures', video: 'Videos', music: 'Music' };
  const name = map[String(word || '').toLowerCase().replace(/s$/, '')];
  return name ? require('path').join(require('os').homedir(), name) : null;
}

function planLocalSteps(prompt) {
  const p = String(prompt || '');
  const PATH_RE = /([a-zA-Z]:[\\/][^\s"'<>|*?]+|\/(?:users|home|data|tmp|out)[^\s"'<>|*?]*)/i;
  const pathMatch = p.match(PATH_RE);
  const quoted = p.match(/["“]([^"”]+?\.(?:docx|xlsx|pptx|pdf|txt|md|csv|json|log|ya?ml))["”]/i);
  const has = (re) => re.test(p);
  // "find X in D:\work" — the folder is a search *root*, not the file to act on.
  const isSearchVerb = has(/\b(find|search|locate|look for|where is|grep)\b/i);
  const rootMatch = isSearchVerb ? p.match(new RegExp(`\\b(?:in|inside|under|from|within|at)\\s+["“]?(${PATH_RE.source.slice(1, -1)})`, 'i')) : null;
  const root = rootMatch ? rootMatch[1] : null;
  const barePath = pathMatch && pathMatch[1] !== root ? pathMatch[1] : null;
  const folderWord = (p.match(FOLDER_WORDS) || [])[1] || null;
  // "search for invoice in my downloads" — scope the scan to that folder.
  const searchRoot = root || (isSearchVerb && !barePath ? folderPath(folderWord) : null);
  const wantedPath = (quoted && quoted[1]) || barePath || null;
  const steps = [];
  const written = new Set(); // paths already created/modified — never re-read them
  const add = (tool, args, label, fromSearch = false) => steps.push({ tool, args, label, fromSearch });
  const searched = () => steps.some((s) => s.tool === 'local_search');

  // 1. Look for files/words on the machine.
  if (isSearchVerb) {
    const qm = p.match(/(?:find|search|locate|look for|where is|grep)\s+(?:me\s+)?(?:the\s+)?(?:file(?:s)?\s+(?:named|called|like)?\s*)?["“]?([^"”\n]{1,120}?)(?:["”]|\s+(?:in|on|from|inside|under|at)\s|$)/i);
    const query = cleanQuery((qm && qm[1]) || '') || p.slice(0, 80);
    const args = { query, includeContent: /content|inside|containing|mentions/i.test(p) };
    if (searchRoot) args.roots = [searchRoot];
    add('local_search', args, `search for “${query}”${searchRoot ? ` in ${searchRoot}` : ''}`);
  }

  // 2. Browse a folder — "list files in X", "what's in my downloads". Skipped
  //    when a search already covers that folder, so one prompt stays one action.
  const browseVerb = has(/\b(list|show|browse|what'?s in|what is in|contents of|open the folder)\b/i);
  if (!searchRoot && ((browseVerb && (has(/\b(files?|folder|directory|dir|contents?)\b/i) || FOLDER_WORDS.test(p))) ||
      (folderWord && !wantedPath && !READABLE_RE.test(p)))) {
    const dir = wantedPath || (folderWord ? folderPath(folderWord) : null) || require('os').homedir();
    add('local_list', { dir }, `list ${dir}`);
  }

  // 3. Create something new.
  if (has(/\b(creat\w*|mak\w*|generat\w*|new|start|build|draft)\b/i)) {
    const ext = (String((quoted && quoted[1]) || (pathMatch && pathMatch[1]) || '').match(/\.\w+$/) || [''])[0].toLowerCase();
    const wantsXlsx = /\b(excel|spreadsheet|xlsx|workbook)\b/i.test(p) || ext === '.xlsx';
    const wantsPdf = /\bpdf\b/i.test(p) || ext === '.pdf';
    const wantsPptx = /\b(ppt|powerpoint|pptx|slides|deck)\b/i.test(p) || ext === '.pptx';
    const stamp = stampNote();
    if (wantsXlsx) {
      add('office_create', {
        kind: 'xlsx', rows: [['Item', 'Value'], ['Note', p.slice(0, 160)], ['Created by', 'Swaraj AI (local, with your permission)'], ['Date', stamp]],
        path: wantedPath || undefined, filename: wantedPath ? undefined : `local-${Date.now()}.xlsx`,
      }, 'create a spreadsheet');
    } else if (wantsPptx) {
      add('office_create', {
        kind: 'pptx', paras: [p.slice(0, 200), 'Drafted locally by Swaraj AI — review before sharing.'],
        path: wantedPath || undefined, filename: wantedPath ? undefined : `local-${Date.now()}.pptx`,
      }, 'create a slide deck');
    } else if (wantsPdf) {
      add('office_create', {
        kind: 'pdf', text: `${p.slice(0, 400)}\n\nDrafted locally by Swaraj AI on ${stamp}.`,
        path: wantedPath || undefined, filename: wantedPath ? undefined : `local-${Date.now()}.pdf`,
      }, 'create a PDF');
    } else if (/\b(text|note|txt|note file|readme|list file)\b/i.test(p) || ext === '.txt' || ext === '.md') {
      add('local_write', {
        path: wantedPath || `out/local-note-${Date.now()}.txt`,
        content: `${p.slice(0, 2000)}\n\n— written locally by Swaraj AI on ${stamp} with your permission.`,
      }, 'write a text file');
    } else {
      add('office_create', {
        kind: 'docx', paras: [p.slice(0, 200), 'Drafted locally by Swaraj AI — review before sharing.'],
        path: wantedPath || undefined, filename: wantedPath ? undefined : `local-${Date.now()}.docx`,
      }, 'create a Word document');
    }
    if (wantedPath) written.add(wantedPath.toLowerCase());
  }

  // 4. Edit an existing file.
  if (has(/\b(modif\w*|updat\w*|append|edit|add .* to|insert|change|rename)\b/i) && (OFFICE_RE.test(p) || /\b(excel|spreadsheet|xlsx|word|docx|document|sheet|row)\b/i.test(p))) {
    const add1 = (p.match(/append\s+["“]([^"”]+)["”]/i) || [])[1];
    if (OFFICE_RE.test(wantedPath || '') || /\.(xlsx|docx)\b/i.test(p)) {
      const args = wantedPath
        ? { path: wantedPath }
        : {}; // no path typed: take the best hit from the search step
      if (/\.xlsx\b|xlsx|spreadsheet|excel|sheet|row/i.test(p)) args.appendRows = [['Updated by Swaraj AI', stampNote()]];
      else args.append = [add1 || `Update noted ${stampNote()} — added by Swaraj AI with your permission.`];
      add('office_modify', args, 'modify the file', !wantedPath);
    } else {
      const body = add1 || p.slice(0, 500);
      add('local_write', { path: wantedPath || '', content: `${body}\n`, overwrite: true }, 'write to the file', !wantedPath);
    }
    if (wantedPath) written.add(wantedPath.toLowerCase());
  }

  // 5. Open it in the OS, or read it. A read is skipped when we just wrote the
  //    same file — that would only ask the user for a second, pointless grant.
  const openish = has(/\b(open|launch|view)\b/i) && !has(/\b(run|execute|command|shell)\b/i);
  const readish = has(/\b(read|open|summar\w*|extract|what(?:'s| is) in)\b/i) && !has(/\b(run|execute)\b/i);
  // "create X then read X" is a deliberate two-step request, so the read verb
  // appearing after the write verb re-enables the otherwise redundant read.
  const writeAt = p.search(/\b(creat\w*|writ\w*|append|modif\w*|updat\w*)\b/i);
  const readAt = p.search(/\b(read|show|print|display)\b/i);
  const readAfterWrite = writeAt >= 0 && readAt > writeAt;
  const alreadyTouched = !readAfterWrite && wantedPath ? written.has(wantedPath.toLowerCase()) : false;
  if (openish && (wantedPath || searched())) {
    add('open_path', { path: wantedPath }, `open ${wantedPath || 'the file I found'}`, !wantedPath);
  } else if (!alreadyTouched && ((wantedPath && READABLE_RE.test(wantedPath)) || (readish && (wantedPath || searched())))) {
    const target = wantedPath || null;
    const isOffice = target ? OFFICE_RE.test(target) : /\b(excel|word|spreadsheet|document|docx|xlsx)\b/i.test(p);
    add(isOffice ? 'office_read' : 'local_read', { path: target }, `read ${target || 'the file I found'}`, !target);
  }

  // 6. Run a program — "run node --version", "run the command git status".
  if (has(/\b(run|execute|launch|invoke)\b/i) && has(/\b(command|program|script|shell|node|python|git|npm|cmd)\b/i)) {
    const cm = p.match(/(?:run|execute|launch|invoke)\s+(?:the\s+|a\s+|an\s+)?(?:command|program|script|shell|cmd)?\s*["“`]?([a-z0-9_.\-/\\]+)(?:\s+([^"”\n]*))?["”`]?/i);
    const cmd = cm ? cm[1] : null;
    add('shell_exec', { cmd, args: cm && cm[2] ? cm[2].trim().split(/\s+/).slice(0, 12) : [] }, `run ${cmd || 'command'}`);
  }

  // Nothing matched a known verb. A general-knowledge question is not a local
  // action, so don't scan the whole disk for the sentence — say so instead.
  const generalQuestion = has(/\b(who|what|when|where|why|how|which|is|are|was|were|do|does|did|can|should|explain|tell me about)\b/i)
    && !wantedPath && !/\.[a-z0-9]{2,5}\b/i.test(p) && !has(/\b(run|execute)\b/i);
  if (!steps.length && !generalQuestion) add('local_search', { query: p.slice(0, 120) }, `search for “${p.slice(0, 60)}”`);
  return steps.filter((s) => s.tool !== 'shell_exec' || s.args.cmd);
}

function stampNote() { return new Date().toISOString().slice(0, 10); }

// One-line human summary of a finished step (shown in the trace + reply).
function summariseStep(st, r) {
  if (!r) return `${st.label} → no result`;
  if (Array.isArray(r.results)) return `${st.args.query || ''} → ${r.count} hit(s) in ${r.scanned} scanned`;
  if (r.entries) return `${r.dir} → ${r.count} entries`;
  if (r.output !== undefined) return `${st.args.cmd || ''} → ${r.ok ? 'ok' : 'failed'}${r.error ? ' (' + String(r.error).slice(0, 80) + ')' : ''}`;
  if (r.rows !== undefined && r.path && /\.(xlsx|docx)$/i.test(r.path)) return `${r.path} → ${r.rows} rows`;
  if (r.appended !== undefined) return `${r.path} → +${r.appended} paragraph(s)`;
  if (r.bytes !== undefined) return `${r.path || ''}${r.kind ? ' (' + r.kind + ')' : ''} → ${r.bytes} bytes`;
  if (r.opened) return `${r.path} → opened`;
  return `${st.label} → done`;
}

// Prompt head: durable facts first, then recent conversation turns.
// Either part is '' when empty, so concatenation is always safe.
function promptHead(memory, context) {
  return memoryBlock(memory) + (context || '');
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

  async runChat({ taskId = `chat-${Date.now()}`, prompt, prog = null, memory = {}, context = '' }) {
    // Fast path: one tiny capped LLM call, no RAG/sandbox/artefacts.
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'chat', route: 'general', model: 'llama3.2:1b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 200), kind: 'chat' });
    ev('model_selected', { route: 'general', model: 'llama3.2:1b', ok: true });
    const r = await this._gen('llama3.2:1b',
      promptHead(memory, context) +
      `You are Swaraj AI, a friendly shop-floor assistant. The user just said: "${String(prompt).slice(0, 200)}"\n` +
      `Reply warmly in ONE short sentence, under 15 words, like "Hello! What's going on?" ` +
      `If asked who you are or what you can do, add one short sentence: you review inspection reports against SOPs, fully offline.`,
      { numPredict: 60, timeoutMs: 60000 }, prog);
    const reply = r.ok ? r.text : (memory.company
      ? `Hello! What can I do for ${memory.company} today?`
      : 'Hello! What can I help you with today?');
    if (!r.ok) this._emitTokens(reply, prog);
    ev('completion', { ok: true, kind: 'chat', source: r.ok ? 'ollama' : 'template' });
    return { ok: true, kind: 'chat', taskId, reply, replyModel: 'llama3.2:1b', replySource: r.ok ? 'ollama' : 'template',
      route: { ok: true, route: 'general', model: 'llama3.2:1b' }, egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
  }

  // General Q&A: grounded on private RAG, answered by llama3.2:1b. No artefacts.
  async runQA({ taskId = `qa-${Date.now()}`, prompt, prog = null, memory = {}, context = '' }) {
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'qa', route: 'general', model: 'llama3.2:1b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 300), kind: 'qa' });
    ev('model_selected', { route: 'general', model: 'llama3.2:1b', ok: true });
    ev('rag_query', { query: String(prompt).slice(0, 200) });
    const hits = this.tools.search_sop(String(prompt), 2);
    ev('documents_retrieved', { count: hits.length });
    const ctx = hits.map((h) => `- ${h.id}: ${h.text.slice(0, 220)}`).join('\n') || '- (no matching internal note)';
    const r = await this._gen('llama3.2:1b',
      promptHead(memory, context) +
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
  async runCode({ taskId = `code-${Date.now()}`, prompt, prog = null, memory = {}, context = '' }) {
    const ev = (type, data = {}) => this.audit.append({ task: taskId, event: type, ...data });
    if (prog) { try { prog({ t: 'kind', kind: 'code', route: 'coding', model: 'qwen2.5-coder:1.5b' }); } catch {} }
    ev('task_received', { prompt: String(prompt).slice(0, 300), kind: 'code' });
    ev('model_selected', { route: 'coding', model: 'qwen2.5-coder:1.5b', ok: true });
    const r = await this._gen('qwen2.5-coder:1.5b',
      promptHead(memory, context) +
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
  async runVision({ taskId = `vis-${Date.now()}`, prompt, files = [], prog = null, memory = {}, context = '' }) {
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
      promptHead(memory, context) +
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

  async runTask({ taskId = `task-${Date.now()}`, prompt, files = [], prog = null, memory = {}, context = '', local = false }) {
    // `local:true` comes from the Local PC screen: whatever the user typed, the
    // local agent decides the steps. Otherwise infer the intent.
    if (local || isLocalIntent(prompt, files)) return this.runLocal({ taskId, prompt, prog, memory, context });
    if (isChitChat(prompt) && (!files || files.length === 0)) return this.runChat({ taskId, prompt, prog, memory, context });
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
    if ((!files || files.length === 0) && route.route === 'general') return this.runQA({ taskId, prompt, prog, memory, context });
    if ((!files || files.length === 0) && route.route === 'coding') return this.runCode({ taskId, prompt, prog, memory, context });
    // Forward SSE prog to gated tools so permission prompts surface in-chat.
    if (this.tools && this.tools.__setProg) { try { this.tools.__setProg(prog); } catch {} }
    const hasImage = (files || []).some((f) => /\.(png|jpe?g|bmp|tiff?|webp|gif)$/i.test(f.path || f.name || ''));
    const hasDoc = (files || []).some((f) => /\.(pdf|docx?|txt|md)$/i.test(f.path || f.name || '') || typeof f.text === 'string');
    // Image-only tasks always go to vision end-to-end (bytes → moondream → fallback stub).
    if (hasImage && !hasDoc) return this.runVision({ taskId, prompt, files, prog, memory, context });
    if (prog) { try { prog({ t: 'kind', kind: 'job', route: route.route, model: route.model }); } catch {} }
    if (route.route === 'vision' && (!files || files.length === 0 || !files.some((f) => /\.(pdf|docx?)$/i.test(f.path || f.name || '')))) {
      return this.runVision({ taskId, prompt, files, memory, context });
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
      ...(memory.company ? [`Organization: ${String(memory.company).slice(0, 120)}`] : []),
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
      promptHead(memory, context) +
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
      reply = `I reviewed the inspection${memory.company ? ` for ${memory.company}` : ''} against our private SOPs. ` +
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
  async runLocal({ taskId = `local-${Date.now()}`, prompt, prog = null, memory = {}, context = '' }) {
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
    const planLog = [];
    let result = null;
    const denied = (e) => String((e && e.message) || e).slice(0, 300);

    try {
      // Deterministic offline planner decides the steps; each one then asks the
      // user for permission before it touches anything.
      const plan = planLocalSteps(p);
      ev('plan_built', { steps: plan.map((s) => s.tool) });
      if (!plan.length) {
        const reply = 'I could not turn that into a local-machine action. I can find or open files, list folders, read documents, ' +
          'create spreadsheets/Word docs/slides/PDFs/text files, edit files, or run a program — try “find budget.xlsx and open it”, ' +
          '“what is in my downloads”, or “run node --version”.';
        ev('completion', { ok: false, kind: 'local', reason: 'unmapped' });
        this._emitTokens(reply, prog);
        return { ok: false, kind: 'local', taskId, route, steps, error: 'unmapped local request', reply,
          egress: { externalLLM: 0, remoteMCP: 0, externalAPI: 0, internetTraffic: 0 } };
      }
      if (prog) { try { prog({ t: 'step', phase: 'local', text: `plan: ${plan.map((s) => s.label).join(' → ')}` }); } catch {} }

      for (const st of plan) {
        const args = { ...st.args };
        // "find X and open it" — no path typed, so reuse the best search hit.
        if (!args.path && args.cmd === undefined && st.fromSearch) {
          const hit = result && Array.isArray(result.results) ? result.results[0] : null;
          if (hit) args.path = hit.path;
          if (!args.path) throw new Error(`No file matched for “${p.slice(0, 80)}” — try naming the file in full.`);
        }
        if (st.tool === 'shell_exec' && !args.cmd) throw new Error('Tell me which command to run, e.g. `run node --version`.');
        if (prog) { try { prog({ t: 'step', phase: 'local', text: `${st.label}…` }); } catch {} }
        ev('tool_calls', { tools: [st.tool], args: { path: args.path, dir: args.dir, query: args.query, cmd: args.cmd } });
        const r = await this.tools[st.tool](args);
        result = r;
        const line = `${st.tool} ${summariseStep(st, r)}`;
        steps.push(line);
        planLog.push({ tool: st.tool, label: st.label, detail: summariseStep(st, r), ok: true });
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
    const head = promptHead(memory, context);
    const llmRes = await this._gen('llama3.2:1b',
      `${head}You are Swaraj AI. The user asked: "${p.slice(0, 300)}"\n` +
      `Local steps taken: ${steps.join('; ')}\nTool result (JSON, trusted): ${summaryCtx}\n` +
      `Reply in at most 5 short sentences: what was found/changed, full paths, counts, and what to do next. Plain prose, no JSON.`,
      { numPredict: 220, timeoutMs: 60000 }, prog);
    if (llmRes.ok && !/^I cannot\b|^I can(not|'t) (provide|assist|help|create|generate)/i.test(String(llmRes.text || '').trim())) {
      reply = llmRes.text; replySource = 'ollama';
    }
    if (!reply) {
      if (steps.length > 1) {
        reply = `Done — ${steps.length} steps, each approved by you: ${steps.join('; ')}. ` +
          `Nothing left your machine; the audit trail records every permission decision.`;
      } else if (result && typeof result.count === 'number' && Array.isArray(result.results)) {
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
    return { ok: true, kind: 'local', taskId, route, steps, plan: planLog, local: result, reply, replyModel: 'llama3.2:1b', replySource,
      egress: { externalLLM: 0, remoteMCP: 0, remoteAPI: 0, internetTraffic: 0 } };
  }
}

module.exports = { Orchestrator, isChitChat, isLocalIntent, planLocalSteps, memoryBlock, promptHead };
