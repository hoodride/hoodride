#!/bin/bash
# What your server account may do as root without a password (sudo review,
# 2026-11-13). Run once, as root, from your own account — and again after a
# deploy says a helper is out of date:
#
#   sudo bash ~/hoodride/deploy/sudo_rules.sh
#
# (setup.sh runs it too.) No password needed only for:
#   * stopping, starting, restarting the app (exactly those);
#   * three fixed helpers, copied here root-owned into /usr/local/sbin —
#     your account can't edit them:
#       hoodride-db-copy     the database's copy for each deploy (db_copy.sh)
#       hoodride-host        the site's name, nothing else of its settings
#       hoodride-socket-get  ask the app on its socket, as cloudflared
#   * reading the app's log: as a member of systemd-journal (no sudo).
# Everything else as root asks for the account's password.
#
# It used to be wider: db_copy.sh run from YOUR folder (edit it, and it runs
# anything as root), curl as cloudflared with any options (the tunnel's key),
# and on the server NOPASSWD: ALL — any process of your account was root.
# That catch-all is removed LAST, only once the account has a password
# (sudo passwd <you>): never a lock-out. It's moved aside, not deleted.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo bash $0"; exit 1; }
ADMIN="${SUDO_USER:?run with sudo from your own account}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== helpers: root-owned copies in /usr/local/sbin"
install -o root -g root -m 0755 "$HERE/db_copy.sh" /usr/local/sbin/hoodride-db-copy
install -o root -g root -m 0755 "$HERE/host.sh" /usr/local/sbin/hoodride-host
install -o root -g root -m 0755 "$HERE/socket_get.sh" /usr/local/sbin/hoodride-socket-get

echo "== the log: $ADMIN reads it as a member of systemd-journal (from the next login)"
usermod -aG systemd-journal "$ADMIN"

echo "== the rules: /etc/sudoers.d/hoodride-deploy"
tmp="$(mktemp)"
cat > "$tmp" <<EOF
$ADMIN ALL=(root) NOPASSWD: /usr/bin/systemctl restart hoodride, /usr/bin/systemctl stop hoodride, /usr/bin/systemctl start hoodride
$ADMIN ALL=(root) NOPASSWD: /usr/local/sbin/hoodride-db-copy, /usr/local/sbin/hoodride-host
$ADMIN ALL=(cloudflared) NOPASSWD: /usr/local/sbin/hoodride-socket-get
EOF
# checked BEFORE it's put in place: a broken rules file breaks all of sudo
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; echo "the new rules don't check out — nothing changed"; exit 1; }
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/hoodride-deploy
rm -f "$tmp"

# ---- last: the catch-all (NOPASSWD: ALL for this account), if any
pw="$(passwd -S "$ADMIN" | awk '{print $2}')"
in_sudo=0
if id -nG "$ADMIN" | tr ' ' '\n' | grep -qx sudo; then in_sudo=1; fi
for f in /etc/sudoers.d/*; do
  [ -f "$f" ] || continue
  grep -qE "^[[:space:]]*$ADMIN[[:space:]]+ALL=\(ALL(:ALL)?\)[[:space:]]+NOPASSWD:[[:space:]]*ALL[[:space:]]*$" "$f" || continue
  if [ "$(grep -cvE '^[[:space:]]*(#|$)' "$f")" != 1 ]; then
    echo "   KEPT $f: it holds other rules too — remove its NOPASSWD: ALL line by hand (sudo visudo -f $f)"
  elif [ "$pw" = P ] && [ "$in_sudo" = 1 ]; then
    # moved aside (put back by hand if ever needed), then the whole setup checked
    mv "$f" "/root/sudoers-removed-$(basename "$f")"
    if visudo -c >/dev/null; then
      echo "   removed $f (kept as /root/sudoers-removed-$(basename "$f")): root now asks for $ADMIN's password"
    else
      mv "/root/sudoers-removed-$(basename "$f")" "$f"
      echo "   sudo's setup didn't check out without $f — put back, nothing removed"
      exit 1
    fi
  else
    echo "   KEPT $f (NOPASSWD: ALL): $ADMIN has no password, or isn't in the sudo group —"
    echo "   without it nothing could become root. Set one (sudo passwd $ADMIN), then run this again."
  fi
done

echo "== done. Check: sudo -k; sudo -n -l   (only the lines above, no ALL)"
