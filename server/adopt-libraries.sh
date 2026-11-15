#!/bin/bash
# After migrate.sh copies the libraries to a server at the same paths, GBrain refuses to write
# (recovery_required): the folders are new on disk, so their identity no longer matches.
# This runs GBrain's documented exit for exactly that case on every library: a self-transfer that
# confirms the relocated root (prepare, then accept, each bound to a freshly reviewed admin_state).
# Run on the server as the library user, with gbrain-serve and recall stopped:
#   bash server/adopt-libraries.sh [source ...]     (default: every source whose folder exists)
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"; set -a; [ -f ~/.gbrain/env ] && . ~/.gbrain/env; set +a; cd ~
status() { gbrain sources writer status --brain host --json 2>/dev/null; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

if [ $# -eq 0 ]; then
  set -- $(status | field "' '.join(s['source_id'] for s in d['onboarding']['sources'] if s.get('state')=='recovery_required')")
fi
binding() { status | field "' '.join(next((b['state'], b['owner_epoch'], b.get('manifest_digest') or '-', b['local_path'].replace(' ', '%20')) for b in d['bindings'] if b['source_id']=='$1'))"; }
for src in "$@"; do
  read -r state epoch digest path < <(binding "$src")
  if [ "$state" != "draining" ]; then
    fp=$(status | field "d['admin_state']")
    prep=$(gbrain sources writer transfer prepare "$src" --brain host --self-transfer --confirm-relocated-root \
      --admin-intent writer_transfer_prepare --expected-state "$fp" --json 2>&1) || { echo "$src: prepare refused: $(echo "$prep" | head -3 | tr '\n' ' ')"; continue; }
    read -r state epoch digest path < <(binding "$src")   # the prepared epoch and manifest, as the fresh status records them
  fi
  path="${path//%20/ }"
  fp=$(status | field "d['admin_state']")
  if [ ! -d "$path" ]; then
    echo "$src: $path is not on this server; handing it back"
    gbrain sources writer transfer cancel "$src" --brain host --expected-epoch "$epoch" --admin-intent writer_transfer_cancel --expected-state "$fp" --json >/dev/null 2>&1 || true
    continue
  fi
  acc=$(gbrain sources writer transfer accept "$src" --brain host --self-transfer --confirm-relocated-root --path "$path" \
    --expected-epoch "$epoch" --manifest "$digest" --admin-intent writer_transfer_accept --expected-state "$fp" --json 2>&1) \
    && echo "$src: adopted ($path)" || echo "$src: accept refused: $(echo "$acc" | head -4 | tr '\n' ' ')"
done
