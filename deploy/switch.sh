#!/bin/bash
# Switch the live app to a built release — or, if it fails, put everything
# back as it was: the database AND the code (owner, 2026-11-11). Run by
# deploy.sh as your own user (it uses sudo for each step):
#
#   deploy/switch.sh /opt/hoodride/releases/YYYYMMDD-HHMMSS
#
# Exit 0: the new release is live and answers. Exit 1: it isn't — the
# previous release is back on the database as it was, or (if the database
# couldn't be put back) the app is left STOPPED: down beats wrong (the old
# version on a half-restored or empty database looks healthy, no accounts).
#
# Why (reproduced 2026-11-11): database changes run when a version starts.
# A new version that changed the database and then failed was switched back
# from, its changes kept: the old version failed every sign-in — and passed
# the check. Now the database is copied (app stopped: exact) before the new
# version starts, and put back if it fails.
#
# From the switch on, ANY way out short of "healthy" — the start failing,
# the check failing, a dropped connection or Ctrl-C — rolls back, and the
# rollback itself can't be cut off. Before the switch, the running version
# simply starts again. What it says is also kept in $LOG
# (/var/tmp/hoodride-deploy.log): a dropped connection's deploy is read there.
#
# (Every outside command can be replaced, for the tests:
#  HOODRIDE_APP, HOODRIDE_SYSTEMCTL, HOODRIDE_DBCOPY, HOODRIDE_HEALTHY,
#  HOODRIDE_CURRENT_FILE.)
set -euo pipefail

NEW="${1:?usage: switch.sh RELEASE_DIR}"
APP="${HOODRIDE_APP:-/opt/hoodride}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SYSTEMCTL=(sudo /usr/bin/systemctl)
# (root-owned copies the server's sudo rules name exactly — sudo_rules.sh;
# never a file in your own folder: editable, it would run anything as root)
DBCOPY=(sudo /usr/local/sbin/hoodride-db-copy)
# (the tests' stand-ins: one program each, no arguments of their own)
if [ -n "${HOODRIDE_SYSTEMCTL:-}" ]; then SYSTEMCTL=("$HOODRIDE_SYSTEMCTL"); fi
if [ -n "${HOODRIDE_DBCOPY:-}" ]; then DBCOPY=("$HOODRIDE_DBCOPY"); fi
TAG="$(basename "$NEW")"
LOG="${HOODRIDE_DEPLOY_LOG:-/var/tmp/hoodride-deploy.log}"
# a log it can't write (another user's file, a read-only disk) must never
# block anything — least of all putting the database back: none then
: >> "$LOG" 2>/dev/null || LOG=/dev/null

# output gone (a dropped ssh connection) must never kill this half-way:
# writing to it then just fails. Everything said also goes to $LOG
trap '' PIPE
say() {
  echo "$*" >> "$LOG" 2>/dev/null || true
  echo "$*" 2>/dev/null || true
}

# "current": the symlink to the live release. (Tests on a machine without
# symlinks set HOODRIDE_CURRENT_FILE=1: a plain file holding the path.)
point_at() {
  if [ -n "${HOODRIDE_CURRENT_FILE:-}" ]; then printf '%s' "$1" > "$APP/current"; else ln -sfn "$1" "$APP/current"; fi
}
current() {
  if [ -n "${HOODRIDE_CURRENT_FILE:-}" ]; then cat "$APP/current" 2>/dev/null || true; else readlink -f "$APP/current" 2>/dev/null || true; fi
}
PREV="$(current)"

# as cloudflared: the same user, group and socket the tunnel uses
healthy() {
  if [ -n "${HOODRIDE_HEALTHY:-}" ]; then
    bash -c "$HOODRIDE_HEALTHY"
    return
  fi
  for _ in $(seq 1 30); do
    code="$(sudo -u cloudflared /usr/local/sbin/hoodride-socket-get --status /api/me || true)"
    [ "$code" = 200 ] && return 0
    sleep 1
  done
  return 1
}

# the new version failed (or the deploy was cut off after the switch): its
# database changes undone FIRST — the old version can't read a newer
# version's database (it refuses to start on one: Hoodride.SchemaCheck)
rollback() {
  trap - EXIT
  # nothing stops it half-way now: not a hang-up, Ctrl-C, or output gone
  # (a dropped ssh connection sends the first and does the last)
  trap '' HUP INT TERM
  set +e
  say "the new release isn't live — see: journalctl -u hoodride -n 50"
  # not stopped: nothing put back — renaming files under a running app's
  # open database would corrupt it. Left as it is (the new release)
  if ! "${SYSTEMCTL[@]}" stop hoodride; then
    say "couldn't stop the app — the database NOT put back (the new release is still running). The copy: /var/lib/hoodride-copies/$TAG"
    exit 1
  fi
  if ! "${DBCOPY[@]}" restore "$TAG" >> "$LOG" 2>&1; then
    say "couldn't put the database back — the app is left STOPPED. The copy: /var/lib/hoodride-copies/$TAG"
    exit 1
  fi
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    point_at "$PREV"
    "${SYSTEMCTL[@]}" start hoodride
    if healthy; then say "switched back: $PREV"; else say "the previous release doesn't answer either"; fi
  fi
  exit 1
}

# cut off before the switch: the running version (still "current") starts
# again. Set before the stop: no moment stopped without it (starting a
# running app does nothing)
trap '"${SYSTEMCTL[@]}" start hoodride' EXIT
"${SYSTEMCTL[@]}" stop hoodride
if ! "${DBCOPY[@]}" snapshot "$TAG"; then
  say "couldn't copy the database — nothing switched; the running version starts again"
  exit 1
fi

# from here, anything but "healthy" rolls back
trap rollback EXIT
point_at "$NEW"
# (its start failing: out at once — the rollback above runs)
"${SYSTEMCTL[@]}" start hoodride
if healthy; then
  trap - EXIT
  say "live: $NEW"
  exit 0
fi
rollback
