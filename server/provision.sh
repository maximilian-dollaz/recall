#!/bin/bash
# Recall (and the Soul Map behind it) on a Linux server. Ubuntu 24.04, 4 GB of memory or more.
# Run once as root on a fresh machine:
#   RECALL_HOST=recall.example.com RECALL_USER=me RECALL_HOME=/home/me bash provision.sh
#
# Moving from a Mac: set RECALL_HOME to the Mac's home folder (e.g. /Users/<name>) and RECALL_CODE /
# SOUL_CODE to the same folders as on the Mac. The library engine (GBrain) stores absolute paths, so
# matching them means the libraries copy over as they are. server/migrate.sh does the copy.
#
# What it sets up: Caddy (https for RECALL_HOST, straight to Recall's public door, uploads up to 2 GB),
# a firewall that lets in only ssh and the web, Bun + GBrain (pinned), Node for the Soul Map, uv for its
# Python, Ollama with the small search model only (sorting uses Claude), and systemd services that start
# once the data is in place.
set -euo pipefail

HOST="${RECALL_HOST:?set RECALL_HOST to the web address, e.g. recall.example.com}"
U="${RECALL_USER:-recall}"
H="${RECALL_HOME:-/home/$U}"
CODE="${RECALL_CODE:-$H/recall}"
SOUL="${SOUL_CODE:-$H/soul-map}"
GBRAIN_VERSION="0.60.380.0"
say() { printf '\n▸ %s\n' "$*"; }

say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git zsh ffmpeg poppler-utils libvips-tools libheif1 libheif-plugin-libde265 \
  build-essential python3-dev jq unzip zip rsync python3 python3-venv ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

say "Swap (the Soul Map build needs room on a 4 GB machine)"
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

say "Firewall: ssh and the web only"
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	encode gzip
	request_body {
		max_size 2GB
	}
	reverse_proxy 127.0.0.1:3346 {
		flush_interval -1
	}
}
EOF

say "cloudflared (lets the server join an existing Cloudflare tunnel, for a handover with no downtime)"
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb" && dpkg -i /tmp/cloudflared.deb
fi

say "Node 22 (the Soul Map)"
if ! node -v 2>/dev/null | grep -q '^v22'; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -q nodejs; fi

say "User $U ($H)"
mkdir -p "$(dirname "$H")"
id -u "$U" >/dev/null 2>&1 || useradd -m -d "$H" -s /bin/bash "$U"
as() { sudo -u "$U" -H bash -lc "$*"; }
# The same ssh keys as root, so the Mac can copy straight into this user's folders.
install -d -m 700 -o "$U" -g "$U" "$H/.ssh" && install -m 600 -o "$U" -g "$U" /root/.ssh/authorized_keys "$H/.ssh/authorized_keys"

say "Bun, GBrain $GBRAIN_VERSION, uv"
as 'command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
as "~/.bun/bin/bun install -g 'github:garrytan/gbrain#v$GBRAIN_VERSION'"
as 'command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh'
ln -sf "$H/.bun/bin/bun" /usr/local/bin/bun

say "Ollama with the search model only"
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama
sleep 3; ollama pull nomic-embed-text

say "Services (they start once migrate.sh has copied the data)"
ENVLINE="Environment=PATH=$H/.bun/bin:$H/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$H
Environment=OLLAMA_BASE_URL=http://127.0.0.1:11434/v1"
cat > /etc/systemd/system/gbrain-serve.service <<EOF
[Unit]
Description=GBrain, the library engine
After=network-online.target ollama.service
[Service]
User=$U
$ENVLINE
ExecStart=/bin/bash $H/.gbrain/serve/gbrain-serve.sh
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/recall.service <<EOF
[Unit]
Description=Recall
After=network-online.target gbrain-serve.service
[Service]
User=$U
$ENVLINE
WorkingDirectory=$CODE
ExecStart=$H/.bun/bin/bun run app/server.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/soulmap.service <<EOF
[Unit]
Description=The Soul Map (behind Recall at /soul)
After=network-online.target
[Service]
User=$U
$ENVLINE
Environment=NODE_ENV=production
WorkingDirectory=$SOUL/app
ExecStart=/usr/bin/npm run start -- -H 127.0.0.1 -p 3355
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/soulmap-sync.service <<EOF
[Unit]
Description=The Soul Map nightly evidence sync
[Service]
Type=oneshot
User=$U
$ENVLINE
WorkingDirectory=$CODE
ExecStart=$CODE/bin/cl soul sync
EOF
cat > /etc/systemd/system/soulmap-sync.timer <<EOF
[Unit]
Description=The Soul Map nightly evidence sync, 03:30
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/recall-tunnel.service <<EOF
[Unit]
Description=Cloudflare tunnel (only while moving from a Mac; migrate.sh copies its config)
After=network-online.target recall.service
ConditionPathExists=$H/.cloudflared/recall.yml
[Service]
User=$U
ExecStart=$(command -v cloudflared) --no-autoupdate tunnel --config $H/.cloudflared/recall.yml run
Restart=always
RestartSec=5
EOF
systemctl daemon-reload
systemctl enable gbrain-serve recall soulmap soulmap-sync.timer caddy

say "Done. Next, from the Mac: server/migrate.sh <user>@<this server's address>"
