#!/bin/zsh
# The twin: the code in this folder, run on the Recall server against a scratch library (ports 4344/4345/4346),
# opened from this computer at http://localhost:4344 through ssh. Test every change here before it reaches
# anyone's real library (then server/deploy.sh ships it to production).
#   cl twin start | stop | status | log
# start copies this working tree (uncommitted changes too) to the server's twin-code folder, never the live code.
# Server data: ~/.gbrain/serve/twin (its own GBrain source "twin"; the owner here is "Max (twin)").
# It runs next to GBrain, so a page loads as fast as production. RECALL_SERVER picks the server (an ssh host).
set -euo pipefail
HERE="$(cd "$(dirname "${0:A}")/.." && pwd)"
SERVER="${RECALL_SERVER:-recall-server}"; DEST="$(whoami)@$SERVER"
SOCK="$HOME/.gbrain/serve/twin-tunnel.sock"
PORTS=(4344 4345 4346)
q() { printf '%q' "$1"; }
s() { ssh -o BatchMode=yes "$@"; }
tunnel_up() { [[ -S "$SOCK" ]] && ssh -S "$SOCK" -O check "$DEST" 2>/dev/null; }
open_tunnel() {
  tunnel_up && return 0
  rm -f "$SOCK"; local fw=(); for p in $PORTS; do fw+=(-L "127.0.0.1:$p:127.0.0.1:$p"); done
  ssh -fNM -S "$SOCK" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 $fw "$DEST"
}
close_tunnel() { tunnel_up && ssh -S "$SOCK" -O exit "$DEST" 2>/dev/null; rm -f "$SOCK"; }
# Until 14 Nov the twin ran on this Mac; stop a leftover one so it doesn't hold the ports.
OLD="$HOME/.gbrain/serve/twin/twin.pid"
[[ -f "$OLD" ]] && { kill "$(cat "$OLD")" 2>/dev/null || true; rm -f "$OLD"; }

case "${1:-status}" in
  start)
    RH=$(s "$DEST" 'echo $HOME'); CODE="$RH/.gbrain/serve/twin-code"
    echo "▸ copying this folder to the twin on $SERVER"
    s "$DEST" "mkdir -p $(q "$CODE")"
    (cd "$HERE" && git ls-files -z --cached --others --exclude-standard) | rsync -a --from0 --files-from=- -e "ssh -o BatchMode=yes" "$HERE/" "$DEST:$(q "$CODE")/"
    # The twin's folders and its library (made once), the live app's .env (keys, owner) shared read-only.
    s "$DEST" bash -s -- "$(q "$CODE")" <<'REMOTE'
set -euo pipefail
CODE="$1"; T="$HOME/.gbrain/serve/twin"
LIVE=$(systemctl show recall -p WorkingDirectory --value)
ln -sfn "$LIVE/.env" "$CODE/.env"
cd "$CODE" && ~/.bun/bin/bun install --silent
mkdir -p "$T/library" "$T/libraries"
[[ -f "$T/library/categories.json" ]] || cp "$LIVE/library/categories.json" "$T/library/categories.json"
OWNER=$(grep -E "^RECALL_OWNER_EMAIL=" "$LIVE/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr "[:upper:]" "[:lower:]"); OWNER=${OWNER:-owner@example.com}
[[ -f "$T/library/people.json" ]] || printf '%s' '{"owner":"'"$OWNER"'","people":{"'"$OWNER"'":{"id":"twin","name":"Twin","source":"twin"}}}' > "$T/library/people.json"
RECALL_DATA="$T" ~/.bun/bin/bun -e 'import { provision } from "./app/identity.ts"; await provision("twin");'
REMOTE
    sed -e "s|__USER__|$(whoami)|g" -e "s|__HOME__|$RH|g" "$HERE/server/recall-twin.service" \
      | s "root@$SERVER" 'cat > /etc/systemd/system/recall-twin.service && systemctl daemon-reload && systemctl restart recall-twin'
    open_tunnel
    for i in {1..30}; do curl -sf -o /dev/null -m 3 http://localhost:4345/api/projects && { echo "twin running: http://localhost:4344 (log: cl twin log)"; exit 0; }; sleep 1; done
    echo "twin failed to start, see: cl twin log"; exit 1 ;;
  stop)
    s "root@$SERVER" 'systemctl stop recall-twin' && close_tunnel && echo "twin stopped" ;;
  status)
    st=$(s "$DEST" 'systemctl is-active recall-twin' 2>/dev/null || true)
    if [[ "$st" == active ]]; then open_tunnel && echo "twin running: http://localhost:4344"; else echo "twin not running (cl twin start)"; fi ;;
  log)
    s "$DEST" 'tail -n 60 ~/.gbrain/serve/twin/twin.log' ;;
  *) echo "usage: cl twin start|stop|status|log"; exit 1 ;;
esac
