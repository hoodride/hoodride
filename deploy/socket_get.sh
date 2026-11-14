#!/bin/bash
# Ask the app something on its Unix socket the way the tunnel does — as the
# cloudflared user, the only one the socket lets in. Installed root-owned as
# /usr/local/sbin/hoodride-socket-get (deploy/sudo_rules.sh); your account
# may run it as cloudflared, and only it: the old rule let it run curl as
# cloudflared with ANY options — reading the tunnel's key, writing its files
# (sudo review, 2026-11-13). This asks one fixed kind of question:
#
#   hoodride-socket-get PATH [HOST]           the page's body
#   hoodride-socket-get --status PATH [HOST]  only its HTTP status code
#
# PATH: /letters, digits, / _ . - only. HOST: the site's name (default
# localhost).
set -euo pipefail
SOCK=/run/hoodride/app.sock

status=0
if [ "${1:-}" = --status ]; then
  status=1
  shift
fi
path="${1:-}"
host="${2:-localhost}"
[[ "$path" =~ ^/[A-Za-z0-9/_.-]*$ ]] || { echo "socket-get: not a path: '$path'" >&2; exit 2; }
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "socket-get: not a host: '$host'" >&2; exit 2; }

if [ "$status" = 1 ]; then
  exec /usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    --unix-socket "$SOCK" -H 'x-forwarded-proto: https' "http://$host$path"
else
  exec /usr/bin/curl -s --max-time 10 \
    --unix-socket "$SOCK" -H 'x-forwarded-proto: https' "http://$host$path"
fi
