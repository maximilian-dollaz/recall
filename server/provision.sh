#!/bin/bash
# Context Library — always-on server setup (Ubuntu 24.04, x86_64 or arm64, 8+ GB RAM).
# Run once as root on a fresh machine:
#   curl -fsSL <raw url of this file> | bash      (or: bash provision.sh)
# What it does: Tailscale (private network), Bun, Ollama + the two local models,
# ffmpeg/poppler/tesseract, GBrain pinned, the app as a systemd service, and a
# `library` user that owns everything. Nothing is exposed to the public internet;
# phones reach the server over Tailscale exactly as they reached the Mac.
set -euo pipefail

GBRAIN_VERSION="0.60.380.0"
REPO="${CL_REPO:-https://github.com/REPLACE_ME/context-library.git}"   # the project repo (tools, app, bin); libraries are restored separately
APP_USER=library
APP_HOME=/home/$APP_USER
APP_DIR=$APP_HOME/context-library

echo "▸ System packages"
apt-get update -q && apt-get install -y -q curl git ffmpeg poppler-utils tesseract-ocr jq unzip python3 python3-venv ca-certificates

echo "▸ Tailscale"
curl -fsSL https://tailscale.com/install.sh | sh
echo "   Join the private network (opens a login link):"
tailscale up --ssh || true

echo "▸ User"
id -u $APP_USER >/dev/null 2>&1 || useradd -m -s /bin/bash $APP_USER

echo "▸ Bun"
sudo -u $APP_USER bash -c 'curl -fsSL https://bun.sh/install | bash'
ln -sf $APP_HOME/.bun/bin/bun /usr/local/bin/bun

echo "▸ Ollama + models"
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama
sleep 3
ollama pull nomic-embed-text
ollama pull gemma3:4b

echo "▸ Project"
[ -d "$APP_DIR" ] || sudo -u $APP_USER git clone "$REPO" "$APP_DIR"
cd "$APP_DIR" && sudo -u $APP_USER bun install --silent
sudo -u $APP_USER python3 -m venv tools/.venv && sudo -u $APP_USER tools/.venv/bin/pip install -q faster-whisper

echo "▸ GBrain ${GBRAIN_VERSION}"
sudo -u $APP_USER bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"

echo "▸ Services"
cat > /etc/systemd/system/gbrain-serve.service <<EOF
[Unit]
Description=GBrain shared server
After=network-online.target ollama.service
[Service]
User=$APP_USER
Environment=OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
Environment=PATH=$APP_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$APP_DIR
ExecStart=$APP_HOME/.bun/bin/gbrain serve --http --port 3131
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/context-library.service <<EOF
[Unit]
Description=Context Library app
After=network-online.target gbrain-serve.service ollama.service
[Service]
User=$APP_USER
Environment=OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
Environment=PATH=$APP_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/bun run app/server.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now gbrain-serve context-library

cat <<'EOF'

Done. Next (from Max's Mac, see docs/server.md):
  1. Restore the libraries:  rsync the library/ and libraries/ folders, then `gbrain init` + `gbrain mcp grant` on the server.
  2. Point phones at the server's Tailscale address instead of the Mac.
EOF
