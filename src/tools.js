'use strict';
// Local tool registry (MCP-style modular interface). All tools run offline.
const fs = require('fs');
const path = require('path');
const { readDocument, ocrIfNeeded, inspectImage } = require('./documents');
const { runSandboxed } = require('./sandbox');
const deliver = require('./deliver');

function makeTools({ rag, outDir, audit }) {
  const log = (name, args, ok) => { try { audit && audit.append({ tool: name, args: JSON.stringify(args).slice(0, 300), ok }); } catch {} };
  return {
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
  };
}

module.exports = { makeTools };
