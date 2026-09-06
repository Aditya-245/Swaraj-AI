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

No `npm install` needed for the core agent — stdlib only. (`npm install`
unlocks login/task-history via PostgreSQL; without it the workbench still
runs fully offline with auth gracefully disabled.) Docker compose provides
ollama/qdrant/postgres for production deployment (`docker compose up`).

## Download for Desktop (entire agent as a ZIP)

The Swaraj AI website serves a downloadable desktop package of the **entire**
agent — website, workbench UI, local planner, private RAG, sandbox, audit.

```sh
npm run package:desktop   # builds dist/SwarajAI-desktop-v<version>.zip
npm run desktop:list      # preview what goes into the ZIP
```

- Website section: open `http://127.0.0.1:8080/#download` — OS auto-detected
  (Windows / Linux / macOS), version + size + SHA-256 shown live.
- API: `GET /api/download` (manifest) and `GET /download/<file>` (the ZIP,
  its `.sha256`, `latest.json`). Only `SwarajAI-desktop-*.zip` files serve;
  everything else 404s.
- Run it: extract anywhere, then Windows → double-click `SwarajAI.bat`
  (or `Start-SwarajAI.ps1`); Linux/macOS → `chmod +x SwarajAI.sh && ./SwarajAI.sh`.
  Needs only Node 18+, no admin, no internet. Verify with
  `certutil -hashfile <zip> SHA256` (Win) / `sha256sum` (Linux) / `shasum -a 256` (Mac).
- The ZIP ships seed SOPs only — never `data/pg`, uploads, or audit logs.
- Optional native shell: `desktop/electron-main.js`
  (`npm i -D electron electron-builder`, then `npx electron desktop/electron-main.js`).

## Golden path

`data/inspection-IR-2026-042.txt` (+ `weld-photo.jpg` vision stub)
-> parse/OCR -> `local-llava` vision -> SOP RAG (`sop-welding`)
-> `local-mistral/codellama` routing -> sandboxed calc
-> `out/IR-2026-042-approval.docx` + `.pdf` -> hash-chained audit -> egress `0/0/0/0`.

## Security

- `EgressGuard` allowlists localhost only; cloud keys scanned; no fetch except local.
- `runSandboxed`: static deny (fs/net/env), tmp-only cwd, stripped env, timeout kill, cleanup.
- Audit: operational events only, sha256 hash chain (`data/audit.jsonl`), verifiable.
