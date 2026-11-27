#!/bin/bash
# Can this Mac run Recall? A read-only check: it installs nothing and changes nothing.
#
#   curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/check.sh | bash
#
# Answers in plain words: ✓ ready, ! can install but tight, ✗ can't install (and what to do).
# Exit code: 0 ready · 3 fits but tight · 2 not enough free space (only that) · 1 can't run on this Mac.
# install.sh runs this same check first (bash check.sh --install), so the numbers live in one place.
#
# The numbers, and why:
#   Chip       Apple Silicon (M1 or newer). Intel Macs can't run the local AI at a usable speed.
#   macOS      14 (Sonoma) or newer. The AI runtime and voice transcription need it.
#   Memory     8 GB minimum: one AI model (gemma3:4b) does everything.
#              16 GB or more: a second, better writing model (qwen3:8b) is added.
#   Free disk  Recall takes about 12 GB with two models (models 8.8 GB + tools 3.5 GB),
#              about 7.5 GB with one. After installing, the Mac must keep at least 10 GB free:
#              macOS needs that room to run (memory swap, caches), and Recall stops accepting
#              saves when the disk is under 5 GB free.
#                Minimum to install:  25 GB free (16 GB+ memory) · 20 GB free (8 GB memory)
#                Comfortable:         50 GB free. Leaves room for a macOS update (25 to 35 GB)
#                                     and years of saved photos, voice notes and documents.
set -u

MODE="${1:-check}"   # check | --install
ok=1; tight=0; space_short=0; hard=0
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
red() { printf '\033[1;31m%s\033[0m\n' "$*"; }
line() { printf '    %-11s %s\n' "$1" "$2"; }

if [ "$(uname -s)" != "Darwin" ]; then red "✗ This isn't a Mac. Recall installs on a Mac."; exit 1; fi

arch="$(uname -m)"
macos="$(sw_vers -productVersion)"; major="${macos%%.*}"
mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
free_gb="${RECALL_TEST_FREE_GB:-$(df -g "$HOME" | awk 'NR==2 {print $4}')}"   # the override is for the installer test
model_name="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "?")"

# Models already downloaded (an earlier, stopped install) don't need the room again.
# The same for an earlier install's tools, so running the installer again (to update) isn't refused.
have_gb=0
for d in "$HOME/.ollama/models/blobs" "$HOME/.recall"; do
  if [ -d "$d" ]; then have_gb=$(( have_gb + $(du -sg "$d" 2>/dev/null | awk '{print $1}') )); fi
done
if [ "$mem_gb" -ge 16 ]; then need_min=25; size=12; models="two AI models (about 9 GB)"; else need_min=20; size=8; models="one AI model (about 4 GB)"; fi
need_rec=50
avail=$(( free_gb + have_gb ))   # what counts toward the install

printf '\n\033[1mChecking this Mac for Recall\033[0m\n\n'
problems=()

if [ "$arch" = "arm64" ]; then line "Chip" "✓ $model_name"
else line "Chip" "✗ $model_name (Intel)"; ok=0; hard=1; problems+=("This Mac has an Intel chip. Recall's AI needs Apple Silicon (M1 or newer); on Intel it would be too slow to use. Recall can't be installed on this Mac."); fi

if [ "$major" -ge 14 ]; then line "macOS" "✓ $macos"
else line "macOS" "✗ $macos (needs 14 or newer)"; ok=0; hard=1; problems+=("Update macOS first: Apple menu → System Settings → General → Software Update. Then check again."); fi

if [ "$mem_gb" -ge 16 ]; then line "Memory" "✓ ${mem_gb} GB (room for both AI models)"
elif [ "$mem_gb" -ge 8 ]; then line "Memory" "✓ ${mem_gb} GB (one AI model; titles a little simpler)"
elif [ "${RECALL_ALLOW_SMALL:-0}" = 1 ]; then line "Memory" "! ${mem_gb} GB (below 8 GB; allowed for testing)"
else line "Memory" "✗ ${mem_gb} GB (needs 8 GB)"; ok=0; hard=1; problems+=("Recall needs at least 8 GB of memory. This Mac has ${mem_gb} GB, so it can't run Recall."); fi

if [ "$avail" -ge "$need_rec" ]; then line "Free space" "✓ ${free_gb} GB free (Recall uses about ${size} GB)"
elif [ "$avail" -ge "$need_min" ]; then line "Free space" "! ${free_gb} GB free (enough, but tight)"; tight=1
else line "Free space" "✗ ${free_gb} GB free (needs ${need_min} GB)"; ok=0; space_short=1
  problems+=("Free up $(( need_min - avail )) GB or more, then check again. A safe helper asks before removing anything: curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/free-space.sh | bash")
fi

echo
if [ "$ok" = 0 ]; then
  red "✗ Recall can't be installed on this Mac yet."
  for p in "${problems[@]}"; do echo "  • $p"; done
  echo
  if [ "$hard" = 0 ] && [ "$space_short" = 1 ]; then exit 2; fi
  exit 1
fi
if [ "$tight" = 1 ]; then
  yellow "! Recall fits, but the Mac will be fairly full."
  echo "  After installing, about $(( avail - size )) GB stays free. Recall works, but macOS updates need 25 to 35 GB"
  echo "  free, and photos and videos you save take room too. Recommended: ${need_rec} GB free before installing."
  echo "  A safe helper can free space (it asks before removing anything):"
  echo "    curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/free-space.sh | bash"
else
  green "✓ This Mac is ready for Recall."
fi
echo "  It will download $models plus tools, and leave about $(( avail - size )) GB free."
echo
if [ "$tight" = 1 ]; then exit 3; fi
exit 0
