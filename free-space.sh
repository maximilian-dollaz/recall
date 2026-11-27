#!/bin/bash
# Free up space on this Mac, safely. Nothing is deleted without a yes for that one thing.
#
#   curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/free-space.sh | bash
#   (or, once Recall is installed:  bash ~/Recall/free-space.sh)
#
# What it offers, in order, each with its own question:
#   1. Big files in Downloads you haven't opened in 30+ days → moved to the Trash, one at a time, only the ones you pick.
#   2. App caches (~/Library/Caches) → cleared. Apps rebuild what they need; nothing personal is in there.
#   3. The Trash → emptied (this is the step that actually frees the space).
#   4. Apple's own Storage settings → opened, for old iPhone and iPad backups, big files and unused apps.
# It never touches Documents, Desktop, Photos, Mail, messages or anything else of yours.
set -u

tty_ok() { { : </dev/tty; } 2>/dev/null; }
tty_ok || { echo "This needs a person to answer its questions. Run it in Terminal." >&2; exit 1; }
ask() { local a; printf '\n\033[1m%s\033[0m [y/N] ' "$1"; read -r a </dev/tty; case "$a" in y*|Y*) return 0 ;; esac; return 1; }
say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
free_gb() { df -g "$HOME" | awk 'NR==2 {print $4}'; }
human() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k/1048576; else printf "%d MB", k/1024 }'; }
to_trash() { osascript -e 'on run argv' -e 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)' -e 'end run' "$1" >/dev/null 2>&1; }

start=$(free_gb)
printf '\n\033[1mFree up space on this Mac\033[0m\n'
note "Free now: ${start} GB. Nothing is deleted unless you say yes to it."
note "macOS may ask once to let Terminal see Downloads or control Finder: click OK."

# ── 1. Big, old files in Downloads ──
say "1 of 4 · Big files in Downloads"
list="$(mktemp)"
find "$HOME/Downloads" -maxdepth 3 \( -type f -o -type d -name '*.app' \) -size +200M -mtime +30 -prune 2>/dev/null \
  | while IFS= read -r f; do printf '%s\t%s\n' "$(du -sk "$f" 2>/dev/null | awk '{print $1}')" "$f"; done \
  | sort -rn | head -15 > "$list"
if [ ! -s "$list" ]; then
  note "Nothing over 200 MB that's older than a month. Nothing to do here."
else
  note "These are over 200 MB and haven't changed in a month. Installers (.dmg, .pkg, .zip) are usually safe to remove."
  while IFS="$(printf '\t')" read -r kb f; do
    if ask "Move to Trash: ${f#$HOME/} ($(human "$kb"))?"; then
      to_trash "$f" && note "moved to Trash" || note "couldn't move it; skipped"
    fi
  done < "$list"
fi
rm -f "$list"

# ── 2. App caches ──
say "2 of 4 · App caches"
cache_kb=$(du -sk "$HOME/Library/Caches" 2>/dev/null | awk '{print $1}')
if [ "${cache_kb:-0}" -lt 512000 ]; then
  note "Only $(human "${cache_kb:-0}") of caches. Not worth clearing."
else
  note "Apps keep $(human "$cache_kb") of temporary copies here (web pages, thumbnails, updates)."
  note "Clearing them is safe: apps rebuild what they need, a little slower the first time."
  note "Quit other apps first (especially web browsers) for the cleanest result."
  if ask "Clear app caches ($(human "$cache_kb"))?"; then
    find "$HOME/Library/Caches" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
    note "cleared (a few protected by macOS stay; that's normal)"
  fi
fi

# ── 3. The Trash ──
say "3 of 4 · The Trash"
count=$(osascript -e 'tell application "Finder" to count items of trash' 2>/dev/null || echo "?")
if [ "$count" = 0 ]; then
  note "The Trash is already empty."
else
  note "The Trash holds ${count} item(s). Emptying it deletes them for good: open it from the Dock first if you want to check."
  if ask "Empty the Trash?"; then
    osascript -e 'tell application "Finder" to empty trash' >/dev/null 2>&1 && note "emptied" || note "couldn't empty it; empty it from the Dock (right-click the Trash → Empty Trash)"
  fi
fi

# ── 4. Apple's Storage settings ──
say "4 of 4 · More space, Apple's way"
note "System Settings → General → Storage shows what else is big: old iPhone and iPad backups"
note "(iOS Files), large files, and apps you don't use, with a safe way to remove each."
if ask "Open Storage settings now?"; then
  open "x-apple.systempreferences:com.apple.settings.Storage" 2>/dev/null || open -b com.apple.systempreferences
fi

sleep 2
now=$(free_gb)
printf '\n\033[1;32m✓ Free now: %s GB\033[0m (was %s GB)\n\n' "$now" "$start"
