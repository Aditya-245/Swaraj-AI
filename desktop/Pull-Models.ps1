# ============================================================
#  Swaraj AI — one-click model setup (PowerShell, Windows)
#  Pulls the 3 pinned local models (llama3.2:1b,
#  qwen2.5-coder:1.5b, moondream). One-time ~4 GB download,
#  then the workbench is fully offline.
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if ($args -contains '--check') {
  node (Join-Path $PSScriptRoot 'scripts/setup-models.js') --check
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host ' Swaraj AI — fetching local models (one-time download)' -ForegroundColor Cyan
Write-Host ' llama3.2:1b (1.3GB) + qwen2.5-coder:1.5b (986MB) + moondream (1.7GB)'
Write-Host ''
node (Join-Path $PSScriptRoot 'scripts/setup-models.js')
exit $LASTEXITCODE
