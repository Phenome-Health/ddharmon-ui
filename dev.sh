#!/usr/bin/env bash
# Dev mode: FastAPI backend (:8000, --reload) + Vite dev server (:5173, proxying /api → :8000).
# Open http://localhost:5173
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VENV_PY="$ROOT/.venv/bin/python"
[ -x "$VENV_PY" ] || VENV_PY="python"

# Load backend env (CLERK_ISSUER, DDHARMON_CDE_DIR, …) from a repo-root .env if present. Kept to the
# server process only (uvicorn --env-file) so it never leaks into pytest/manual imports.
ENV_FILE_ARG=()
[ -f "$ROOT/.env" ] && ENV_FILE_ARG=(--env-file "$ROOT/.env")
# Expand with the `[@]+` guard, not a bare `[@]`. macOS ships bash 3.2, where expanding an EMPTY
# array under `set -u` is an unbound-variable error — so with no repo-root .env this script died at
# the uvicorn line and started the frontend with no backend behind it, silently (the Vite line runs
# in the foreground, so the shell still looked healthy).

echo ">>> starting FastAPI backend on :8000"
"$VENV_PY" -m uvicorn backend.app:app --reload --port 8000 ${ENV_FILE_ARG[@]+"${ENV_FILE_ARG[@]}"} &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

cd "$ROOT/frontend"
[ -d node_modules ] || npm install
echo ">>> starting Vite dev server on :5173"
API_PROXY_TARGET="http://localhost:8000" npm run dev
