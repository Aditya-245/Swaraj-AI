Swaraj AI — Desktop Package (offline, runs on your machine)
=======================================================

You downloaded the ENTIRE Swaraj AI agent. It runs 100% on your
computer: local models, private RAG, sandboxed code, DOCX+PDF
deliverables, hash-chained audit, zero-egress proof.

QUICK START (Windows — no black window)
----------------------------------------
  FIRST TIME ONLY:
    1. Right-click the ZIP > Properties > check "Unblock" > OK.
       (Skips Windows SmartScreen warnings.)
    2. Extract the ZIP anywhere (e.g. Desktop\SwarajAI\).
    3. Double-click  Setup-SwarajAI.bat  (installs Node.js, Ollama
       and the 3 AI models automatically — one-time, ~10 min).

  EVERY DAY:
    1. Double-click  SwarajAI  (the script icon).
       No console window appears — the app starts hidden and
       opens in a desktop-style window by itself.
    2. To quit: double-click  Stop-SwarajAI.

  If double-click does nothing, or Smart App Control says the app
  "may be dangerous": this is a false positive — our launchers are
  unsigned plain-text scripts (open any .vbs/.bat in Notepad to verify:
  they only start a localhost server and open your browser). Fix:
    1. Delete the extracted folder. Right-click the ZIP > Properties >
       check "Unblock" > OK. Extract again — the mark is gone, so
       Windows trusts the files.
    2. Still blocked? Open PowerShell and run (fix the path to yours):
         Get-ChildItem -Path "$env:USERPROFILE\Desktop\SwarajAI" -Recurse | Unblock-File
       then double-click SwarajAI again.
    3. Last resort: try SwarajAI.bat instead (runs via Windows' own
       console), or turn Smart App Control off in Windows Security >
       App & browser control (note: Microsoft may require a fresh
       Windows install to turn it back on).

QUICK START (Linux / macOS)
---------------------------
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
- ~300 MB free disk for the app (+ ~4 GB for AI models, see below)
- 8 GB RAM minimum, 16 GB recommended; any modern 4+ core CPU
- No admin rights needed. No signup. No cloud keys.
- Internet needed ONCE to fetch the models; afterwards fully
  offline/air-gapped.

LOCAL AI MODELS (all 3 included via one-click setup)
----------------------------------------------------
  llama3.2:1b       1.3 GB   general chat, Q&A, drafting
  qwen2.5-coder     986 MB   code + engineering calculations
  moondream         1.7 GB   vision: welds, gauges, photos

  1. Install Ollama: https://ollama.com/download (free, local-only)
  2. Fetch the models (one-time ~4 GB download):
       Windows:  double-click Pull-Models.ps1 (or .\Pull-Models.ps1)
       Linux/Mac: chmod +x pull-models.sh && ./pull-models.sh
  3. Check: node scripts/setup-models.js --check  (expect 3/3)
     or open http://127.0.0.1:8080/api/models in the browser.

  Without Ollama the workbench still runs (built-in templates answer,
  RAG/sandbox/audit all work) — the models upgrade every reply to real
  local inference. Fully air-gapped? Copy .gguf weights via USB, then
  per model: ollama create <tag> --from <file.gguf> (tags in models.json).

WHAT'S INSIDE
-------------
  SwarajAI (SwarajAI.vbs)            Main launcher — hidden, no console
  Stop-SwarajAI                      Quits the hidden app
  Setup-SwarajAI.bat                 One-time setup (Node+Ollama+models)
  SwarajAI.bat / Start-SwarajAI.ps1  Fallback launchers (show console)
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
