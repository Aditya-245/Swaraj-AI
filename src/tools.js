'use strict';
// Local tool registry (MCP-style modular interface). All tools run offline.
// Sensitive local-machine tools are gated by PermissionManager (opencode-style:
// allow once / allow always / reject) via the `permissions` dependency.
const fs = require('fs');
const path = require('path');
const { readDocument, ocrIfNeeded, inspectImage } = require('./documents');
const { runSandboxed } = require('./sandbox');
const deliver = require('./deliver');
const lm = require('./local-machine');

function makeTools({ rag, outDir, audit, permissions = null }) {
  const log = (name, args, ok) => { try { audit && audit.append({ tool: name, args: JSON.stringify(args).slice(0, 300), ok }); } catch {} };
  // Per-task SSE forwarder. Orchestrator sets it via __setProg so gated tools
  // can emit {t:'permission', ...} events the UI turns into an allow modal.
  let progRef = null;
  const emitPermission = (req) => { try { progRef && progRef({ t: 'permission', ...req }); } catch {} };
  const gate = async (tool, scope, details) => {
    if (!permissions) return { granted: true, via: 'no-policy', requestId: null };
    return permissions.guard(tool, String(scope || ''), details || {}, emitPermission);
  };

  const api = {
    __setProg: (p) => { progRef = (typeof p === 'function') ? p : null; },
    search_documents: (q, k = 3) => {
      const hits = rag.search(q, k);
      log('search_documents', { q }, true);
      return hits;
    },
    search_sop: (q, k = 3) => {
      const hits = rag.search(q, k).filter((h) => /sop/i.test(h.id) || true);
      log('search_sop', { q }, true);
      return hits;
    },
    query_knowledge_base: (q, k = 3) => {
      const hits = rag.search(q, k);
      log('query_knowledge_base', { q }, true);
      return hits;
    },
    read_document: (ref) => {
      const doc = readDocument(ref);
      const withOcr = ocrIfNeeded(doc);
      log('read_document', { ref: ref.path || ref.name || 'inline' }, true);
      return withOcr;
    },
    inspect_image: (ref) => {
      const name = typeof ref === 'string' ? ref : (ref.path || ref.name || '');
      const r = inspectImage(name);
      log('inspect_image', { ref: name }, true);
      return r;
    },
    run_python: async (code, opts) => {
      // Local calc: Python syntax subset translated to JS for sandbox exec.
      // Real deployment routes to Docker python:3-slim --network none.
      const js = String(code)
        .replace(/print\s*\(/g, 'console.log(')
        .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
      const wrapped = js.includes('return') ? js : `return (${js});`;
      const r = await runSandboxed(wrapped, opts);
      log('run_python', { code: String(code).slice(0, 200) }, r.ok);
      return r;
    },
    create_docx: (paras, filename = 'report.docx', title) => {
      const p = path.join(outDir, filename);
      deliver.createDocx(paras, p, title);
      log('create_docx', { filename }, true);
      return { path: p, bytes: fs.statSync(p).size };
    },
    create_xlsx: (rows, filename = 'data.xlsx', sheet) => {
      const p = path.join(outDir, filename);
      deliver.createXlsx(rows, p, sheet);
      log('create_xlsx', { filename }, true);
      return { path: p, bytes: fs.statSync(p).size };
    },
    create_pptx: (slides, filename = 'brief.pptx', title) => {
      const p = path.join(outDir, filename);
      deliver.createPptx(slides, p, title);
      log('create_pptx', { filename }, true);
      return { path: p, bytes: fs.statSync(p).size };
    },
    create_pdf: (text, filename = 'report.pdf') => {
      const p = path.join(outDir, filename);
      deliver.createPdf(text, p);
      log('create_pdf', { filename }, true);
      return { path: p, bytes: fs.statSync(p).size };
    },

    // ---- Local-machine tools (all permission-gated, opencode-style) ----
    local_search: async (args = {}) => {
      const q = args.query ?? args.q ?? '';
      const roots = (Array.isArray(args.roots) && args.roots.length ? args.roots : lm.defaultRoots());
      for (const r of roots) {
        await gate('local_search', lm.safeResolve(r), { summary: `Search "${String(q).slice(0, 80)}" in ${r}`, query: String(q).slice(0, 200), root: r });
      }
      const r = lm.searchLocal({
        query: q,
        roots,
        maxResults: Math.min(parseInt(args.maxResults || args.k || 50, 10) || 50, 200),
        maxDepth: Math.min(parseInt(args.maxDepth || 6, 10) || 6, 12),
        includeContent: !!args.includeContent,
        exts: args.exts || null,
      });
      log('local_search', { q, roots: roots.length, count: r.count }, true);
      return r;
    },
    local_list: async (args = {}) => {
      const dir = args.dir || args.path || process.cwd();
      await gate('local_list', lm.safeResolve(dir), { summary: `List folder ${dir}`, dir });
      const r = lm.listDir(dir, { max: Math.min(parseInt(args.max || 200, 10) || 200, 500) });
      log('local_list', { dir }, true);
      return r;
    },
    local_read: async (args = {}) => {
      const p = args.path || args.file;
      if (!p) throw new Error('local_read: need {path}');
      await gate('local_read', lm.safeResolve(p), { summary: `Read file ${p}`, path: p });
      const r = lm.readLocalFile(p);
      log('local_read', { path: p, bytes: r.bytes }, true);
      return r;
    },
    office_read: async (args = {}) => {
      const p = args.path || args.file;
      if (!p) throw new Error('office_read: need {path} to a .docx/.xlsx/.pptx file');
      await gate('office_read', lm.safeResolve(p), { summary: `Read Office document ${p}`, path: p });
      const r = lm.readLocalFile(p);
      log('office_read', { path: p, kind: r.kind }, true);
      return r;
    },
    office_create: async (args = {}) => {
      const kind = String(args.kind || args.type || 'docx').toLowerCase();
      const target = args.path ? lm.safeResolve(args.path) : path.join(outDir, args.filename || (kind === 'xlsx' ? 'data.xlsx' : kind === 'pptx' ? 'brief.pptx' : 'report.docx'));
      await gate('office_create', target, { summary: `Create ${kind.toUpperCase()} ${target}`, kind, path: target });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (kind === 'xlsx') deliver.createXlsx(args.rows || [['Note', 'Created locally with permission']], target, args.sheet);
      else if (kind === 'pptx') deliver.createPptx(args.slides || args.paras || ['Local brief'], target, args.title);
      else if (kind === 'pdf') deliver.createPdf(Array.isArray(args.paras) ? args.paras.join('\n') : String(args.text || args.paras || 'Local report'), target);
      else deliver.createDocx(args.paras || args.rows || ['Local document'], target, args.title);
      log('office_create', { kind, path: target }, true);
      return { path: target, bytes: fs.statSync(target).size, kind };
    },
    office_modify: async (args = {}) => {
      const p = args.path || args.file;
      if (!p) throw new Error('office_modify: need {path} to an existing .docx/.xlsx file');
      const abs = lm.safeResolve(p);
      const ext = path.extname(abs).toLowerCase();
      const out = args.outPath ? lm.safeResolve(args.outPath) : abs;
      await gate('office_modify', abs, {
        summary: `Modify ${ext || 'Office file'} ${p}${out !== abs ? ` → ${out}` : ''}`,
        path: p, outPath: out !== abs ? args.outPath : undefined,
        append: args.append, appendRows: args.appendRows, replace: args.replace, setCells: args.setCells,
      });
      let r;
      if (ext === '.xlsx') r = lm.modifyXlsx(abs, { appendRows: args.appendRows || args.rows || [], setCells: args.setCells || [], outPath: out, sheetName: args.sheet });
      else if (ext === '.docx') r = lm.modifyDocx(abs, { append: args.append || args.paras || [], replace: args.replace || null, outPath: out });
      else throw new Error('office_modify: only .docx and .xlsx are editable in v1 (got ' + (ext || '?') + ')');
      log('office_modify', { path: p, bytes: r.bytes }, true);
      return r;
    },
    local_write: async (args = {}) => {
      const p = args.path || args.file;
      if (!p) throw new Error('local_write: need {path, content}');
      await gate('local_write', lm.safeResolve(p), { summary: `Write file ${p} (${String(args.content || '').length} chars)`, path: p, bytes: String(args.content || '').length });
      const r = lm.writeLocalFile(p, args.content || '', { overwrite: args.overwrite !== false });
      log('local_write', { path: p, bytes: r.bytes }, true);
      return r;
    },
    shell_exec: async (args = {}) => {
      const cmd = args.cmd || args.command;
      const cmdArgs = args.args || [];
      if (!cmd) throw new Error('shell_exec: need {cmd, args?}');
      const scope = `shell:${[cmd, ...cmdArgs].join(' ').slice(0, 200)}`;
      await gate('shell_exec', scope, { summary: `Run: ${[cmd, ...cmdArgs].join(' ').slice(0, 160)}`, cmd, args: cmdArgs, cwd: args.cwd || process.cwd() });
      const r = await lm.execCommand(cmd, cmdArgs, { cwd: args.cwd, timeoutMs: Math.min(parseInt(args.timeoutMs || 15000, 10) || 15000, 60000) });
      log('shell_exec', { cmd, ok: r.ok }, r.ok);
      return r;
    },
    open_path: async (args = {}) => {
      const p = args.path;
      if (!p) throw new Error('open_path: need {path}');
      await gate('open_path', lm.safeResolve(p), { summary: `Open in OS: ${p}`, path: p });
      const r = lm.openPath(p);
      log('open_path', { path: p }, true);
      return r;
    },
  };
  return api;
}

module.exports = { makeTools };
