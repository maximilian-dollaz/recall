#!/bin/zsh
# Recall installer — one command on a fresh Apple Silicon Mac.
# Requirements: macOS 14+, Apple Silicon, 16 GB memory, 15 GB free disk.
#
#   zsh install.sh
#
# What it does: Homebrew (if missing), Bun, Ollama + the local search model,
# GBrain pinned to the version this project was tested on, document converters,
# a fresh private brain in ./library, one shared GBrain server (launchd, 127.0.0.1:3131)
# with two clients (claude-code, app), and the Claude Code connection to it.
set -euo pipefail

GBRAIN_VERSION="0.60.380.0"          # pinned: update on purpose, test, then bump
EMBED_MODEL="nomic-embed-text"       # local search model (274 MB)
HERE="$(cd "$(dirname "${0:A}")" && pwd)"
export OLLAMA_BASE_URL="http://localhost:11434/v1"

say() { print -P "%F{green}▸%f $*"; }

[[ "$(uname -m)" == "arm64" ]] || { echo "This installer expects an Apple Silicon Mac." >&2; exit 1; }
mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
(( mem_gb >= 16 )) || echo "Warning: ${mem_gb} GB memory. 16 GB is the floor; it may be slow."

if ! command -v brew >/dev/null; then
  say "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

say "Installing tools (bun, ollama, poppler)"
brew list bun >/dev/null 2>&1 || brew install oven-sh/bun/bun
brew list --cask ollama >/dev/null 2>&1 || brew install --cask ollama   # the app, not the source build
brew list poppler >/dev/null 2>&1 || brew install poppler               # pdftotext
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg                 # voice notes and video frames
command -v jq >/dev/null || brew install jq                               # server checks + header helper

say "Installing GBrain ${GBRAIN_VERSION}"
bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
export PATH="$HOME/.bun/bin:$PATH"

say "Starting Ollama and downloading the search model"
curl -s localhost:11434/api/version >/dev/null 2>&1 || (ollama serve >/dev/null 2>&1 &)
for i in {1..30}; do curl -s localhost:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
ollama pull "$EMBED_MODEL"
say "Downloading the librarian model (sorts and describes what you save)"
ollama pull "${LIBRARIAN_MODEL:-gemma3:4b}"

say "Installing link-saver dependencies"
(cd "$HERE/tools" && bun install --silent)

if [[ ! -f "$HOME/.gbrain/config.json" ]]; then
  say "Creating your private library in $HERE/library"
  mkdir -p "$HERE/library"
  gbrain init --pglite --non-interactive \
    --content-root "$HERE/library" --git \
    --embedding-model "ollama:${EMBED_MODEL}" --embedding-dimensions 768 >/dev/null
  gbrain apply-migrations --yes --no-autopilot-install >/dev/null 2>&1 || true
else
  say "Existing library found at $HOME/.gbrain — leaving it alone"
fi

# ── Shared server ────────────────────────────────────────────────────────────
# PGLite is single-writer, so one `gbrain serve --http` on 127.0.0.1:3131 owns
# the brain and every client (Claude Code, the web app, later the phone) talks
# to it. launchd starts it at login and restarts it if it dies.
SERVE_URL="http://127.0.0.1:3131/mcp"
SERVE_DIR="$HOME/.gbrain/serve"
CLIENTS="$SERVE_DIR/clients"            # private credential handoffs, 0600, never printed
ADMIN_TOKEN="$SERVE_DIR/admin-token"    # owner credential, created by `mcp expose`
# Every tool the `full` profile may delegate in 0.60.380 (delegation needs an explicit list).
CC_BOUND_TOOLS="add_timeline_entry,find_anomalies,get_backlinks,get_ingest_log,get_page,get_recent_salience,list_link_sources,list_pages,put_page,query,resolve_slugs,search,traverse_graph"

