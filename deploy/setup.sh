#!/bin/bash
# One-time server setup (Ubuntu 24.04), run with sudo from the project:
#
#   sudo deploy/setup.sh            # users, folders, settings, services
#   sudo deploy/setup.sh --harden   # also: firewall (SSH only), SSH keys
#                                   # only, automatic security updates,
#                                   # clock sync, swap
#
# Safe to run again: nothing that exists is replaced (the settings file
# keeps its secrets). Then: fill in /etc/hoodride/env, set up the tunnel
# (SELF_HOSTING.md, step 6), and run deploy/deploy.sh.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ADMIN="${SUDO_USER:?run with sudo from your own account}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== users: hoodride (the app), cloudflared (the tunnel, in group hoodride)"
id hoodride >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hoodride --shell /usr/sbin/nologin hoodride
id cloudflared >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared
usermod -aG hoodride cloudflared

echo "== /opt/hoodride: releases, built by $ADMIN"
install -d -o "$ADMIN" -g "$ADMIN" -m 0755 /opt/hoodride /opt/hoodride/releases

# root's alone (review 2026-11-14): the tunnel's user is in group hoodride
# for the socket, and the group could read every secret — the session key,
# the release cookie that runs code as the app. Only root reads the file:
# systemd's EnvironmentFile and the root-owned hoodride-host helper.
echo "== /etc/hoodride/env: settings and secrets (root:root 0600)"
install -d -o root -g root -m 0700 /etc/hoodride
if [ ! -e /etc/hoodride/env ]; then
  sed -e "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$(openssl rand -base64 48 | tr -d '\n')|" \
      -e "s|^RELEASE_COOKIE=.*|RELEASE_COOKIE=$(openssl rand -hex 32)|" \
      "$HERE/env.example" > /etc/hoodride/env
  echo "   created — fill in PHX_HOST and the Google keys"
else
  echo "   exists — left as is"
fi
chown root:root /etc/hoodride/env
chmod 0600 /etc/hoodride/env

echo "== cloudflared (Cloudflare's signed apt repo, to /usr/bin; patched by unattended-upgrades)"
# a one-off .deb never updated itself (2 versions behind by 2026-10-29);
# the repo, as pkg.cloudflare.com documents it (stable, not next.)
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared >/dev/null
cat > /etc/apt/apt.conf.d/51hoodride-cloudflared <<'APT'
// Hood Ride: keep the Cloudflare tunnel (cloudflared) patched with the system
Unattended-Upgrade::Origins-Pattern:: "origin=cloudflared,codename=any";
APT
/usr/bin/cloudflared --version | head -1

echo "== security fixes: install ~09:00 UTC, restart at 10:00 UTC only if one needs it (overnight in the US)"
timedatectl set-timezone Etc/UTC
install -m 0644 "$HERE/apt-auto-reboot.conf" /etc/apt/apt.conf.d/52hoodride-reboot
install -d -m 0755 /etc/systemd/system/apt-daily.timer.d /etc/systemd/system/apt-daily-upgrade.timer.d
install -m 0644 "$HERE/apt-daily.timer.conf" /etc/systemd/system/apt-daily.timer.d/hoodride.conf
install -m 0644 "$HERE/apt-daily-upgrade.timer.conf" /etc/systemd/system/apt-daily-upgrade.timer.d/hoodride.conf
systemctl daemon-reload
systemctl restart apt-daily.timer apt-daily-upgrade.timer

echo "== logs: kept 14 days, in daily files (the privacy policy's promise)"
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$HERE/journald-hoodride.conf" /etc/systemd/journald.conf.d/hoodride.conf
systemctl restart systemd-journald

echo "== the clock: the app starts only once it's synced (hoodride.service: time-sync.target)"
systemctl enable systemd-time-wait-sync >/dev/null 2>&1
# …at most 3 minutes, as chrony's own wait-for-sync (review 2026-11-14):
# Ubuntu's wait has no limit, and
# a reboot with no time server reachable kept the app — and the tunnel
# after it — down for good. After the cap the app starts anyway (the
# cleanup's clock-jump guard covers a late correction: Hoodride.Sweeper)
install -d -m 0755 /etc/systemd/system/systemd-time-wait-sync.service.d
printf '[Service]\nTimeoutStartSec=180\n' > /etc/systemd/system/systemd-time-wait-sync.service.d/hoodride.conf
systemctl daemon-reload

echo "== services"
install -m 0644 "$HERE/hoodride.service" /etc/systemd/system/hoodride.service
install -m 0644 "$HERE/cloudflared.service" /etc/systemd/system/cloudflared.service
install -d -o root -g cloudflared -m 0750 /etc/cloudflared
[ -e /etc/cloudflared/config.yml ] || install -o root -g cloudflared -m 0640 "$HERE/cloudflared-config.yml" /etc/cloudflared/config.yml
systemctl daemon-reload
systemctl enable hoodride >/dev/null 2>&1
echo "   hoodride enabled (starts at boot once a release is deployed)"
echo "   cloudflared: enable after the tunnel is set up — systemctl enable --now cloudflared"

# deploy.sh stops/starts the app, copies its database while stopped (and
# puts the copy back if the new version fails), and checks it as
# cloudflared: just those, no password, through root-owned helpers — and
# nothing else (sudo_rules.sh)
bash "$HERE/sudo_rules.sh"

if [ "${1:-}" = "--harden" ]; then
  echo "== firewall: SSH in, nothing else (the tunnel needs no open port)"
  apt-get install -y ufw >/dev/null
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  # limit: an address opening 6+ SSH connections in 30 s is held back a while
  # (the bots' guessing); with keys only below, it's quieter logs, not a lock
  ufw limit OpenSSH >/dev/null; ufw --force enable >/dev/null

  echo "== SSH: keys only, never as root (bots try passwords on every new server)"
  # never without a key to get in by: $ADMIN logs in with one, and uses sudo
  # (root: no SSH login at all, 2026-11-02). The host's web console (Linode
  # Lish) still takes the root password — not SSH.
  keys="$(getent passwd "$ADMIN" | cut -d: -f6)/.ssh/authorized_keys"
  if grep -qE '^(ssh-|ecdsa-)' "$keys" 2>/dev/null; then
    # 00-: sshd takes the FIRST value it reads, and Ubuntu's cloud images
    # ship 50-cloudimg-settings.conf with PasswordAuthentication yes
    printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      > /etc/ssh/sshd_config.d/00-hoodride.conf
    sshd -t   # a broken setting stops here (set -e), before any reload
    sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' || {
      echo "   passwords still on — check /etc/ssh/sshd_config.d"; exit 1; }
    sshd -T 2>/dev/null | grep -qx 'permitrootlogin no' || {
      echo "   root login still on — check /etc/ssh/sshd_config.d"; exit 1; }
    systemctl reload ssh
    echo "   passwords off, root login off"
  else
    echo "   SKIPPED: $ADMIN has no key in $keys — passwords left on"
  fi

  echo "== automatic security updates"
  apt-get install -y unattended-upgrades >/dev/null
  dpkg-reconfigure -f noninteractive unattended-upgrades

  echo "== clock sync (session stamps and tokens use the clock)"
  timedatectl set-ntp true

  echo "== swap: 1 GB, so a memory spike slows things down instead of killing the app"
  if ! swapon --show | grep -q .; then
    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi
echo "== done"
