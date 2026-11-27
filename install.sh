#!/bin/zsh
# Recall installer: everything Recall needs, on one Mac, with no admin password and no Homebrew.
#
#   The one line for a new Mac (downloads Recall, then runs this):
#     curl -fsSL https://raw.githubusercontent.com/maximilian-dollaz/recall/main/get.sh | bash
#   From a checkout:
#     zsh install.sh
#
# Needs: an Apple Silicon Mac (M1 or newer), macOS 14 or newer, 8 GB memory (16 GB recommended),
# and 10 to 16 GB of free disk. Takes 15 to 45 minutes, most of it downloading the AI models.
#
# What it sets up, all inside your home folder:
#   ~/.recall/env      the tools Recall uses (ffmpeg, pdftotext, jq, git, Python), from conda-forge via micromamba
#   ~/.bun             Bun, which runs Recall
#   Ollama             the local AI models (reuses an Ollama already on this Mac)
#   GBrain             the library and its search, pinned to the tested version
#   Recall             the app, started at login, at http://localhost:3344
#
# Safe to run again at any time: every step checks what's already there and skips it.
# Your library, settings (.env) and keys are never replaced.
#
# Options (environment variables):
#   RECALL_TEXT_MODEL / RECALL_VISION_MODEL   choose the models instead of the automatic choice
#   RECALL_SOUL=1                             also install the Soul Map companion app
#   RECALL_NO_OPEN=1                          don't open the browser at the end
#   RECALL_ALLOW_SMALL=1                      install even with less than 8 GB memory (slow)
set -euo pipefail

GBRAIN_VERSION="0.60.380.0"          # pinned: update on purpose, test, then bump
EMBED_MODEL="nomic-embed-text"       # local search model (274 MB)
HERE="$(cd "$(dirname "${0:A}")" && pwd)"
TOOLS="$HOME/.recall"                # the installer's own tools, kept apart from the rest of the Mac
ENV_DIR="$TOOLS/env"
LOGS="$TOOLS/logs"
LOG="$LOGS/install.log"
export OLLAMA_BASE_URL="http://localhost:11434/v1"
# Our tools first, so nothing reaches for Apple's developer-tools stubs (which pop up an install window).
export PATH="$ENV_DIR/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
APP_PATH="$ENV_DIR/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOGS"
# Everything is also written to the log, for help if something goes wrong.
exec > >(tee -a "$LOG") 2>&1
print "\n===== Recall install, $(date) ====="

TOTAL=11; N=0; STEP="getting ready"
step() { N=$((N+1)); STEP="$*"; print -P "\n%F{green}%B[$N of $TOTAL]%b%f %B$*%b"; }
note() { print "    $*"; }
stop_with() { print -P "\n%F{red}%B✗ $*%b%f"; exit 1; }

on_exit() {
  local code=$?
  (( code == 0 )) && return
  # The Mac itself isn't ready (check.sh already said why and what to do): running again won't help.
  if [[ "${HARD_STOP:-0}" == 1 ]]; then return; fi
  print -P "\n%F{red}%B✗ The install stopped at step $N: $STEP.%b%f"
  print "  Nothing is broken. Paste the same line into Terminal again and press Return;"
  print "  it picks up where it stopped. If it stops at the same place twice, send this file"
  print "  to the person who shared Recall with you:"
  print "    $LOG"
  print "  (In Finder: Go menu → Go to Folder… → paste that path.)"
}
trap on_exit EXIT

# retry <tries> <command…>: for downloads, which fail now and then on a busy Wi-Fi.
retry() { local n=$1; shift; local i; for (( i = 1; i <= n; i++ )); do "$@" && return 0; (( i < n )) && { note "That didn't finish; trying again ($((i+1)) of $n)…"; sleep 5; }; done; return 1; }

# render <template> <out>: a service file from server/, with this Mac's paths.
render() {
  sed -e "s#__RECALL__#$HERE#g" -e "s#__SOUL__#${SOUL_DIR:-$(dirname "$HERE")/soul-map}#g" -e "s#__HOME__#$HOME#g" \
      -e "s#__BUN__#$HOME/.bun/bin/bun#g" -e "s#__PATH__#$APP_PATH#g" -e "s#__OLLAMA__#${OLLAMA_BIN:-ollama}#g" "$1" > "$2"
}
# load <label> <plist>: (re)start a background service for this user. It starts at login and restarts if it stops.
load() {
  local svc="gui/$(id -u)/$1" i
  launchctl bootout "$svc" 2>/dev/null || true
  # bootout returns before the old copy is fully gone; bootstrapping too soon fails with "Input/output error".
  for i in {1..20}; do launchctl print "$svc" >/dev/null 2>&1 || break; sleep 0.5; done
  for i in {1..5}; do launchctl bootstrap "gui/$(id -u)" "$2" 2>/dev/null && return 0; sleep 2; done
  launchctl bootstrap "gui/$(id -u)" "$2"   # last try, with the error shown
}

