#!/usr/bin/env bash
# ============================================================
#  Swaraj AI — Desktop Launcher (Linux / macOS)
#  Usage:  chmod +x SwarajAI.sh && ./SwarajAI.sh
#  Fully offline: binds 127.0.0.1 only, opens local workbench.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

APP="Swaraj AI"
BASE_PORT="${PORT:-8080}"

echo ""
echo " ==============================================="
echo "  Swaraj AI — Sovereign Industrial Workbench"
echo "  On-prem | Air-gapped | Zero-egress"
echo " ==============================================="
echo ""

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js not found."
  echo "    Install Node.js 18 LTS+ : https://nodejs.org/en/download"
  echo "    (Linux) sudo apt install nodejs  |  (macOS) brew install node"
  exit 1
fi
NODEV="$(node -v)"
echo "[OK] Node $NODEV detected."
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "[X] Node 18+ required (found $NODEV). Please upgrade."
  exit 1
fi

# 2. Files check
for f in src/server.js public/index.html public/workbench.html package.json; do
  if [ ! -f "$f" ]; then
    echo "[X] Missing $f — re-extract the full ZIP."
    exit 1
  fi
done
mkdir -p data out

# 3. Start server in background
echo "Starting workbench on 127.0.0.1 (ports $BASE_PORT-$((BASE_PORT+9)))..."
node src/server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

# 4. Wait for /api/health (ports BASE..BASE+9)
READY=""
for port in $(seq "$BASE_PORT" $((BASE_PORT+9))); do
  echo "Probing http://127.0.0.1:$port/api/health ..."
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      READY="http://127.0.0.1:$port"
      break
    fi
    sleep 1
  done
  [ -n "$READY" ] && break
done

if [ -z "$READY" ]; then
  echo ""
  echo "[X] Server did not become ready."
  echo "    Close whatever uses ports 8080-8089, or run: PORT=8081 ./SwarajAI.sh"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi

echo ""
echo "[OK] WORKBENCH READY -> $READY"
echo "  Website   : $READY/"
echo "  Workbench : $READY/workbench.html"
echo "  Proof     : $READY/api/security  (expect 0/0/0/0)"
echo ""
echo "Opening in your browser... (Ctrl+C here stops the server)"

# 5. Open browser (Chrome --app when available for a desktop feel)
open_url() {
  url="$1"
  if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --app="$url/workbench.html" >/dev/null 2>&1 &
  elif command -v chromium >/dev/null 2>&1; then
    chromium --app="$url/workbench.html" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url/workbench.html" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$url/workbench.html" >/dev/null 2>&1 &
  else
    echo "Open manually: $url/workbench.html"
  fi
}
open_url "$READY"

wait $SERVER_PID
