@echo off
REM Double-click launcher for the Sovereign Workbench (Windows).
cd /d "%~dp0"
echo Installing dependencies (root, offline-capable)...
call npm install --no-audit --no-fund
echo Starting workbench...
node scripts\workbench.js
pause
