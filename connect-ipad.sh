#!/bin/zsh
# Use Recall on an iPad or iPhone: connect it privately to Recall on this Mac.
#
#   zsh ~/Recall/connect-ipad.sh        (or:  cl ipad)
#
# How it works: Tailscale (free) makes a private network between this person's own devices.
# The iPad opens Recall at this Mac's private https address, signed in as the same person,
# so it sees the same library. Nothing goes through anyone else's server, and the address
# works anywhere the iPad has internet (home, café, travelling), as long as this Mac is on.
#
# Steps it walks through: install Tailscale on this Mac (asks for the Mac's password once),
# sign in, turn on the private https address, link it to the library, then show a QR code
# for the iPad. Safe to run again; it skips what's done.
set -uo pipefail
HERE="$(cd "$(dirname "${0:A}")" && pwd)"
export PATH="$HOME/.recall/env/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
ENVF="$HERE/.env"
PEOPLE="$HERE/library/people.json"

say()  { print -P "\n%F{green}%B▸ $*%b%f"; }
note() { print "  $*"; }
fail() { print -P "\n%F{red}%B✗ $*%b%f"; exit 1; }
wait_for() { local secs=$1; shift; local i; for (( i = 0; i < secs; i += 3 )); do eval "$*" && return 0; sleep 3; done; return 1; }

curl -sf -o /dev/null http://127.0.0.1:3344/api/health || fail "Recall isn't running on this Mac. Install it first (INSTALL.md), then run this again."

# ── 1. Tailscale on this Mac ──
say "1 of 4 · Tailscale on this Mac"
if [[ ! -x "$TS" ]]; then
  note "Downloading Tailscale (about 50 MB)…"
  pkg="$(mktemp -d)/Tailscale.pkg"
  if curl -fsSL -o "$pkg" https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg; then
    note "An installer window opens. Click Continue, then Install, and type this Mac's password when asked."
    note "(That's the password used to log in to this Mac. It goes to macOS, not to Recall.)"
    open "$pkg"
  else
    note "Couldn't download it. The App Store opens instead: click Get, then Open."
    open "macappstore://apps.apple.com/app/tailscale/id1475387142"
  fi
  note "Waiting for Tailscale to be installed…"
  wait_for 900 '[[ -x "$TS" ]]' || fail "Tailscale wasn't installed. Run this again when you're ready."
fi
note "✓ Tailscale is installed"

# ── 2. Sign in ──
say "2 of 4 · Sign in to Tailscale"
state() { "$TS" status --json 2>/dev/null | jq -r '.BackendState // empty'; }
if [[ "$(state)" != Running ]]; then
  open -a Tailscale
  note "Tailscale's window or its icon (top right of the screen) asks you to log in."
  note "Sign in with the SAME Google or Apple account you'll use on the iPad"
  note "(the person whose Recall this is). If macOS asks to allow a VPN configuration, click Allow."
  "$TS" up >/dev/null 2>&1 &
  wait_for 900 '[[ "$(state)" == Running ]]' || fail "Tailscale isn't signed in yet. Sign in, then run this again."
fi
st="$("$TS" status --json)"
LOGIN="$(print -r -- "$st" | jq -r '.User[(.Self.UserID|tostring)].LoginName // empty' | tr 'A-Z' 'a-z')"
DNS="$(print -r -- "$st" | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
[[ -n "$LOGIN" && -n "$DNS" ]] || fail "Tailscale is signed in but didn't report this Mac's name. Open Tailscale, check it says Connected, then run this again."
note "✓ Signed in as $LOGIN"

