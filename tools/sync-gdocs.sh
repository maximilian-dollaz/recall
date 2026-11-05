#!/bin/zsh
# Pull Google Docs (only Docs, only ones you own) from a Drive account into
# the library's imports folder, as Word files. Runs locally through rclone.
#
#   tools/sync-gdocs.sh <rclone-remote> <label>
#   e.g. tools/sync-gdocs.sh gd-main main
#
# Re-running picks up new and changed docs; unchanged ones are skipped.
set -euo pipefail
remote="${1:?rclone remote name}"
label="${2:?short label for the folder}"
HERE="$(cd "$(dirname "${0:A}")/.." && pwd)"
dest="$HERE/imports/$label"
mkdir -p "$dest"

# Ask Drive for exactly: Google Docs, owned by me, not in the trash.
q="mimeType='application/vnd.google-apps.document' and 'me' in owners and trashed=false"
list=$(rclone backend query "$remote:" "$q" 2>/dev/null)
total=$(print -r -- "$list" | jq 'length')
echo "$label: $total docs found"

# Docs that share a title get the tail of their ID appended so none overwrite another.
print -r -- "$list" | jq -r '
  (group_by(.name) | map(select(length > 1) | .[0].name)) as $dupes
  | .[] | . as $d | [$d.id, $d.name, $d.modifiedTime, (if ($dupes | index($d.name)) then "dupe" else "" end)] | @tsv' \
| while IFS=$'\t' read -r id name mtime dupe; do
  safe=$(print -r -- "$name" | tr '/' '-' | cut -c1-120)
  [[ "$dupe" == "dupe" ]] && safe="$safe [${id[-6,-1]}]"
  out="$dest/$safe.docx"
  # Skip if we already have this doc and it hasn't changed since.
  stamp="$dest/.stamps/$id"
  if [[ -f "$out" && -f "$stamp" && "$(cat "$stamp")" == "$mtime" ]]; then continue; fi
  mkdir -p "$dest/.stamps"
  if rclone backend copyid "$remote:" "$id" "$out" --drive-export-formats docx -q 2>/dev/null; then
    print -r -- "$mtime" > "$stamp"
    echo "  + $safe"
  else
    echo "  ! failed: $safe" >&2
  fi
done
echo "$label: done -> $dest"
