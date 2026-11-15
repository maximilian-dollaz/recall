#!/bin/zsh
# Ship code changes to the live server. Only files Git tracks are sent, so nobody's libraries, settings,
# keys or GBrain ownership files are ever touched. Rebuilds what changed, then restarts.
#   server/deploy.sh <server> [recall|soul|both]      (default both)
# Test on the twin first; this is production.
set -euo pipefail
HOST="${1:?usage: server/deploy.sh <server> [recall|soul|both]}"; WHAT="${2:-both}"; DEST="$(whoami)@$HOST"
HERE="$(cd "$(dirname "${0:A}")/.." && pwd)"
SOUL="$(cd "$HERE/../soul-map" && pwd)"
q() { printf '%q' "$1"; }
ship() { # $1 = repo folder: files Git tracks or would track (new, uncommitted ones too); never ignored ones (data, keys)
  (cd "$1" && git ls-files -z --cached --others --exclude-standard) | rsync -a --from0 --files-from=- -e "ssh -o BatchMode=yes" "$1/" "$DEST:$(q "$1")/"
}
restart=()
if [[ "$WHAT" == recall || "$WHAT" == both ]]; then
  echo "▸ Recall"; ship "$HERE"
  ssh -o BatchMode=yes "$DEST" "cd $(q "$HERE") && ~/.bun/bin/bun install --silent"
  restart+=(recall)
fi
if [[ "$WHAT" == soul || "$WHAT" == both ]]; then
  echo "▸ Soul Map"; ship "$SOUL"
  ssh -o BatchMode=yes "$DEST" "cd $(q "$SOUL")/app && npm ci --no-audit --no-fund --loglevel=error && npm run -s build >/dev/null && echo built"
  restart+=(soulmap)
fi
ssh -o BatchMode=yes "root@$HOST" "systemctl restart ${restart[*]} && sleep 5 && systemctl is-active ${restart[*]}"
