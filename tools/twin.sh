#!/bin/zsh
# The twin: this same code, run against a scratch library on ports 4344/4345/4346.
# Test every change here before it reaches anyone's real library.
#   cl twin start | stop | status
# Data: ~/.gbrain/serve/twin (its own GBrain source "twin"; the owner here is "Max (twin)").
set -u
HERE="$(cd "$(dirname "${0:A}")/.." && pwd)"
T="$HOME/.gbrain/serve/twin"
PID="$T/twin.pid"
export RECALL_DATA="$T" RECALL_PORT_GATE=4344 RECALL_PORT_INNER=4345 RECALL_PORT_DOOR=4346
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434/v1}"
export RECALL_TEST_JWKS="${RECALL_TEST_JWKS:-}"
# The twin's owner is this install's owner, so the same Google sign-in opens it.
OWNER=$(grep -E "^RECALL_OWNER_EMAIL=" "$HERE/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr "[:upper:]" "[:lower:]"); OWNER=${OWNER:-owner@example.com}
running() { [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }
case "${1:-status}" in
  start)
    running && { echo "twin already running: http://localhost:4344"; exit 0; }
    mkdir -p "$T/library" "$T/libraries"
    [[ -f "$T/library/categories.json" ]] || cp "$HERE/library/categories.json" "$T/library/categories.json"
    [[ -f "$T/library/people.json" ]] || print -r -- '{"owner":"'"$OWNER"'","people":{"'"$OWNER"'":{"id":"twin","name":"Twin","source":"twin"}}}' > "$T/library/people.json"
    # The twin owner's library (folder, GBrain source "twin", credential app-twin), made once.
    bun -e 'import { provision } from "'"$HERE"'/app/identity.ts"; await provision("twin");' || exit 1
    nohup bun run "$HERE/app/server.ts" >> "$T/twin.log" 2>&1 &
    print $! > "$PID"; sleep 3
    curl -sf -o /dev/null http://localhost:4345/api/projects && echo "twin running: http://localhost:4344 (log $T/twin.log)" || { echo "twin failed to start, see $T/twin.log"; exit 1; } ;;
  stop)
    running && kill "$(cat "$PID")" && rm -f "$PID" && echo "twin stopped" || echo "twin not running" ;;
  status)
    running && echo "twin running: http://localhost:4344" || echo "twin not running" ;;
  *) echo "usage: cl twin start|stop|status"; exit 1 ;;
esac
