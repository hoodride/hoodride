#!/bin/bash
# Build and switch to a new release (run from the project, as your own user,
# after `git pull`):
#
#   deploy/deploy.sh
#
# Builds next to the running one, switches /opt/hoodride/current, restarts,
# and checks the app answers on its socket the way cloudflared reaches it —
# if not, switches back and restarts the previous one. Keeps the last 3.
set -euo pipefail
APP=/opt/hoodride
SOCK=/run/hoodride/app.sock
. "$HOME/beam/env.sh"   # Erlang + Elixir (deploy/install_beam.sh)
cd "$(dirname "$0")/.."

NEW="$APP/releases/$(date -u +%Y%m%d-%H%M%S)"
export MIX_ENV=prod
mix deps.get --only prod
mix release --overwrite --path "$NEW"
# the cookie is RELEASE_COOKIE in /etc/hoodride/env; this copy anyone could read
rm -f "$NEW/releases/COOKIE"
# our own JS minified in the RELEASE only (the source here stays readable):
# esbuild, settings in config :esbuild — Mix.Tasks.Hoodride.Minify. Before
# the switch: a failure stops here, the running release untouched. The
# esbuild program is kept in ~/.cache/hoodride between deploys (this folder
# may be a fresh copy): no download unless the configured version changed
STATIC="$(ls -d "$NEW"/lib/hoodride-*/priv/static)"
mix hoodride.minify --in-place "$STATIC" --keep "$HOME/.cache/hoodride"

PREV="$(readlink -f "$APP/current" 2>/dev/null || true)"
ln -sfn "$NEW" "$APP/current"
sudo /usr/bin/systemctl restart hoodride

# as cloudflared: the same user, group and socket the tunnel uses
healthy() {
  for _ in $(seq 1 30); do
    code="$(sudo -u cloudflared /usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      --unix-socket "$SOCK" -H 'x-forwarded-proto: https' http://localhost/api/me || true)"
    [ "$code" = 200 ] && return 0
    sleep 1
  done
  return 1
}

if healthy; then
  echo "live: $NEW"
  # anything Cloudflare adds to the pages that the CSP doesn't know (warns only)
  "$(dirname "$0")/cloudflare_check.sh"
  # the automatic 10:00 UTC restart (apt-auto-reboot.conf), visible here
  echo "server: up since $(uptime -s)$([ -f /var/run/reboot-required ] && echo ' · a security fix needs a restart: at 10:00 UTC')"
else
  echo "the new release doesn't answer — see: journalctl -u hoodride -n 50"
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$APP/current"
    sudo /usr/bin/systemctl restart hoodride
    healthy && echo "switched back: $PREV" || echo "the previous release doesn't answer either"
  fi
  exit 1
fi

# keep the newest 3 (never the live one)
live="$(readlink -f "$APP/current")"
ls -1d "$APP"/releases/*/ 2>/dev/null | sed 's:/$::' | sort | head -n -3 | while read -r old; do
  [ "$old" = "$live" ] || rm -rf "$old"
done
