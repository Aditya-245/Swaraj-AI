#!/usr/bin/env bash
# ============================================================
#  Swaraj AI — one-click model setup (Linux / macOS)
#  Usage:  chmod +x pull-models.sh && ./pull-models.sh
#          ./pull-models.sh --check   # just report status
#  Pulls the 3 pinned local models (one-time ~4 GB download).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--check" ]; then
  exec node scripts/setup-models.js --check
fi

echo ""
echo " Swaraj AI — fetching local models (one-time download)"
echo " llama3.2:1b (1.3GB) + qwen2.5-coder:1.5b (986MB) + moondream (1.7GB)"
echo ""
exec node scripts/setup-models.js