print -P "%B"
print "  ┌───────────────────────────────────────────────┐"
print "  │  Installing Recall                            │"
print "  │  Keep this window open until it says Done.    │"
print "  │  Keep the Mac plugged in and on Wi-Fi.        │"
print "  └───────────────────────────────────────────────┘"
print -P "%b"

# ── 1. This Mac ───────────────────────────────────────────────────────────────
step "Checking this Mac"
# The same check anyone can run on its own first (check.sh): chip, macOS, memory, free space.
c=0; bash "$HERE/check.sh" --install || c=$?
# Short on space (2) or tight (3): with a person at the keyboard, offer the safe clean-up, then check again.
# (Run by an AI with no keyboard, it skips the offer: the check already said what to do.)
if (( c == 2 || c == 3 )) && { : </dev/tty; } 2>/dev/null; then
  print -n "\n  Free up space now? It shows what's taking room and asks before removing anything. [y/N] "
  read -r a </dev/tty
  if [[ "$a" == [yY]* ]]; then
    bash "$HERE/free-space.sh"
    c=0; bash "$HERE/check.sh" --install || c=$?
  fi
fi
(( c == 0 || c == 3 )) || { HARD_STOP=1; exit 1; }
mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
# The models. With 16 GB or more, a stronger model writes titles and sorts (qwen3:8b, 5.2 GB) next to the one that
# sees pictures (gemma3:4b, 3.3 GB). With less, the picture model does both: smaller, and still good.
VISION_MODEL="${RECALL_VISION_MODEL:-gemma3:4b}"
if [[ -n "${RECALL_TEXT_MODEL:-}" ]]; then TEXT_MODEL="$RECALL_TEXT_MODEL"
elif (( mem_gb >= 16 )); then TEXT_MODEL="qwen3:8b"
else TEXT_MODEL="$VISION_MODEL"; fi
if [[ "$TEXT_MODEL" == "$VISION_MODEL" ]]; then dl="about 4 GB"; else dl="about 9 GB"; fi
note "AI models: $VISION_MODEL (pictures)${TEXT_MODEL:+, $TEXT_MODEL (writing and sorting)}, $dl to download"
# Keep the Mac awake while this runs; it stops by itself when the installer ends.
caffeinate -dims -w $$ &>/dev/null &

# ── 2. Tools ──────────────────────────────────────────────────────────────────
step "Installing tools (ffmpeg, pdftotext, Python, git) into ~/.recall"
MAMBA="$TOOLS/bin/micromamba"
if [[ ! -x "$MAMBA" ]]; then
  mkdir -p "$TOOLS/bin"
  retry 3 sh -c "curl -fsSL https://micro.mamba.pm/api/micromamba/osx-arm64/latest | tar -xj -C '$TOOLS' bin/micromamba"
fi
PKGS=(ffmpeg poppler jq git "python=3.12")
if [[ "${RECALL_SOUL:-0}" == 1 ]]; then PKGS+=(nodejs); fi
missing=0; for b in ffmpeg ffprobe pdftotext jq git python3; do [[ -x "$ENV_DIR/bin/$b" ]] || missing=1; done
if [[ "${RECALL_SOUL:-0}" == 1 && ! -x "$ENV_DIR/bin/npm" ]]; then missing=1; fi
if (( missing )); then
  export MAMBA_ROOT_PREFIX="$TOOLS/mamba"
  if [[ -d "$ENV_DIR/conda-meta" ]]; then retry 3 "$MAMBA" install -y -q -p "$ENV_DIR" -c conda-forge $PKGS
  else retry 3 "$MAMBA" create -y -q -p "$ENV_DIR" -c conda-forge $PKGS; fi
  "$MAMBA" clean -y -a -q >/dev/null 2>&1 || true   # the download cache, not needed after install
else
  note "already installed"
