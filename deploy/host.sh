#!/bin/bash
# The site's name (PHX_HOST) from the app's settings — and nothing else from
# that file, which holds its secrets. Installed root-owned as
# /usr/local/sbin/hoodride-host (deploy/sudo_rules.sh) for
# deploy/cloudflare_check.sh, which used to grep the file as root.
set -euo pipefail
host="$(grep -E '^PHX_HOST=' /etc/hoodride/env | head -n 1 | cut -d= -f2)"
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "host: PHX_HOST missing or not a name" >&2; exit 1; }
echo "$host"
