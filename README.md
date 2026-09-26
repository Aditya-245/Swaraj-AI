# Swaraj-AI
SWARAJ is a sovereign, on-premise AI workbench built for secure organizations. It combines local AI models, agentic workflows, private RAG, multimodal understanding, tools, sandboxed code execution, and auditability—all designed to work without sending sensitive data outside the infrastructure.

## Sovereign Industrial AI Workbench

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
- Local AI models (all 3, pinned in `desktop/models.json`): `llama3.2:1b`
  (1.3 GB, general), `qwen2.5-coder:1.5b` (986 MB, code), `moondream:latest`
  (1.7 GB, vision). One-time fetch: install Ollama, then
  `npm run models` (or double-click `Pull-Models.ps1` / `./pull-models.sh`);
  check with `npm run models:check` or `GET /api/models` (live n/3 status on
  the website Download section). Needs ~4 GB disk, 8 GB RAM, internet once —
  then fully offline. Without them the agent still runs on built-in templates.
- Optional native shell: `desktop/electron-main.js`
  (`npm i -D electron electron-builder`, then `npx electron desktop/electron-main.js`).

## Golden path

`data/inspection-IR-2026-042.txt` (+ `weld-photo.jpg` vision stub)
-> parse/OCR -> `local-llava` vision -> SOP RAG (`sop-welding`)
-> `local-mistral/codellama` routing -> sandboxed calc
-> `out/IR-2026-042-approval.docx` + `.pdf` -> hash-chained audit -> egress `0/0/0/0`.

## Memory (remembers you across sessions + documents)

Say it once — `"my company name is Kalash Seeds"`, `"remember my GSTIN is ..."`,
`"we are located in Jalna"` — and every later session greets, reasons, and
files approval notes (DOCX/PDF carry an `Organization:` line) with it.
`GET /api/memory` lists everything remembered; click ✕ in the workbench
(or `DELETE /api/memory/<key>`, or say `"forget my company name"`) to erase.
Stored in PostgreSQL when up, else `data/memory.json` — per user when signed
in, else per machine. Extraction is deterministic regex (audited, no extra
model call). See `src/memory.js` (`extractFacts`, `MemoryStore`).

## Context (multi-session conversation memory)

Beyond facts, the last ~6 turns (3 exchanges) of your conversation are kept per
user and prepended to every model prompt, so follow-ups resolve across sessions:
"the second one?", "make that in Hindi", "summarise what we just decided" — even
in a fresh chat. `GET /api/context` shows the stored thread, `DELETE /api/context`
(forget button in the workbench) clears it. Your prompt is saved *before* the
model runs, so a failed run still remembers what you asked. Capped at 20 turns
and 500 chars per turn to protect small local models' context windows.

## Security

- `EgressGuard` allowlists localhost only; cloud keys scanned; no fetch except local.
- `runSandboxed`: static deny (fs/net/env), tmp-only cwd, stripped env, timeout kill, cleanup.
- Audit: operational events only, sha256 hash chain (`data/audit.jsonl`), verifiable.
