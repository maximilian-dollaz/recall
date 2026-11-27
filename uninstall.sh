#!/bin/zsh
# Remove Recall from this Mac:  zsh ~/Recall/uninstall.sh
# Stops Recall's background services and removes the tools the installer added.
# Your library (~/Recall/library and ~/.gbrain) and the AI models are kept unless you say yes to removing them.
set -uo pipefail
HERE="$(cd "$(dirname "${0:A}")" && pwd)"
uid="$(id -u)"

ask() { local a; print -n "$1 [y/N] "; read -r a </dev/tty; [[ "$a" == [yY]* ]]; }

print "Stopping Recall's background services"
for label in com.contextlibrary.app com.soulmap.app com.recall.ollama com.gbrain.serve; do
  launchctl bootout "gui/$uid/$label" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done

print "Removing the installer's tools (~/.recall)"
rm -rf "$HOME/.recall"
rm -f "$HOME/Desktop/Recall.webloc"

if ask "Remove the AI models (~/.ollama, 4 to 9 GB)? Other apps that use Ollama would need them again."; then
  rm -rf "$HOME/.ollama"
  [[ -d "$HOME/Applications/Ollama.app" ]] && rm -rf "$HOME/Applications/Ollama.app"
fi

if ask "Delete your Recall library, everything you saved? This can't be undone."; then
  rm -rf "$HOME/.gbrain" "$HERE"
  print "Recall and your library are removed."
else
  print "Your library is kept in $HERE/library and ~/.gbrain. Installing again picks it up."
fi
print "You can remove the '# Recall' lines from ~/.zshrc if you like."
