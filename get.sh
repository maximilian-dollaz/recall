#!/bin/bash
# Recall, in one line. Paste into Terminal on a Mac and press Return:
#
#   curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/get.sh | bash
#
# It downloads Recall into ~/Recall (no git, no Homebrew, no admin password),
# then runs ~/Recall/install.sh, which sets up everything else and opens Recall.
# Safe to run again: it picks up where it stopped and keeps your library.
set -euo pipefail

REPO="maximilian-dollaz/recall"
REF="${RECALL_REF:-main}"                 # a branch or tag; the installer test uses the branch under test
DEST="${RECALL_HOME:-$HOME/Recall}"

say()  { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Recall installs on a Mac. This computer isn't one."

if [ -d "$DEST/.git" ]; then
  # A developer checkout (git clone). Leave the code exactly as it is and just run its installer.
  say "Found your Recall folder at $DEST (a git checkout); using it as it is"
else
  say "Downloading Recall into $DEST"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  for attempt in 1 2 3; do
    curl -fsSL --retry 3 "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$tmp/recall.tgz" && break
    [ "$attempt" = 3 ] && fail "Could not download Recall. Check the Wi-Fi, then paste the same line again."
    sleep 3
  done
  mkdir -p "$tmp/src" "$DEST"
  tar -xzf "$tmp/recall.tgz" -C "$tmp/src" --strip-components 1
  # Copy the code over the folder. Your library, settings (.env) and downloaded tools stay as they are:
  # they aren't in the download, so nothing replaces them.
  cp -R "$tmp/src/." "$DEST/"
fi

exec /bin/zsh "$DEST/install.sh" "$@"
