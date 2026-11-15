#!/bin/zsh
# Undo migrate.sh --final: Recall runs on this Mac again, as it was at the moment of the switch.
# Saves made on the server after the switch stay on the server (copy them back by hand if any).
#   server/rollback.sh <server>
set -uo pipefail
HOST="${1:?usage: server/rollback.sh <server>}"; GUI="gui/$(id -u)"
ssh "root@$HOST" "systemctl disable --now recall-tunnel; systemctl stop recall soulmap gbrain-serve"
launchctl bootout "$GUI/com.recall.brainlink" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/com.recall.brainlink.plist"
for l in com.gbrain.serve com.contextlibrary.app com.soulmap.app com.soulmap.sync com.recall.cftunnel; do
  launchctl enable "$GUI/$l"; launchctl bootstrap "$GUI" "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || launchctl kickstart -k "$GUI/$l"
done
sleep 8; curl -s -o /dev/null -w "Recall on this Mac again: %{http_code}\n" http://127.0.0.1:3346/
