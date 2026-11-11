#!/bin/bash
# The database's copy for each deploy (owner, 2026-11-11). Run by deploy.sh
# (as root, the app STOPPED — nothing writing, so a plain copy is exact):
#
#   db_copy.sh snapshot TAG   copy the database before the new version starts
#   db_copy.sh restore TAG    put that copy back (the new version failed:
#                             its database changes undone, the old version
#                             finds the database exactly as it left it)
#   db_copy.sh prune N        keep the newest N copies
#
# Why (reproduced 2026-11-11): database changes run when a version starts;
# a new version that changed the database and then failed was switched back
# FROM, but its changes stayed — the old version failed every sign-in.
#
# TAG is the release's name (YYYYMMDD-HHMMSS). A copy is used only if it
# finished (its "complete" list): a half-made copy is never put back. The
# -shm file is the database's scratch index, rebuilt on open: never copied.
set -euo pipefail

DIR="${HOODRIDE_DB_DIR:-/var/lib/hoodride}"
COPIES="${HOODRIDE_DB_COPIES:-/var/lib/hoodride-copies}"
DB=hoodride.db
FILES=("$DB" "$DB-wal")

fail() { echo "db_copy: $*" >&2; exit 1; }

tag_ok() { [[ "${1:-}" =~ ^[0-9]{8}-[0-9]{6}$ ]] || fail "not a release name: '${1:-}'"; }

# the app's own user owns its files (as root, where that user exists — a
# test machine has none; cp -p as root keeps the copy's owner anyway)
own() { if [ "$(id -u)" = 0 ] && id hoodride >/dev/null 2>&1; then chown hoodride:hoodride "$@"; fi; }

snapshot() {
  tag_ok "$1"
  local to="$COPIES/$1"
  # room for it, and as much again to spare — else refused before writing
  # anything (a full disk breaks the running app's every write)
  local need=0 free
  for f in "${FILES[@]}"; do
    if [ -e "$DIR/$f" ]; then need=$((need + $(stat -c %s "$DIR/$f"))); fi
  done
  free="${HOODRIDE_DB_FREE_BYTES:-$(df --output=avail -B1 "$(dirname "$COPIES")" | tail -1 | tr -d ' ')}"
  [ "$free" -ge $((2 * need)) ] || fail "not enough free disk for the copy: $need bytes, and as much again to spare — $free free"
  rm -rf "$to"
  mkdir -p "$to"
  chmod 700 "$COPIES" "$to"
  # failing half-way: its half removed (copies of failed deploys are never
  # pruned — they'd pile up on the disk)
  # (its path written into the cleanup now: a failed step exits after this
  # function is gone, its variables with it)
  trap "rm -rf $(printf '%q' "$to")" EXIT
  local copied=()
  for f in "${FILES[@]}"; do
    if [ -e "$DIR/$f" ]; then
      cp -p "$DIR/$f" "$to/$f"
      cmp -s "$DIR/$f" "$to/$f" || fail "the copy of $f differs from it"
      copied+=("$f")
    fi
  done
  # (none on the very first deploy: putting it back = no database again)
  printf '%s\n' "${copied[@]+"${copied[@]}"}" > "$to/complete"
  trap - EXIT
  echo "database copied: $to (${#copied[@]} file(s))" 2>/dev/null || true
}

restore() {
  tag_ok "$1"
  local from="$COPIES/$1"
  [ -f "$from/complete" ] || fail "no finished copy for $1 — nothing put back"
  # every file staged next to the live ones and checked FIRST; only then the
  # live ones replaced (renames: instant). Failing before that — a full
  # disk, a missing file — leaves the live database exactly as it was
  # (a global, not local: the cleanup can run after this function is gone)
  STAGED=()
  trap 'rm -f "${STAGED[@]/#/$DIR/.restoring-}"' EXIT
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    STAGED+=("$f")
    cp -p "$from/$f" "$DIR/.restoring-$f" || fail "couldn't copy $f back — the database untouched"
    cmp -s "$from/$f" "$DIR/.restoring-$f" || fail "$f copied back differs — the database untouched"
    own "$DIR/.restoring-$f"
  done < "$from/complete"
  # then: the scratch index and any live file the copy doesn't have (its
  # -wal) go; each copy is RENAMED over its live file — never deleted
  # first: no moment without a database (a crash then, and the next start
  # would make an empty one)
  # (not to be cut off between the renames: a Ctrl-C now waits)
  trap '' INT TERM HUP
  rm -f "$DIR/$DB-shm"
  for f in "${FILES[@]}"; do
    [[ " ${STAGED[*]+"${STAGED[*]}"} " == *" $f "* ]] || rm -f "$DIR/$f"
  done
  for f in "${STAGED[@]+"${STAGED[@]}"}"; do mv -f "$DIR/.restoring-$f" "$DIR/$f"; done
  STAGED=()
  trap - EXIT
  echo "database put back as it was before $1" 2>/dev/null || true
}

prune() {
  local keep="${1:-}"
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || fail "keep how many? '$keep'"
  [ -d "$COPIES" ] || return 0
  ls -1 "$COPIES" | grep -E '^[0-9]{8}-[0-9]{6}$' | sort | head -n -"$keep" | while read -r old; do
    rm -rf "${COPIES:?}/$old"
  done
}

case "${1:-}" in
  snapshot) snapshot "${2:-}" ;;
  restore) restore "${2:-}" ;;
  prune) prune "${2:-}" ;;
  *) fail "usage: db_copy.sh snapshot|restore TAG · prune N" ;;
esac
