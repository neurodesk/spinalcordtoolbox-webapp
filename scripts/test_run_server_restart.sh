#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
PORT="${1:-18082}"
PID_FILE="$WEB_DIR/.dev-server-$PORT.pid"
LOG1="$(mktemp)"
LOG2="$(mktemp)"
SERVER1=""
SERVER2=""

cleanup() {
  if [[ -n "$SERVER1" ]] && kill -0 "$SERVER1" 2>/dev/null; then
    kill "$SERVER1" 2>/dev/null || true
  fi
  if [[ -n "$SERVER2" ]] && kill -0 "$SERVER2" 2>/dev/null; then
    kill "$SERVER2" 2>/dev/null || true
  fi
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  rm -f "$LOG1" "$LOG2"
}

wait_for_pid_file() {
  local previous="${1:-}"
  for _ in {1..50}; do
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE")"
      if [[ "$pid" =~ ^[0-9]+$ && "$pid" != "$previous" ]] && kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 0.1
  done
  return 1
}

wait_for_http() {
  for _ in {1..50}; do
    if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

trap cleanup EXIT
rm -f "$PID_FILE"

bash "$WEB_DIR/run.sh" "$PORT" >"$LOG1" 2>&1 &
SERVER1="$!"
if ! wait_for_pid_file; then
  cat "$LOG1"
  echo "First dev server did not start" >&2
  exit 1
fi
PID1="$(cat "$PID_FILE")"

bash "$WEB_DIR/run.sh" "$PORT" >"$LOG2" 2>&1 &
SERVER2="$!"
if ! wait_for_pid_file "$PID1"; then
  cat "$LOG1"
  cat "$LOG2"
  echo "Replacement dev server did not start" >&2
  exit 1
fi
PID2="$(cat "$PID_FILE")"

if kill -0 "$PID1" 2>/dev/null; then
  cat "$LOG1"
  cat "$LOG2"
  echo "Original dev server is still running after replacement" >&2
  exit 1
fi

if ! wait_for_http; then
  cat "$LOG2"
  echo "Replacement dev server is not serving HTTP" >&2
  exit 1
fi

echo "Dev server restart test passed: $PID1 -> $PID2"
