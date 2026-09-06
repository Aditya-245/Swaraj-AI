Swaraj AI — Desktop Package (offline, runs on your machine)
=======================================================

You downloaded the ENTIRE Swaraj AI agent. It runs 100% on your
computer: local models, private RAG, sandboxed code, DOCX+PDF
deliverables, hash-chained audit, zero-egress proof.

QUICK START
-----------
Windows:
  1. Extract the ZIP anywhere (e.g. Desktop\SwarajAI\).
  2. Double-click  SwarajAI.bat
     (or right-click Start-SwarajAI.ps1 > Run with PowerShell)
  3. Your browser opens the workbench automatically.

Linux / macOS:
  1. Unzip:  unzip SwarajAI-desktop-*.zip -d SwarajAI && cd SwarajAI
  2. Run:    chmod +x SwarajAI.sh && ./SwarajAI.sh
     (or: PORT=8081 ./SwarajAI.sh if port 8080 is busy)

Then open:
  Website   : http://127.0.0.1:8080/
  Workbench : http://127.0.0.1:8080/workbench.html
  Health    : http://127.0.0.1:8080/api/health
  Proof     : http://127.0.0.1:8080/api/security   (expect 0/0/0/0)

REQUIREMENTS
------------
- Node.js 18 or newer (https://nodejs.org/en/download)
- ~300 MB free disk, no admin rights needed
- No internet required after install. No signup. No cloud keys.
- Optional (for AI replies, still local): Ollama + models
  llama3.2:1b, qwen2.5-coder:1.5b, moondream — see README.md.
  Without Ollama the workbench still runs on built-in templates.

WHAT'S INSIDE
-------------
  SwarajAI.bat / Start-SwarajAI.ps1  Windows double-click launchers
  SwarajAI.sh                        Linux/macOS launcher
  src/                               Local agent (router, RAG, sandbox, audit)
  public/                            Website + workbench UI
  data/*.txt                         Seed SOPs + demo inspection report
  scripts/                           workbench / demo / security checks
  desktop/electron-main.js           Optional native-shell wrapper
  README.md                          Full docs

COMMANDS (inside the extracted folder)
--------------------------------------
  node src/server.js        start directly
  node scripts/workbench.js auto-pick a free port + health check
  npm test                  full offline test suite
  npm run demo              golden path -> out/*.docx + *.pdf
  npm run security          zero-egress check (expect 0/0/0/0)

VERIFY INTEGRITY
----------------
  Compare the SHA-256 on the download page with:
    Windows:  certutil -hashfile SwarajAI-desktop-*.zip SHA256
    Linux:    sha256sum SwarajAI-desktop-*.zip
    macOS:    shasum -a 256 SwarajAI-desktop-*.zip

PRIVACY
-------
Binds 127.0.0.1 only. EgressGuard denies every non-localhost host.
Audit trail: data/audit.jsonl (sha256 hash chain, verifiable offline).

SUPPORT
-------
Re-download anytime from the Swaraj AI website > Download section
(GET /api/download lists current builds with checksums).

Jai Hind. Your data never leaves your soil.
