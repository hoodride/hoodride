#!/bin/bash
# What does Cloudflare ADD to our pages on the way out? (run by deploy.sh;
# also by hand: deploy/cloudflare_check.sh)
#
# Compares each page as the app sends it (its Unix socket, as cloudflared
# reaches it) with the page as visitors get it (https://$PHX_HOST), and
# lists every script, stylesheet or inline block only Cloudflare's copy
# has. Anything not in cloudflare_expected.txt is a WARNING: the CSP
# blocks what it doesn't list, so a new Cloudflare feature (analytics,
# email scrambling, …) would silently fail — or, if allowed, change what
# the privacy policy has to say. This replaced CSP violation reports
# (owner, 2026-10-29), whose one real catch was exactly that.
# Never fails the deploy: it warns.
set -uo pipefail
SOCK=/run/hoodride/app.sock
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="$(sudo -n grep -E '^PHX_HOST=' /etc/hoodride/env 2>/dev/null | cut -d= -f2)"
[ -n "$HOST" ] || { echo "cloudflare check: no PHX_HOST — skipped"; exit 0; }
UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'

# every external script/stylesheet and every inline <script>/<style>, one
# per line — by site + file name, not the full address: Cloudflare's carry
# version codes that change with its releases (beacon.min.js/vce7…,
# /cdn-cgi/scripts/5c5dd728/…), which would warn for nothing
parts() {
  grep -oiE '<script[^>]*>|<link[^>]*rel="?stylesheet[^>]*>|<style[^>]*>' |
    sed -E 's/.*(src|href)="([^"?]*)[^"]*".*/\2/I; s/^<(script|style)[^>]*>$/inline \1/I' |
    sed -E 's#^https?://([^/]+)/([^/]+).*#\1/\2#; s#^/cdn-cgi/.*/([^/]+)$#/cdn-cgi/…/\1#' |
    sort -u
}

new=0
for page in / /privacy; do
  ours="$(sudo -n -u cloudflared /usr/bin/curl -s --max-time 10 --unix-socket "$SOCK" \
    -H 'x-forwarded-proto: https' "http://$HOST$page" | parts)"
  theirs="$(curl -s --compressed --max-time 15 -A "$UA" -H 'Accept: text/html' \
    -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' "https://$HOST$page" | parts)"
  added="$(comm -13 <(echo "$ours") <(echo "$theirs"))"
  while IFS= read -r a; do
    [ -z "$a" ] && continue
    if grep -qxF "$page $a" "$HERE/cloudflare_expected.txt" 2>/dev/null; then
      echo "cloudflare check: $page + $a (known)"
    else
      echo "cloudflare check: WARNING — $page + $a is NEW (Cloudflare adds it; the CSP may block it — see HoodrideWeb.CSP)"
      new=1
    fi
  done <<<"$added"
done
[ "$new" = 0 ] && echo "cloudflare check: nothing new added by Cloudflare"
exit 0
