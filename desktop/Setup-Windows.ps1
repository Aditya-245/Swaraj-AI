# ============================================================
#  Swaraj AI — One-time Windows Setup
#  Run via Setup-SwarajAI.bat (double-click). Installs:
#    1. Node.js LTS (needed to run the app)
#    2. Ollama (needed for local AI models)
#    3. The 3 Swaraj AI models (~4 GB, one-time download)
#  Afterwards the app is fully offline. Re-run anytime safely.
# ============================================================
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

Write-Host ''
Write-Host ' Swaraj AI — one-time setup' -ForegroundColor Cyan
Write-Host ' ==========================' -ForegroundColor Cyan

# 0. Remove "downloaded from internet" blocks so launchers just work.
try {
  Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
  Write-Host '[OK] Unblocked app files (no more SmartScreen prompts).' -ForegroundColor Green
} catch {}

function Has-Command($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
}

# 1. Node.js
if (Has-Command node) {
  Write-Host ("[OK] Node.js found: " + (node -v)) -ForegroundColor Green
} elseif (Has-Command winget) {
  Write-Host 'Installing Node.js LTS (this takes a minute)...'
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (Has-Command node) { Write-Host ("[OK] Node.js installed: " + (node -v)) -ForegroundColor Green }
  else { Write-Host '[X] Node.js install needs a terminal refresh — close this window, reopen it, and run Setup again.' -ForegroundColor Red; exit 1 }
} else {
  Write-Host '[X] No winget on this PC. Install Node.js LTS manually from https://nodejs.org , then re-run Setup.' -ForegroundColor Red
  exit 1
}

# 2. Ollama
if (Has-Command ollama) {
  Write-Host ("[OK] Ollama found: " + ((ollama --version) -join ' ')) -ForegroundColor Green
} elseif (Has-Command winget) {
  Write-Host 'Installing Ollama (local AI runtime)...'
  winget install -e --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (Has-Command ollama) { Write-Host '[OK] Ollama installed.' -ForegroundColor Green }
  else { Write-Host '[!] Ollama installed but not on PATH yet — restart your PC, then re-run Setup.' -ForegroundColor Yellow; exit 1 }
} else {
  Write-Host '[X] Install Ollama manually from https://ollama.com/download , then re-run Setup.' -ForegroundColor Red
  exit 1
}

# 3. Models (~4 GB, one-time).
Write-Host ''
Write-Host 'Fetching the 3 local AI models (one-time download, ~4 GB)...'
node (Join-Path $PSScriptRoot 'scripts/setup-models.js')
if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host ' SETUP COMPLETE — double-click SwarajAI to launch (no black window).' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host ' Setup incomplete — read the messages above, fix, and re-run Setup-SwarajAI.bat.' -ForegroundColor Yellow
}
