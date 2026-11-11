#!/usr/bin/env bash
# After every deploy (owner, 2026-11-10): is the live site well?
#   - the home page answers, and names the build it is
#   - the app's own files are served (app.js, errors.js)
#   - sign-in answers (/api/me: 200 signed in, 401 not — never a 5xx)
#   - nothing went wrong in the last few minutes (deploy/errors.sh)
# Prints each check; exits non-zero if one fails.
set -uo pipefail

SITE="${HOODRIDE_SITE:-https://hoodride.app}"
SINCE="${1:-10 minutes ago}"
fail=0

ok() { echo "  ok   $1"; }
bad() {
  echo "  FAIL $1"
  fail=1
}

echo "checking $SITE"

page=$(mktemp)
home=$(curl -s -o "$page" -w '%{http_code}' "$SITE/")
if [ "$home" = "200" ]; then ok "home page: 200"; else bad "home page: $home"; fi

build=$(grep -oE 'name="hoodride-build" content="[0-9a-f]+"' "$page" | grep -oE '[0-9a-f]{8,}' || true)
if [ -n "$build" ]; then ok "build: $build"; else bad "no build stamped on the page"; fi
rm -f "$page"

for f in app.js errors.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/$f")
  if [ "$code" = "200" ]; then ok "$f: 200"; else bad "$f: $code"; fi
done

me=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/me")
case "$me" in
  200 | 401) ok "sign-in answers: $me" ;;
  *) bad "sign-in: $me" ;;
esac

echo "what went wrong since $SINCE:"
report=$("$(dirname "$0")/errors.sh" "$SINCE")
status=$?
printf '%s\n' "$report" | sed 's/^/  /'
case $status in
  0) ok "nothing went wrong" ;;
  1) bad "something went wrong (above)" ;;
  *) bad "couldn't read the server's log" ;;
esac

exit $fail
