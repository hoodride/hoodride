#!/bin/bash
# Build and switch to a new release (run from the project, as your own user,
# after `git pull`):
#
#   deploy/deploy.sh
#
# Builds next to the running one, switches /opt/hoodride/current, restarts,
# and checks the app answers on its socket the way cloudflared reaches it —
# if not, puts the database back as it was (its copy, made just before)
# and switches back to the previous one. Keeps the last 3 of each.
set -euo pipefail
APP=/opt/hoodride
. "$HOME/beam/env.sh"   # Erlang + Elixir (deploy/install_beam.sh)
cd "$(dirname "$0")/.."

# the root-owned helpers (sudo_rules.sh) must be THIS version's — an old
# database copy step with a new deploy could copy the wrong files. Stopped
# before anything is built: reinstalling them asks for your password.
for pair in db_copy.sh:hoodride-db-copy host.sh:hoodride-host socket_get.sh:hoodride-socket-get; do
  if ! cmp -s "deploy/${pair%%:*}" "/usr/local/sbin/${pair#*:}"; then
    echo "deploy: /usr/local/sbin/${pair#*:} isn't this version's deploy/${pair%%:*} — run first:"
    echo "  sudo bash $PWD/deploy/sudo_rules.sh"
    exit 1
  fi
done

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

# stop, copy the database, switch, start, check — or put the database AND
# the code back as they were (switch.sh). Not live: stop here.
"$(dirname "$0")/switch.sh" "$NEW"
# anything Cloudflare adds to the pages that the CSP doesn't know (warns only)
"$(dirname "$0")/cloudflare_check.sh"
# the automatic 10:00 UTC restart (apt-auto-reboot.conf), visible here
echo "server: up since $(uptime -s)$([ -f /var/run/reboot-required ] && echo ' · a security fix needs a restart: at 10:00 UTC')"

# the newest 3 database copies kept — one per release kept below
sudo /usr/local/sbin/hoodride-db-copy prune 3

# keep the newest 3 (never the live one)
live="$(readlink -f "$APP/current")"
ls -1d "$APP"/releases/*/ 2>/dev/null | sed 's:/$::' | sort | head -n -3 | while read -r old; do
  [ "$old" = "$live" ] || rm -rf "$old"
done
