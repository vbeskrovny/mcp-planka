#!/usr/bin/env bash
# Migrate an old mcp-planka config to the current .env format, where every setting is named
# MCP_APP_PLANKA_<name> (MCP_APP_PLANKA_URL, MCP_APP_PLANKA_API_KEY, ...). Old formats:
#   - .planka with URL= / KEY= / MANAGERS= / INSTRUCTIONS= / FILES_DIR=
#   - .env with PLANKA_<name>= (PLANKA_URL, PLANKA_API_KEY, PLANKA_STATE_DIR, ...)
#
# Usage: scripts/migrate-config.sh [--no-bare] SRC DEST
#   SRC == DEST   rename the keys in place (e.g. a custom --config file)
#   SRC != DEST   write the keys into DEST (merged into an existing DEST), then delete SRC
#   --no-bare     only convert PLANKA_<name> keys, not bare URL= / KEY= ... Use it for a .env shared with other
#                 apps, where bare keys may belong to someone else.
#
# Never prints values. DEST is written atomically with mode 600. SRC is deleted only after DEST was
# verified to hold every setting SRC had. A key already set in DEST to a different value is a conflict:
# nothing is changed and the script fails.
# Exit codes: 0 migrated, 3 nothing to migrate, 1 error.
set -euo pipefail

die() { echo "migrate-config: $*" >&2; exit 1; }
BARE=1
if [[ "${1:-}" == "--no-bare" ]]; then BARE=0; shift; fi
[[ $# -eq 2 ]] || die "usage: migrate-config.sh [--no-bare] SRC DEST"
SRC="$1"; DEST="$2"
[[ -f "$SRC" ]] || die "not found: $SRC"

P=MCP_APP_PLANKA_
declare -A NEW=()
if [[ $BARE -eq 1 ]]; then
  NEW=([URL]=${P}URL [KEY]=${P}API_KEY [MANAGERS]=${P}MANAGERS [INSTRUCTIONS]=${P}INSTRUCTIONS [FILES_DIR]=${P}FILES_DIR)
fi
for k in URL API_KEY MANAGERS INSTRUCTIONS FILES_DIR STATE_DIR BACKLOG_PATTERN START_LABEL WATCH_INTERVAL; do
  NEW[PLANKA_$k]="$P$k"
done

# key_of LINE -> prints the key of a KEY=VALUE line (empty for comments / blank / other lines)
key_of() {
  local line="${1%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]] && echo "${BASH_REMATCH[1]}" || true
}
# value_of FILE KEY -> the value of KEY in FILE, trimmed (last one wins), without printing it anywhere else
value_of() {
  local line k v=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    k="$(key_of "$line")"
    if [[ "$k" == "$2" ]]; then
      v="${line#*=}"
      v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    fi
  done < "$1"
  printf '%s' "$v"
}

same=0; [[ "$(realpath -m "$SRC")" == "$(realpath -m "$DEST")" ]] && same=1

# Rewrite SRC with prefixed keys (comments, blank lines and other keys are kept, CRLF becomes LF).
converted="$(mktemp)"; trap 'rm -f "$converted" "${out:-}"' EXIT
changed=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  k="$(key_of "$line")"
  if [[ -n "$k" && -n "${NEW[$k]:-}" ]]; then
    v="${line#*=}"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    line="${NEW[$k]}=$v"
    changed=1
  fi
  printf '%s\n' "$line" >> "$converted"
done < "$SRC"

if [[ $same -eq 1 && $changed -eq 0 ]]; then
  echo "migrate-config: nothing to migrate in $SRC"; exit 3
fi

# Build the result: in place -> the converted file; otherwise DEST + converted lines whose key DEST lacks.
umask 077
out="$(mktemp "$(dirname "$DEST")/.migrate.XXXXXX")"
if [[ $same -eq 1 || ! -f "$DEST" ]]; then
  cat "$converted" > "$out"
else
  tr -d '\r' < "$DEST" > "$out"
  [[ -z "$(tail -c1 "$out")" ]] || echo >> "$out"
  added=0
  while IFS= read -r line; do
    k="$(key_of "$line")"
    [[ -n "$k" ]] || continue
    if grep -qE "^[[:space:]]*${k}[[:space:]]*=" "$out"; then
      [[ "$(value_of "$out" "$k")" == "$(value_of "$converted" "$k")" ]] || die "$k is set to a different value in $DEST and $SRC; nothing changed, fix one by hand"
    else
      [[ $added -eq 1 ]] || echo "# mcp-planka (migrated from $(basename "$SRC"))" >> "$out"
      printf '%s\n' "$line" >> "$out"; added=1
    fi
  done < "$converted"
fi

# Verify before replacing anything: every setting SRC had must be in the result with the same value.
for k in $(while IFS= read -r l; do key_of "$l"; done < "$converted" | sort -u); do
  grep -qE "^[[:space:]]*${k}[[:space:]]*=" "$out" || die "verification failed: $k missing; nothing changed"
  [[ "$(value_of "$out" "$k")" == "$(value_of "$converted" "$k")" ]] || die "verification failed: $k differs; nothing changed"
done

chmod 600 "$out"
mv -f "$out" "$DEST"; out=""
if [[ $same -eq 1 ]]; then
  echo "migrate-config: renamed keys in $DEST to the MCP_APP_PLANKA_ names"
else
  rm -f "$SRC"
  echo "migrate-config: moved $SRC to $DEST (MCP_APP_PLANKA_ keys, mode 600) and deleted $SRC"
fi
