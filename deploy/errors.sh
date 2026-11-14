#!/usr/bin/env bash
# What went wrong lately, from the live server's log — grouped, most
# frequent first (owner, 2026-11-10):
#   client error: …         the app's error reports (WHAT broke, never who)
#   repair: …               the sweeper fixed something that should never be
#   sweep step … failed     a clean-up step crashed (the rest still ran)
# Run from this machine:
#   deploy/errors.sh                  the last 24 hours
#   deploy/errors.sh "2 hours ago"    any journalctl --since
# Exit: 0 nothing went wrong · 1 something did (listed) · 2 the log couldn't
# be read (never "nothing went wrong" when it simply couldn't look).
# One SSH login (the server allows 6 per 30 s).
set -uo pipefail

SINCE="${1:-24 hours ago}"
# the SSH key: HOODRIDE_KEY=path, else ssh's own choice (~/.ssh/config)
HOST="${HOODRIDE_HOST:-hood@72.14.182.98}"
key=()
if [ -n "${HOODRIDE_KEY:-}" ]; then key=(-i "$HOODRIDE_KEY"); fi

# (quoted for the remote shell: a ' in it can't run anything there)
since_q=$(printf '%q' "$SINCE")
# shellcheck disable=SC2029 # expanded here on purpose, quoted for there
# read as a member of systemd-journal (deploy/sudo_rules.sh), no sudo. Not a
# member: journalctl would show NOTHING and this would say "nothing went
# wrong" — so that's a failure too
if ! log=$(ssh ${key[@]+"${key[@]}"} "$HOST" "id -nG | grep -qw systemd-journal && journalctl -u hoodride --since $since_q -o cat --no-pager"); then
  echo "FAIL: couldn't read the server's log (ssh refused, or not in systemd-journal: deploy/sudo_rules.sh) — nothing checked"
  exit 2
fi

found=$(printf '%s\n' "$log" |
  grep -E 'client error:|repair: |sweep step .* failed|sign-in: ' |
  sed -E 's/^.*\[(warning|error)\] //; s/ build=[0-9a-f]+//' |
  sort | uniq -c | sort -rn | head -50)

if [ -z "$found" ]; then
  echo "nothing went wrong since $SINCE"
  exit 0
fi

echo "since $SINCE (count, what):"
echo "$found"
exit 1