fi

# ── 3. Bun ────────────────────────────────────────────────────────────────────
step "Installing Bun (runs Recall)"
if [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  retry 3 sh -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
fi
"$HOME/.bun/bin/bun" --version | sed 's/^/    bun /'

# ── 4. Ollama ─────────────────────────────────────────────────────────────────
step "Setting up Ollama (runs the AI models on this Mac)"
OLLAMA_BIN=""
for c in "/Applications/Ollama.app/Contents/Resources/ollama" "$HOME/Applications/Ollama.app/Contents/Resources/ollama" \
         /opt/homebrew/bin/ollama /usr/local/bin/ollama; do
  [[ -x "$c" ]] && { OLLAMA_BIN="$c"; break; }
done
if [[ -z "$OLLAMA_BIN" ]]; then
  note "Downloading Ollama (about 200 MB)"
  mkdir -p "$HOME/Applications"
  tmpd="$(mktemp -d)"
  retry 3 curl -fsSL -o "$tmpd/Ollama.zip" https://ollama.com/download/Ollama-darwin.zip
  ditto -x -k "$tmpd/Ollama.zip" "$HOME/Applications"
  rm -rf "$tmpd"
  OLLAMA_BIN="$HOME/Applications/Ollama.app/Contents/Resources/ollama"
  [[ -x "$OLLAMA_BIN" ]] || stop_with "Ollama downloaded, but its program wasn't where expected ($OLLAMA_BIN)."
fi
mkdir -p "$TOOLS/bin"; ln -sf "$OLLAMA_BIN" "$TOOLS/bin/ollama"
export PATH="$TOOLS/bin:$PATH"
if curl -sf localhost:11434/api/version >/dev/null 2>&1; then
  note "Ollama is already running"
else
  mkdir -p "$HOME/Library/LaunchAgents"
  render "$HERE/server/com.recall.ollama.plist" "$HOME/Library/LaunchAgents/com.recall.ollama.plist"
  load com.recall.ollama "$HOME/Library/LaunchAgents/com.recall.ollama.plist"
  for i in {1..60}; do curl -sf localhost:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
  curl -sf localhost:11434/api/version >/dev/null || stop_with "Ollama didn't start. See $LOGS/ollama.err"
fi
note "Ollama $(curl -s localhost:11434/api/version | sed 's/.*"version":"\([^"]*\)".*/\1/')"

# ── 5. Models ─────────────────────────────────────────────────────────────────
step "Downloading the AI models ($dl; often 5 to 30 minutes)"
note "The progress bars below are the download. Leave the window open."
# Read the whole list first: `grep -q` stopping early would break the pipe, and pipefail would call that a failure.
have_model() { local names; names="$(ollama list 2>/dev/null | awk 'NR>1 {print $1}')" || true; [[ $'\n'"$names"$'\n' == *$'\n'"$1"$'\n'* || $'\n'"$names"$'\n' == *$'\n'"${1}:latest"$'\n'* ]]; }
for m in "$EMBED_MODEL" "$VISION_MODEL" "$TEXT_MODEL"; do
  if have_model "$m"; then note "$m: already here"; continue; fi
  note "$m:"
  retry 4 ollama pull "$m"   # a stopped download resumes where it left off
done

# ── 6. GBrain ─────────────────────────────────────────────────────────────────
step "Installing the library (GBrain ${GBRAIN_VERSION})"
if [[ "$(gbrain --version 2>/dev/null || true)" == *"${GBRAIN_VERSION}"* ]]; then
  note "already installed"
else
  retry 3 bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
fi
# The library's background service reads ~/.gbrain/env; give it our tools (git, jq) and the model address.
mkdir -p "$HOME/.gbrain"; touch "$HOME/.gbrain/env"
grep -q '^OLLAMA_BASE_URL=' "$HOME/.gbrain/env" || echo "OLLAMA_BASE_URL=$OLLAMA_BASE_URL" >> "$HOME/.gbrain/env"
grep -q '^PATH=' "$HOME/.gbrain/env" || echo "PATH=$APP_PATH" >> "$HOME/.gbrain/env"
chmod 600 "$HOME/.gbrain/env"

# ── 7. Your library ───────────────────────────────────────────────────────────
step "Creating your private library"
if [[ ! -f "$HOME/.gbrain/config.json" ]]; then
  mkdir -p "$HERE/library"
  git config --global user.name >/dev/null 2>&1 || git config --global user.name "$(id -F 2>/dev/null || whoami)"
  git config --global user.email >/dev/null 2>&1 || git config --global user.email "$(whoami)@recall.local"
  gbrain init --pglite --non-interactive \
    --content-root "$HERE/library" --git \
    --embedding-model "ollama:${EMBED_MODEL}" --embedding-dimensions 768 >/dev/null
  gbrain apply-migrations --yes --no-autopilot-install >/dev/null 2>&1 || true
  note "made in $HERE/library"
else
  note "found your library; leaving it as it is"
fi
mkdir -p "$HERE/library"
[[ -f "$HERE/library/categories.json" ]] || cp "$HERE/server/starter-categories.json" "$HERE/library/categories.json"

# ── 8. Library server ─────────────────────────────────────────────────────────
# PGLite is single-writer, so one `gbrain serve --http` on 127.0.0.1:3131 owns
# the brain and every client (Claude Code, the web app, cl) talks to it.
step "Starting the library server"
SERVE_URL="http://127.0.0.1:3131/mcp"
SERVE_DIR="$HOME/.gbrain/serve"
CLIENTS="$SERVE_DIR/clients"            # private credential handoffs, 0600, never printed
ADMIN_TOKEN="$SERVE_DIR/admin-token"    # owner credential, created by `mcp expose`
# Every tool the `full` profile may delegate in 0.60.380 (delegation needs an explicit list).
CC_BOUND_TOOLS="add_timeline_entry,find_anomalies,get_backlinks,get_ingest_log,get_page,get_recent_salience,list_link_sources,list_pages,put_page,query,resolve_slugs,search,traverse_graph"

# Stop stdio gbrain servers (SIGTERM, never -9) so the shared server can own the brain.
pids=($( { pgrep -f 'gbrain serve' || true; } | while read -r p; do ps -o command= -p "$p" | grep -q -- '--http' || echo "$p"; done))
if (( ${#pids} )); then
  note "stopping: ${pids[*]}"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  for i in {1..30}; do ps -p "${(j:,:)pids}" >/dev/null 2>&1 || break; sleep 1; done
  ps -p "${(j:,:)pids}" >/dev/null 2>&1 && stop_with "Other library sessions are still open (${pids[*]}). Close them and run the line again."
fi
mkdir -p "$SERVE_DIR"
gbrain mcp expose --no-tailscale --surface full --yes >/dev/null
for i in {1..60}; do curl -sf http://127.0.0.1:3131/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3131/health >/dev/null || stop_with "The library server didn't start. See $SERVE_DIR/serve.err"

(umask 077; mkdir -p "$CLIENTS"); chmod 700 "$CLIENTS"
[[ -f "$CLIENTS/claude-code.json" ]] || gbrain mcp grant claude-code --harness claude-code \
  --profile full --bound-tools "$CC_BOUND_TOOLS" --source default --url "$SERVE_URL" \
  --admin-token-file "$ADMIN_TOKEN" --credentials-out "$CLIENTS/claude-code.json" >/dev/null
[[ -f "$CLIENTS/app.json" ]] || gbrain mcp grant app --harness generic \
  --profile memory-writer --source default --url "$SERVE_URL" \
  --admin-token-file "$ADMIN_TOKEN" --credentials-out "$CLIENTS/app.json" >/dev/null
# cl talks to the server as a thin client in its own GBRAIN_HOME, so the server's own config stays untouched.
[[ -f "$CLIENTS/cl.json" ]] || gbrain mcp grant cl --harness generic \
  --profile memory-writer --source default --url "$SERVE_URL" \
  --admin-token-file "$ADMIN_TOKEN" --credentials-out "$CLIENTS/cl.json" >/dev/null
CL_HOME="$SERVE_DIR/cl-home"
if [[ ! -f "$CL_HOME/.gbrain/config.json" ]]; then
  (umask 077; mkdir -p "$CL_HOME")
  GBRAIN_HOME="$CL_HOME" GBRAIN_REMOTE_CLIENT_SECRET="$(jq -r .client_secret "$CLIENTS/cl.json")" \
    gbrain init --mcp-only --non-interactive --issuer-url "${SERVE_URL%/mcp}" --mcp-url "$SERVE_URL" \
    --oauth-client-id "$(jq -r .client_id "$CLIENTS/cl.json")" >/dev/null
fi
chmod +x "$HERE/bin/gbrain-mcp-headers" "$HERE/bin/cl"
ln -sf "$HERE/bin/gbrain-mcp-headers" "$SERVE_DIR/mcp-headers"   # symlinked: no spaces in the path
tools=$(curl -s "$SERVE_URL" \
  -H "Authorization: $("$HERE/bin/gbrain-mcp-headers" app | jq -r .Authorization)" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | sed 's/^data: //' | grep '^{' | jq '.result.tools | length')
(( ${tools:-0} > 0 )) || stop_with "The library server didn't answer. See $SERVE_DIR/serve.err"
note "library server answering ($tools tools)"
# If Claude Code is on this Mac, connect it to the library (the secret stays in the private handoff).
if command -v claude >/dev/null; then
  claude mcp remove gbrain -s user >/dev/null 2>&1 || true
  claude mcp add-json gbrain -s user \
    "{\"type\":\"http\",\"url\":\"$SERVE_URL\",\"headersHelper\":\"$SERVE_DIR/mcp-headers\"}" >/dev/null && note "connected Claude Code to your library"
fi

# ── 9. Reading pictures and voice ─────────────────────────────────────────────
step "Setting up text-in-pictures and voice notes (on this Mac)"
VENV="$HERE/tools/.venv"
[[ -x "$VENV/bin/python" ]] || "$ENV_DIR/bin/python3" -m venv "$VENV"
if ! "$VENV/bin/python" -c 'import mlx_whisper, Vision, Quartz, qrcode' 2>/dev/null; then
  retry 3 "$VENV/bin/pip" install -q --disable-pip-version-check mlx-whisper pyobjc-framework-Vision pyobjc-framework-Quartz qrcode
fi
# Text in pictures: the Swift version when Apple's developer tools are already here, else the same thing in Python.
# (Never call swiftc without them: macOS would pop up an install window.)
if [[ ! -x "$HERE/tools/ocr" ]]; then
  if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1 && swiftc -O "$HERE/tools/ocr.swift" -o "$HERE/tools/ocr" 2>/dev/null; then
    note "text reader: built"
  else
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$VENV/bin/python" "$HERE/tools/ocr.py" > "$HERE/tools/ocr"
    chmod +x "$HERE/tools/ocr"; note "text reader: ready"
  fi
fi

# ── 10. Recall ────────────────────────────────────────────────────────────────
step "Starting Recall"
(cd "$HERE" && bun install --silent)
(cd "$HERE/tools" && bun install --silent)
if [[ ! -f "$HERE/.env" ]]; then
  # Your settings, filled in for this Mac. Recall on this Mac is yours: opening it here needs no sign-in.
  full="$(id -F 2>/dev/null || whoami)"; first="${full%% *}"
  sed -e "s#^RECALL_OWNER_EMAIL=.*#RECALL_OWNER_EMAIL=$(whoami)@this-mac.local#" \
      -e "s#^RECALL_OWNER_NAME=.*#RECALL_OWNER_NAME=$first#" \
      -e "s#^RECALL_OPERATOR=.*#RECALL_OPERATOR=$full#" \
      -e "/^RECALL_CONTACT_EMAIL=/d" "$HERE/.env.example" > "$HERE/.env"
  { echo; echo "# Chosen by the installer for this Mac's ${mem_gb} GB of memory."
    echo "LIBRARIAN_MODEL=$VISION_MODEL"; echo "LIBRARIAN_TEXT_MODEL=$TEXT_MODEL"
    echo "# Free the model's memory 2 minutes after it was last used, so other apps stay fast."
    echo "RECALL_MODEL_KEEP_ALIVE=2m"; } >> "$HERE/.env"
  note "settings written to $HERE/.env"
fi
grep -q '^RECALL_MODEL_KEEP_ALIVE=' "$HERE/.env" || printf '\n# Free the model memory soon after use, so other apps stay fast.\nRECALL_MODEL_KEEP_ALIVE=2m\n' >> "$HERE/.env"
mkdir -p "$HOME/Library/LaunchAgents"
render "$HERE/server/com.contextlibrary.app.plist" "$HOME/Library/LaunchAgents/com.contextlibrary.app.plist"
load com.contextlibrary.app "$HOME/Library/LaunchAgents/com.contextlibrary.app.plist"

# ── Soul Map (optional: RECALL_SOUL=1) ────────────────────────────────────────
# The Soul Map (github.com/maximilian-dollaz/soul-map) is a Next.js app that lives
# next to this folder and runs as its own service on 127.0.0.1:3355. Phones
# reach it through the web app at /soul. Re-running this step updates and rebuilds.
if [[ "${RECALL_SOUL:-0}" == 1 ]]; then
  SOUL_REPO="https://github.com/maximilian-dollaz/soul-map.git"
  SOUL_DIR="$(dirname "$HERE")/soul-map"
  note "Soul Map: fetching $SOUL_DIR"
  if [[ -d "$SOUL_DIR/.git" ]]; then
    git -C "$SOUL_DIR" pull --ff-only || note "could not fast-forward $SOUL_DIR (local changes?); building what is there"
  elif [[ -e "$SOUL_DIR" ]]; then
    note "$SOUL_DIR exists but is not a git checkout; leaving it alone"
  else
    git clone "$SOUL_REPO" "$SOUL_DIR"
  fi
  note "Soul Map: building"
  (cd "$SOUL_DIR/app" && npm ci --no-audit --no-fund && npm run build)
  SOUL_PLIST="$HOME/Library/LaunchAgents/com.soulmap.app.plist"
  render "$HERE/server/com.soulmap.app.plist" "$SOUL_PLIST"
  sed -i '' -e "s#/usr/local/bin/npm#$ENV_DIR/bin/npm#g" "$SOUL_PLIST"
  load com.soulmap.app "$SOUL_PLIST"
  for i in {1..30}; do curl -sf -o /dev/null http://127.0.0.1:3355/soul && break; sleep 1; done
  # Its local pieces use qwen3:8b when there is room for it; otherwise they share the librarian's model.
  if (( mem_gb >= 16 )) && ! have_model qwen3:8b; then retry 4 ollama pull qwen3:8b; fi
fi

# Developer checkouts: the public check before every commit.
[[ -d "$HERE/.git" ]] && git -C "$HERE" config core.hooksPath .githooks 2>/dev/null || true

# `cl` in new Terminal windows, and a Recall icon on the Desktop.
grep -qF "$HERE/bin" "$HOME/.zshrc" 2>/dev/null || cat >> "$HOME/.zshrc" <<EOF

# Recall
export PATH="$HERE/bin:$ENV_DIR/bin:\$PATH"
export OLLAMA_BASE_URL=$OLLAMA_BASE_URL
EOF
if [[ -d "$HOME/Desktop" && ! -e "$HOME/Desktop/Recall.webloc" ]]; then
  cat > "$HOME/Desktop/Recall.webloc" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>http://localhost:3344</string></dict></plist>
EOF
fi

# ── 11. Check ─────────────────────────────────────────────────────────────────
step "Checking that everything works"
for i in {1..60}; do curl -sf -o /dev/null http://127.0.0.1:3344/api/health && break; sleep 1; done
health="$(curl -s http://127.0.0.1:3344/api/health || true)"
[[ "$health" == *'"ok":true'* ]] || stop_with "Recall didn't start. See $SERVE_DIR/app.err"
[[ "$health" != *'"error"'* ]] || stop_with "Recall started but can't reach your library: $health"
note "✓ Recall is running at http://localhost:3344"
for m in "$EMBED_MODEL" "$VISION_MODEL" "$TEXT_MODEL"; do have_model "$m" || stop_with "The model $m is missing."; done
note "✓ AI models downloaded"
# Load the model once and ask it something tiny: proves it runs on this Mac (the first load takes a moment).
reply="$(curl -s --max-time 300 localhost:11434/api/generate \
  -d "{\"model\":\"$TEXT_MODEL\",\"prompt\":\"Reply with the single word: ready\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" \
  | jq -r '.response // .error // empty' 2>/dev/null || true)"
[[ -n "$reply" && "$reply" != *rror* ]] || stop_with "The AI model didn't answer ($reply). See $LOGS/ollama.err"
note "✓ The AI model answers on this Mac"

trap - EXIT
print -P "\n%F{green}%B✓ Done. Recall is installed and running.%b%f"
print "  Open it any time at  http://localhost:3344  (or double-click Recall on your Desktop)."
print "  It starts by itself when the Mac starts. Everything you save stays on this Mac."
print "  To update later, paste the same install line again."
[[ "${RECALL_NO_OPEN:-0}" == 1 ]] || open "http://localhost:3344" 2>/dev/null || true
