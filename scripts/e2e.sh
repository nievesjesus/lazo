#!/usr/bin/env bash
# Isolated E2E: starts Vite on its own port, generates the fixtures, runs the suite and shuts the server down.
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
