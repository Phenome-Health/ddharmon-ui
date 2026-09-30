#!/usr/bin/env bash
# rig.sh — the live-verify rig backend (08-28 Wave 0): an ISOLATED ddharmon-ui server the verify loop drives.
#
#   scripts/rig.sh start    build nothing; serve this worktree's backend + frontend/dist on $RIG_PORT
#   scripts/rig.sh stop     stop the server this script started (pid file), nothing else
#   scripts/rig.sh status   is it up, and on which commit
#   scripts/rig.sh restart  stop + start (after a backend change — there is no --reload, on purpose:
#                           a reload mid-leg kills the run's worker thread)
#
# Isolation: its own work root + job DB + embedding cache under .ddharmon_ui/rig/, this worktree's .venv (which
# must have the core worktree installed editable), and a port no human server uses. It never touches another
# worktree's server, DB or cache.
#
# The provider key is read from $RIG_KEY_FILE straight into the server's environment and nowhere else: never
# echoed, never logged, never passed on a command line. The spend tap (tests/live/rig_tap) meters every billed
# answer into .ddharmon_ui/rig/tap.jsonl so the loop has a reference that is not the app's own ledger.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RIG_PORT="${RIG_PORT:-8018}"
RIG_DIR="$ROOT/.ddharmon_ui/rig"
RIG_KEY_FILE="${RIG_KEY_FILE:-$HOME/.config/ddharmon/anthropic.key}"
PID_FILE="$RIG_DIR/server.pid"
PY="$ROOT/.venv/bin/python"

is_up() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if is_up; then echo "rig already up (pid $(cat "$PID_FILE")) on :$RIG_PORT"; return 0; fi
  if lsof -nP -iTCP:"$RIG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: :$RIG_PORT is taken by a process this script did not start — refusing to share it" >&2
    exit 1
  fi
  [ -s "$RIG_KEY_FILE" ] || { echo "error: no key file at $RIG_KEY_FILE" >&2; exit 1; }
  [ -x "$PY" ] || { echo "error: no venv at $ROOT/.venv" >&2; exit 1; }
  [ -f "$ROOT/frontend/dist/index.html" ] || echo "warning: no frontend/dist — API only (run: cd frontend && npm run build)" >&2
  mkdir -p "$RIG_DIR/work" "$RIG_DIR/cache"
  cd "$ROOT"
  # shellcheck disable=SC2094
  ANTHROPIC_API_KEY="$(cat "$RIG_KEY_FILE")" \
    DDHARMON_UI_WORK="$RIG_DIR/work" \
    DDHARMON_UI_DB="$RIG_DIR/jobs.db" \
    DDHARMON_CACHE="$RIG_DIR/cache" \
    DDHARMON_RIG_TAP_LOG="$RIG_DIR/tap.jsonl" \
    PYTHONPATH="$ROOT/tests/live/rig_tap${PYTHONPATH:+:$PYTHONPATH}" \
    nohup "$PY" -m uvicorn backend.app:app --host 127.0.0.1 --port "$RIG_PORT" >>"$RIG_DIR/server.log" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$RIG_PORT/api/health" >/dev/null 2>&1; then
      echo "rig up on :$RIG_PORT (pid $(cat "$PID_FILE")) @ $(git -C "$ROOT" rev-parse --short HEAD)"
      return 0
    fi
    sleep 1
  done
  echo "error: rig did not answer /api/health within 60s — see $RIG_DIR/server.log" >&2
  exit 1
}

stop() {
  if ! is_up; then echo "rig not running"; rm -f "$PID_FILE"; return 0; fi
  kill "$(cat "$PID_FILE")"
  for _ in $(seq 1 20); do is_up || break; sleep 0.5; done
  rm -f "$PID_FILE"
  echo "rig stopped"
}

status() {
  if is_up; then
    echo "rig up on :$RIG_PORT (pid $(cat "$PID_FILE")) — worktree @ $(git -C "$ROOT" rev-parse --short HEAD)"
  else
    echo "rig not running"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $(basename "$0") start|stop|restart|status" >&2; exit 2 ;;
esac
