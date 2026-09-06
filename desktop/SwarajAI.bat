@echo off
REM ============================================================
REM  Swaraj AI - Desktop Launcher (Windows)
REM  Double-click this file to run the entire Swaraj AI agent
REM  on your desktop. No cloud, no signup, data stays local.
REM
REM  What it does:
REM    1. Checks Node.js 18+ is installed
REM    2. Starts the local workbench (127.0.0.1 only, offline)
REM    3. Opens it in your default browser (app window if Chrome/Edge)
REM ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set APP_NAME=Swaraj AI
set PORT=%PORT%
if "%PORT%"=="" set PORT=8080

echo.
echo  ===============================================
echo   Swaraj AI - Sovereign Industrial Workbench
echo   On-prem ^| Air-gapped ^| Zero-egress
echo  ===============================================
echo.

REM ---- 1. Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js not found.
  echo.
  echo  Please install Node.js 18 LTS or newer from:
  echo    https://nodejs.org/en/download
  echo  Then double-click SwarajAI.bat again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo  [OK] Node %NODEV% detected.

REM ---- 2. Verify app files ----
if not exist "src\server.js" (
  echo  [X] src\server.js missing - the package may be incomplete.
  echo  Re-download the ZIP from the Swaraj AI website and extract fully.
  pause
  exit /b 1
)
if not exist "public\index.html" (
  echo  [X] public\index.html missing - re-extract the full ZIP.
  pause
  exit /b 1
)
if not exist "data" mkdir data
if not exist "out" mkdir out

REM ---- 3. Start server in background, find a free port ----
echo  Starting workbench on 127.0.0.1 (ports %PORT%-8089)...
start "Swaraj AI Server" /min cmd /c "node src\server.js"

REM ---- 4. Wait for /api/health (max ~20s), trying ports 8080-8089 ----
set READY_URL=
for /L %%p in (%PORT%,1,8089) do (
  if "!READY_URL!"=="" (
    echo  Probing http://127.0.0.1:%%p/api/health ...
    for /L %%i in (1,1,20) do (
      if "!READY_URL!"=="" (
        powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%%p/api/health'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
        if !errorlevel! equ 0 (
          set READY_URL=http://127.0.0.1:%%p
        ) else (
          timeout /t 1 /nobreak >nul
        )
      )
    )
  )
)

if "%READY_URL%"=="" (
  echo.
  echo  [X] Server did not become ready. Tips:
  echo    - Close any program using ports 8080-8089, then retry.
  echo    - Or run: set PORT=8081 ^& SwarajAI.bat
  echo    - Check server output in the "Swaraj AI Server" window.
  pause
  exit /b 1
)

echo.
echo  [OK] WORKBENCH READY -^> !READY_URL!
echo  Keep this window open while you use Swaraj AI.
echo  Opening in your browser...
echo.

REM ---- 5. Open browser (app-mode if Chrome/Edge exists) ----
set OPENED=
where msedge >nul 2>nul
if %errorlevel% equ 0 (
  start "" msedge --app="!READY_URL!/workbench.html" --user-data-dir="%LOCALAPPDATA%\SwarajAI\EdgeApp"
  set OPENED=1
) else (
  where chrome >nul 2>nul
  if !errorlevel! equ 0 (
    start "" chrome --app="!READY_URL!/workbench.html" --user-data-dir="%LOCALAPPDATA%\SwarajAI\ChromeApp"
    set OPENED=1
  )
)
if "%OPENED%"=="" (
  start "" "!READY_URL!/workbench.html"
)

echo  Website : !READY_URL!/
echo  Workbench: !READY_URL!/workbench.html
echo  Health  : !READY_URL!/api/health
echo  Proof   : !READY_URL!/api/security  (expect 0/0/0/0)
echo.
echo  Press Ctrl+C here to stop. Closing the server window also stops it.
echo.
pause
