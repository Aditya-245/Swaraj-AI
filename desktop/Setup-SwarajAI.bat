@echo off
REM ============================================================
REM  Swaraj AI — One-time Setup (double-click this first)
REM  Installs Node.js + Ollama automatically (via winget),
REM  then downloads the 3 local AI models. Run once per PC.
REM ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "Setup-Windows.ps1"
pause
