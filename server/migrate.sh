#!/bin/zsh
# Copy Recall and the Soul Map from this Mac to a server set up by provision.sh, at the same paths.
#   server/migrate.sh <server>            copy everything while this Mac keeps serving (a dry run of the move)
#   server/migrate.sh <server> --final    the switch: stop the Mac's services, copy the last changes, hand the libraries to the
#                                          server (adopt-libraries.sh), start it and its tunnel, leave the Mac as a client
#   add --build to rebuild on the server (the plain form always builds)
# The server's user has this Mac's user name (provision.sh RECALL_USER); services are run through root.
# Run the plain form first (big copy), test the server, then --final at switchover (seconds of changes).
set -euo pipefail
HOST="${1:?usage: server/migrate.sh <server> [--final] [--build]}"; FINAL="${2:-}"; BUILD="${3:-}"; DEST="$(whoami)@$HOST"
GUI="gui/$(id -u)"
HERE="$(cd "$(dirname "${0:A}")/.." && pwd)"
SOUL="$(cd "$HERE/../soul-map" && pwd)"
SSH=(ssh -o StrictHostKeyChecking=accept-new "$DEST")
RS=(rsync -a --delete -e "ssh -o StrictHostKeyChecking=accept-new")
# The final copy compares file contents, not size and date: a file the first copy read while this Mac was
# writing it keeps the same size and date afterwards, and a plain rsync would leave it torn on the server.
[[ "$FINAL" == "--final" ]] && RS+=(-c)
q() { printf '%q' "$1"; }
# Once a server is live, its data is the real data: a copy from this Mac would overwrite people's saves.
# To ship code changes use server/deploy.sh. To copy again on purpose: MIGRATE_OVER_LIVE=yes.
if ssh -o BatchMode=yes "$DEST" "test -f ~/.recall-live" 2>/dev/null && [[ "${MIGRATE_OVER_LIVE:-}" != yes ]]; then
  echo "Refusing: $HOST is live (its data is newer than this Mac's). Use server/deploy.sh for code." >&2; exit 1
fi

if [[ "$FINAL" == "--final" ]]; then
  echo "▸ Stopping the server's services, then this Mac's (Recall, Soul Map, library engine, tunnels); from here Recall is down until the server starts"
  ssh "root@$HOST" "systemctl stop recall-tunnel recall soulmap gbrain-serve 2>/dev/null || true
    [ -d $(q "$HOME")/.gbrain/brain.pglite ] && cp -a $(q "$HOME")/.gbrain/brain.pglite $(q "$HOME")/.gbrain/brain.pglite.before-final-\$(date +%s) || true"
  for l in com.contextlibrary.app com.soulmap.app com.soulmap.sync com.gbrain.serve com.recall.cftunnel com.recall.tunnel; do
    launchctl disable "$GUI/$l" 2>/dev/null || true; launchctl bootout "$GUI/$l" 2>/dev/null || true
  done
  sleep 2
fi

echo "▸ Code and data"
"${SSH[@]}" "mkdir -p $(q "$HERE") $(q "$SOUL") ~/.gbrain"
"${RS[@]}" --exclude node_modules --exclude .venv --exclude 'tools/.venv' --exclude .board-cache --exclude dist "$HERE/" "$DEST:$(q "$HERE")/"
"${RS[@]}" --exclude node_modules --exclude .next --exclude .venv "$SOUL/" "$DEST:$(q "$SOUL")/"
[[ -d "$HOME/.cloudflared" ]] && "${RS[@]}" "$HOME/.cloudflared/" "$DEST:.cloudflared/"
"${RS[@]}" --exclude 'brain.pglite.bak-*' --exclude 'brain.pglite.before-final-*' --exclude 'brain.pglite.wal-repair-backup-*' --exclude 'serve/twin' --exclude 'serve/*.log' --exclude 'serve/*.err' --exclude 'serve/*.out' "$HOME/.gbrain/" "$DEST:.gbrain/"

if [[ "$FINAL" != "--final" || "$BUILD" == "--build" ]]; then
echo "▸ Build on the server"
"${SSH[@]}" "set -e; export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
  cd $(q "$HERE") && bun install --silent
  cd $(q "$SOUL")/analysis/hdcalc && uv sync -q
  cd $(q "$SOUL")/evidence && uv sync -q
  cd $(q "$SOUL")/app && npm ci --no-audit --no-fund --loglevel=error && npm run -s build >/dev/null
  echo built"
fi

if [[ "$FINAL" == "--final" ]]; then
  echo "▸ Handing the libraries to the server"
  "${SSH[@]}" "find $(q "$HERE") -maxdepth 2 -name '.gbrain-owner*.json' -exec chmod 600 {} +; bash $(q "$HERE")/server/adopt-libraries.sh"
  echo "▸ Starting the server and its tunnel"
  ssh "root@$HOST" "systemctl start gbrain-serve && sleep 5 && systemctl start recall soulmap && systemctl enable --now recall-tunnel && sleep 5 && systemctl is-active gbrain-serve recall soulmap recall-tunnel"
  echo "▸ This Mac reaches the server's library engine at 127.0.0.1:3131 (com.recall.brainlink)"
  sed -e "s#__HOME__#$HOME#g" -e "s#__SERVER__#$DEST#g" "$HERE/server/com.recall.brainlink.plist" > "$HOME/Library/LaunchAgents/com.recall.brainlink.plist"
  launchctl bootstrap "$GUI" "$HOME/Library/LaunchAgents/com.recall.brainlink.plist" 2>/dev/null || launchctl kickstart -k "$GUI/com.recall.brainlink"
  "${SSH[@]}" "date > ~/.recall-live"
  echo "Done: Recall runs on $HOST. Undo: server/migrate.sh --rollback is not automatic; re-enable the Mac's services with launchctl enable + bootstrap."
else
  echo "Copied. Test it: ssh root@$HOST systemctl start gbrain-serve recall soulmap, then ssh -L 4346:127.0.0.1:3346 $DEST and open http://localhost:4346"
fi