# ── 3. The private https address ──
say "3 of 4 · Turning on Recall's private address"
URL="https://$DNS"
if ! curl -sf -o /dev/null --max-time 10 "$URL/api/health"; then
  out="$(mktemp)"
  "$TS" serve --bg 3344 >"$out" 2>&1 &
  spid=$!; opened=""
  for i in {1..200}; do
    link="$(grep -Eo 'https://login\.tailscale\.com/[^ ]+' "$out" | head -1)"
    if [[ -n "$link" && -z "$opened" ]]; then
      note "Tailscale needs one click to allow private https addresses. A page opens: click Enable."
      open "$link"; opened=1
    fi
    kill -0 $spid 2>/dev/null || break
    sleep 3
  done
  kill $spid 2>/dev/null
  # The first visit makes the address's security certificate; give it a moment.
  wait_for 90 'curl -sf -o /dev/null --max-time 10 "$URL/api/health"' \
    || { cat "$out"; fail "The private address didn't answer. Run this again; if it repeats, send the lines above to whoever set up Recall."; }
fi
note "✓ $URL"

# ── 4. Link it to this library ──
say "4 of 4 · Linking it to this Mac's library"
# Recall knows the iPad by its Tailscale sign-in. Make that sign-in open this Mac's library (not a new, empty one).
set_env() { grep -q "^$1=" "$ENVF" && sed -i '' "s#^$1=.*#$1=$2#" "$ENVF" || echo "$1=$2" >> "$ENVF"; }
launchctl bootout "gui/$(id -u)/com.contextlibrary.app" 2>/dev/null
for i in {1..20}; do launchctl print "gui/$(id -u)/com.contextlibrary.app" >/dev/null 2>&1 || break; sleep 0.5; done
if [[ -f "$PEOPLE" ]]; then
  owner="$(jq -r .owner "$PEOPLE")"
  if [[ "$owner" != "$LOGIN" ]]; then
    tmp="$(mktemp)"
    jq --arg l "$LOGIN" '.people[$l] = ((.people[$l] // {}) + {id: .people[.owner].id, name: .people[.owner].name, alias_of: .owner})' "$PEOPLE" > "$tmp" && mv "$tmp" "$PEOPLE"
  fi
else
  set_env RECALL_OWNER_EMAIL "$LOGIN"   # nothing saved yet: this sign-in simply becomes the owner
fi
set_env CL_HTTPS_HOST "$DNS"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.contextlibrary.app.plist" 2>/dev/null \
  || launchctl kickstart -k "gui/$(id -u)/com.contextlibrary.app"
wait_for 60 'curl -sf -o /dev/null http://127.0.0.1:3344/api/health' || fail "Recall didn't restart. See ~/.gbrain/serve/app.err"
note "✓ Linked"

# The QR code as a picture too, opened on screen (handy when an AI ran this and the terminal isn't visible).
QR="$HERE/iPad-QR.svg"
"$HERE/tools/.venv/bin/python" -c "import qrcode, qrcode.image.svg, sys; qrcode.make(sys.argv[1], image_factory=qrcode.image.svg.SvgPathFillImage, box_size=20).save(sys.argv[2])" "$URL" "$QR" 2>/dev/null \
  && open -a Safari "$QR" 2>/dev/null

print -P "\n%F{green}%B✓ This Mac is ready for the iPad.%b%f"
print "  Address for the iPad: $URL"
cat <<EOF

  On the iPad (or iPhone):
   1. Open the App Store, search Tailscale, tap Get, then open it.
   2. Sign in with the same account: $LOGIN
      Tap Allow when it asks to add a VPN configuration.
   3. Point the iPad's camera at this code and tap the link (or type the address in Safari):

EOF
"$HERE/tools/.venv/bin/python" -c "import qrcode,sys; q=qrcode.QRCode(border=2); q.add_data(sys.argv[1]); q.print_ascii(invert=True)" "$URL" 2>/dev/null \
  || note "(QR code unavailable)"
cat <<EOF

        $URL

   4. In Safari, tap the Share button (the square with an arrow), then Add to Home Screen.
      Recall is now an app on the iPad.

  The iPad reaches Recall whenever this Mac is on and awake. To keep it reachable,
  leave the Mac plugged in: System Settings → Battery → Options → "Prevent automatic sleeping
  on power adapter when the display is off".
EOF
