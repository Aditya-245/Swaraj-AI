# ============================================================
#  Swaraj AI — Desktop Launcher (PowerShell, Windows 10/11)
#  Right-click > "Run with PowerShell", or double-click if
#  .ps1 is associated. Same job as SwarajAI.bat with better
#  diagnostics. Fully offline — nothing leaves 127.0.0.1.
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$BasePort = if ($env:PORT) { [int]$env:PORT } else { 8080 }
Write-Host ''
Write-Host ' ==============================================='
Write-Host '  Swaraj AI — Sovereign Industrial Workbench'
Write-Host '  On-prem | Air-gapped | Zero-egress'
Write-Host ' ==============================================='
Write-Host ''

# 1. Node check
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '[X] Node.js not found. Install Node.js 18 LTS+ from https://nodejs.org/en/download' -ForegroundColor Red
  Write-Host 'Then re-run this launcher.'
  Read-Host 'Press Enter to exit'
  exit 1
}
$nodeV = (node -v)
Write-Host "[OK] Node $nodeV detected." -ForegroundColor Green
$major = [int](($nodeV -replace '[^0-9.]','').Split('.')[0])
if ($major -lt 18) {
  Write-Host '[X] Node 18+ required. Please upgrade from https://nodejs.org' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

# 2. Files check
foreach ($f in @('src/server.js','public/index.html','public/workbench.html','package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $f))) {
    Write-Host "[X] Missing $f — re-extract the full ZIP." -ForegroundColor Red
    Read-Host 'Press Enter to exit'
    exit 1
  }
}
foreach ($d in @('data','out')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $d))) {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot $d) | Out-Null
  }
}

# 3. Start server (separate window so logs stay visible)
$serverJs = Join-Path $PSScriptRoot 'src/server.js'
$proc = Start-Process -FilePath 'node' -ArgumentList "`"$serverJs`"" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Minimized
Write-Host "Starting workbench (PID $($proc.Id)) on 127.0.0.1 ports $BasePort-$($BasePort+9)..."

# 4. Wait for health
$ready = $null
foreach ($port in ($BasePort..($BasePort+9))) {
  Write-Host "Probing http://127.0.0.1:$port/api/health ..."
  for ($i = 0; $i -lt 20 -and -not $ready; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/health"
      if ($r.StatusCode -eq 200) { $ready = "http://127.0.0.1:$port"; break }
    } catch { Start-Sleep -Seconds 1 }
  }
  if ($ready) { break }
}

if (-not $ready) {
  Write-Host '[X] Server did not become ready. Stop whatever uses ports 8080-8089 or set $env:PORT=8081 and retry.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host ''
Write-Host "[OK] WORKBENCH READY -> $ready" -ForegroundColor Green
Write-Host "Website   : $ready/"
Write-Host "Workbench : $ready/workbench.html"
Write-Host 'Proof     : $ready/api/security  (expect 0/0/0/0)'

# 5. Open app window (Edge/Chrome --app when available)
$opened = $false
foreach ($cand in @('msedge','chrome')) {
  if (Get-Command $cand -ErrorAction SilentlyContinue) {
    $profile = Join-Path $env:LOCALAPPDATA "SwarajAI\$cand-App"
    Start-Process $cand "--app=`"$ready/workbench.html`" --user-data-dir=`"$profile`""
    $opened = $true
    break
  }
}
if (-not $opened) { Start-Process "$ready/workbench.html" }

Write-Host ''
Write-Host 'Keep this window open while you use Swaraj AI. Close it (or stop the node process) to quit.'
Write-Host 'Press Ctrl+C to stop the server.'
try { Wait-Process -Id $proc.Id } catch {}