say "Stopping stdio gbrain servers (SIGTERM, never -9) so the shared server can own the brain"
pids=($(pgrep -f 'gbrain serve' | while read -r p; do ps -o command= -p "$p" | grep -q -- '--http' || echo "$p"; done))
if (( ${#pids} )); then
  echo "  stopping: ${pids[*]}"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  for i in {1..30}; do ps -p "${(j:,:)pids}" >/dev/null 2>&1 || break; sleep 1; done
  ps -p "${(j:,:)pids}" >/dev/null 2>&1 && { echo "Still running after 30s: ${pids[*]}. Close those sessions and re-run." >&2; exit 1; }
fi

say "Starting the shared server (launchd: com.gbrain.serve, 127.0.0.1:3131)"
mkdir -p "$SERVE_DIR"
# The service wrapper sources ~/.gbrain/env last; launchd does not read ~/.zshrc reliably.
grep -q '^OLLAMA_BASE_URL=' "$HOME/.gbrain/env" 2>/dev/null || echo "OLLAMA_BASE_URL=$OLLAMA_BASE_URL" >> "$HOME/.gbrain/env"
chmod 600 "$HOME/.gbrain/env"
gbrain mcp expose --no-tailscale --surface full --yes >/dev/null
for i in {1..30}; do curl -sf http://127.0.0.1:3131/health >/dev/null && break; sleep 1; done

say "Registering clients: claude-code (full), app and cl (read+write, no admin)"
(umask 077; mkdir -p "$CLIENTS"); chmod 700 "$CLIENTS"
[[ -f "$CLIENTS/claude-code.json" ]] || gbrain mcp grant claude-code --harness claude-code \
  --profile full --bound-tools "$CC_BOUND_TOOLS" --source default --url "$SERVE_URL" \
  --admin-token-file "$ADMIN_TOKEN" --credentials-out "$CLIENTS/claude-code.json" >/dev/null
[[ -f "$CLIENTS/app.json" ]] || gbrain mcp grant app --harness generic \
  --profile memory-writer --source default --url "$SERVE_URL" \
  --admin-token-file "$ADMIN_TOKEN" --credentials-out "$CLIENTS/app.json" >/dev/null

say "Pointing cl at the shared server (thin client in its own GBRAIN_HOME)"
# A separate home keeps ~/.gbrain/config.json, which the server itself uses, untouched.
# The secret is passed at run time from the private handoff and never stored in that config.
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

say "Connecting Claude Code to the shared server"
# headersHelper reads (and renews) the token from the private handoff at connect
# time, so no secret is written into ~/.claude.json. Symlinked: no spaces in path.
ln -sf "$HERE/bin/gbrain-mcp-headers" "$SERVE_DIR/mcp-headers"
chmod +x "$HERE/bin/gbrain-mcp-headers"
if command -v claude >/dev/null; then
  claude mcp remove gbrain -s user >/dev/null 2>&1 || true
  claude mcp add-json gbrain -s user \
    "{\"type\":\"http\",\"url\":\"$SERVE_URL\",\"headersHelper\":\"$SERVE_DIR/mcp-headers\"}" >/dev/null
else
  echo "Claude Code not found; run this later:"
  echo "  claude mcp add-json gbrain -s user '{\"type\":\"http\",\"url\":\"$SERVE_URL\",\"headersHelper\":\"$SERVE_DIR/mcp-headers\"}'"
fi

say "Verifying: tools/list with the app credential"
tools=$(curl -s "$SERVE_URL" \
  -H "Authorization: $("$HERE/bin/gbrain-mcp-headers" app | jq -r .Authorization)" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | sed 's/^data: //' | grep '^{' | jq '.result.tools | length')
(( ${tools:-0} > 0 )) || { echo "Shared server did not answer tools/list; see $SERVE_DIR/serve.err" >&2; exit 1; }
echo "  app sees $tools tools at $SERVE_URL"

# ── Recall, the app ──
# render <template> <out>: a service file from server/, with this machine's paths.
render() { sed -e "s#__RECALL__#$HERE#g" -e "s#__SOUL__#${SOUL_DIR:-$(dirname "$HERE")/soul-map}#g" -e "s#__HOME__#$HOME#g" "$1" > "$2"; }
say "Your settings: .env (web address, owner, contact). Edit it, then: cl app restart"
[[ -f "$HERE/.env" ]] || cp "$HERE/.env.example" "$HERE/.env"
say "Text in pictures: Apple's OCR (tools/ocr)"
[[ -x "$HERE/tools/ocr" ]] || swiftc -O "$HERE/tools/ocr.swift" -o "$HERE/tools/ocr"
say "Voice notes: Whisper on this Mac (mlx-whisper in tools/.venv)"
[[ -x "$HERE/tools/.venv/bin/mlx_whisper" ]] || { python3 -m venv "$HERE/tools/.venv" && "$HERE/tools/.venv/bin/pip" install -q mlx-whisper; }
(cd "$HERE" && bun install --silent)
say "Starting Recall (launchd: com.contextlibrary.app, http://localhost:3344)"
mkdir -p "$HOME/Library/LaunchAgents" "$SERVE_DIR"
render "$HERE/server/com.contextlibrary.app.plist" "$HOME/Library/LaunchAgents/com.contextlibrary.app.plist"
launchctl bootout "gui/$(id -u)/com.contextlibrary.app" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.contextlibrary.app.plist"
for i in {1..30}; do curl -sf -o /dev/null http://127.0.0.1:3344/api/health && break; sleep 1; done
curl -s -o /dev/null -w "  recall: %{http_code} at http://localhost:3344\n" http://127.0.0.1:3344/api/health

# ── Soul Map (optional: RECALL_SOUL=1 zsh install.sh) ─────────────────────────────────────────────────────────────────
# The Soul Map (github.com/maximilian-dollaz/soul-map) is a Next.js app that lives
# next to this folder and runs as its own launchd service on 127.0.0.1:3355. Phones
# reach it through the web app at /soul. Re-running this step updates and rebuilds.
if [[ "${RECALL_SOUL:-0}" == 1 ]]; then
SOUL_REPO="https://github.com/maximilian-dollaz/soul-map.git"
SOUL_DIR="$(dirname "$HERE")/soul-map"
say "Soul Map: fetching $SOUL_DIR"
command -v npm >/dev/null || brew install node
if [[ -d "$SOUL_DIR/.git" ]]; then
  git -C "$SOUL_DIR" pull --ff-only || echo "  could not fast-forward $SOUL_DIR (local changes?); building what is there"
elif [[ -e "$SOUL_DIR" ]]; then
  echo "  $SOUL_DIR exists but is not a git checkout; leaving it alone"
else
  git clone "$SOUL_REPO" "$SOUL_DIR"
fi
say "Soul Map: building (npm ci && npm run build)"
(cd "$SOUL_DIR/app" && npm ci --no-audit --no-fund && npm run build)

say "Soul Map: installing the service (launchd: com.soulmap.app, 127.0.0.1:3355)"
SOUL_PLIST="$HOME/Library/LaunchAgents/com.soulmap.app.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$SERVE_DIR"
render "$HERE/server/com.soulmap.app.plist" "$SOUL_PLIST"
sed -i '' -e "s#/usr/local/bin/npm#$(command -v npm)#g" "$SOUL_PLIST"
launchctl bootout "gui/$(id -u)/com.soulmap.app" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$SOUL_PLIST"
for i in {1..30}; do curl -sf -o /dev/null http://127.0.0.1:3355/soul && break; sleep 1; done
curl -s -o /dev/null -w "  soul: %{http_code} at http://127.0.0.1:3355/soul\n" http://127.0.0.1:3355/soul

# The Soul Map's local pieces (correction classifier, export extraction) use qwen3:8b
# when there is room for it next to the search model; on a 16 GB machine without
# headroom they share the librarian's 4B model instead.
if (( mem_gb >= 16 )); then
  say "Soul Map: downloading its local model (qwen3:8b, 5.2 GB)"
  ollama pull qwen3:8b
else
  say "Soul Map: ${mem_gb} GB memory, skipping qwen3:8b; the librarian's 4B model will be used"
fi

fi # Soul Map

say "Turning on the public check before every commit (.githooks)"
git -C "$HERE" config core.hooksPath .githooks 2>/dev/null || true

say "Adding cl to your shell"
grep -qF "$HERE/bin" "$HOME/.zshrc" 2>/dev/null || cat >> "$HOME/.zshrc" <<EOF

# Recall
export PATH="$HERE/bin:\$PATH"
export OLLAMA_BASE_URL=$OLLAMA_BASE_URL
EOF
chmod +x "$HERE/bin/cl"

say "Done. Open a new terminal, then try:  cl note \"first thought\"  and  cl ask \"first thought\""
