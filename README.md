# Swaraj-AI
SWARAJ is a sovereign, on-premise AI workbench built for secure organizations. It combines local AI models, agentic workflows, private RAG, multimodal understanding, tools, sandboxed code execution, and auditability—all designed to work without sending sensitive data outside the infrastructure.

## Sovereign Industrial AI Workbench (SIH26117)

Private AI employee running inside company infrastructure. On-prem, air-gapped,
local/open-weight models, RAG, tools, sandbox, deliverables, audit, zero-egress proof.

## Quickstart (offline, Node 18+)

```sh
npm test          # full suite: router/RAG/sandbox/audit/egress/pipeline/golden
npm run demo      # golden path: inspection report -> DOCX+PDF in out/
npm run security  # zero-egress check (expect 0/0/0/0)
npm start         # workbench on http://127.0.0.1:8080 (Chat/Docs/KB/Agents/Audit/Security)
```

No `npm install` needed — stdlib only. Docker compose provides
ollama/qdrant/postgres for production deployment (`docker compose up`).

## Golden path

`data/inspection-IR-2026-042.txt` (+ `weld-photo.jpg` vision stub)
-> parse/OCR -> `local-llava` vision -> SOP RAG (`sop-welding`)
-> `local-mistral/codellama` routing -> sandboxed calc
-> `out/IR-2026-042-approval.docx` + `.pdf` -> hash-chained audit -> egress `0/0/0/0`.

## Security

- `EgressGuard` allowlists localhost only; cloud keys scanned; no fetch except local.
- `runSandboxed`: static deny (fs/net/env), tmp-only cwd, stripped env, timeout kill, cleanup.
- Audit: operational events only, sha256 hash chain (`data/audit.jsonl`), verifiable.
