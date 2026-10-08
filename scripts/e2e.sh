#!/usr/bin/env bash
# E2E aislado: levanta Vite en un puerto propio, genera los fixtures, corre la suite y apaga el server.
set -euo pipefail
cd "$(dirname "$0")/../web"
PORT="${E2E_PORT:-5199}"
PY="${PY:-../.venv/bin/python}"
[[ "$PY" = /* ]] || PY="../$PY"

"$PY" e2e/make_fixtures.py
node scripts/copy-assets.mjs >/dev/null
npx vite --port "$PORT" --strictPort >/tmp/mnemo-e2e-vite.log 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/" >/dev/null && break; sleep 0.5; done
MNEMO_URL="http://localhost:$PORT/" node e2e/run.mjs
