# Running your own Hood Ride

One server, behind a free **Cloudflare Tunnel**:

Visitors → Cloudflare (HTTPS) → tunnel → `cloudflared` on your server → the
app's **Unix socket** `/run/hoodride/app.sock`.

- No certificates to manage: Cloudflare handles HTTPS.
- No open web ports: nothing on the server listens on the network (Erlang's
  own ports stay on `127.0.0.1`), and the server's address is never public.
- No ~28,000-connection ceiling: a socket connection uses no port number.
- Cloudflare does see the traffic decrypted, so name it in your privacy
  policy (Hood Ride's does).
- Request size limits live in the app, not at Cloudflare: only JSON is read,
  at most 64 KB per request and per live-connection message
  (`lib/hoodride_web/endpoint.ex`); anything bigger is refused with 413 at
  once. Nothing to set in Cloudflare — its free plan can't add a smaller
  edge limit (the "request body size" rule field needs an Enterprise plan;
  the free plan's own cap is a fixed 100 MB).

This is exactly how [hoodride.app](https://hoodride.app) runs. The files are
in `deploy/`, tested under systemd on Ubuntu 24.04.

## What you need

- **A server** running **Ubuntu 24.04**, that you reach with an SSH key.
  hoodride.app runs on 2 CPUs and 4 GB of memory; it builds the app on the
  server, so we'd suggest at least 2 GB. Pick a provider with basic DDoS
  protection.
- **A domain on Cloudflare** (the free plan is enough).
- **Google sign-in keys**: [GOOGLE_SETUP.md](GOOGLE_SETUP.md), about 10
  minutes.

## Setting it up

1. **Log in with your SSH key** as a normal user with `sudo` (not root).
2. **Get the code:**
   ```
   git clone https://github.com/hoodride/hoodride.git ~/hoodride
   cd ~/hoodride
   ```
3. **Erlang and Elixir**, the same versions Hood Ride is tested on, with
   their checksums verified: `deploy/install_beam.sh`
4. **Server setup:** `sudo deploy/setup.sh --harden`
   - creates the app's user, folders and settings file, and installs
     `cloudflared` from Cloudflare's own package source;
   - `--harden` also turns on the firewall (SSH only, rate-limited), turns
     off root and password logins over SSH, installs security fixes
     automatically (restarting at 10:00 UTC only when one needs it), keeps
     the clock in sync and adds swap;
   - keeps the server's logs for 14 days (Hood Ride's privacy policy
     promises this); the app writes only warnings and errors, never a line
     per visit.

   It's safe to run again: nothing that exists gets replaced.
5. **Settings:** `sudo nano /etc/hoodride/env`
   - `PHX_HOST`: your domain, like `rides.example.com`
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: from
     [GOOGLE_SETUP.md](GOOGLE_SETUP.md)

   `SECRET_KEY_BASE` and `RELEASE_COOKIE` were made for you by setup, and
   `SOCKET_PATH` is already set. Every setting is explained in
   `deploy/env.example`.
6. **The tunnel** (a named tunnel with a settings file; quick tunnels can't
   reach a socket):
   ```
   cloudflared tunnel login                  # opens Cloudflare: pick your domain
   cloudflared tunnel create hoodride        # prints the TUNNEL_ID
   sudo install -o root -g cloudflared -m 0640 ~/.cloudflared/TUNNEL_ID.json /etc/cloudflared/
   sudo nano /etc/cloudflared/config.yml     # TUNNEL_ID (2 places) + your domain
   cloudflared tunnel route dns hoodride YOUR-DOMAIN
   rm ~/.cloudflared/cert.pem ~/.cloudflared/TUNNEL_ID.json
   ```
   The last line matters: `cert.pem` can create and delete **every** tunnel
   in your Cloudflare account, and the server only needs its own tunnel's
   file in `/etc/cloudflared/`. `tunnel login` makes a new one whenever you
   need it again. (`tunnel login` also adds a "Cloudflare Tunnel" API token
   to your Cloudflare account; you can delete it there once the tunnel is
   set up.)
7. **Start it:** `deploy/deploy.sh`, then
   `sudo systemctl enable --now cloudflared`

   `deploy.sh` builds the app, switches to the new version, restarts it and
   checks it answers the way `cloudflared` reaches it. If it doesn't, it
   switches back to the previous version.
8. **Check it:**
   - `https://YOUR-DOMAIN` opens, with no redirect loop;
   - Google sign-in works, and the map connects;
   - no `without a usable X-Forwarded-For` warning in
     `journalctl -u hoodride -p warning` (that would mean the app can't see
     visitors' addresses, which its rate limits need).

   **If the socket link misbehaves:** remove `SOCKET_PATH` from
   `/etc/hoodride/env`, add `TRUSTED_PROXIES=127.0.0.1` (the app then
   listens on `127.0.0.1:4000`), set the tunnel's service to
   `http://127.0.0.1:4000`, and restart both.

## Day to day

| | |
|---|---|
| Update | `cd ~/hoodride && git pull && deploy/deploy.sh` (keeps the last 3 versions) |
| Logs | `journalctl -u hoodride` (`-f` to follow, `-p warning` for warnings and errors) |
| Status / restart | `systemctl status hoodride`, `sudo systemctl restart hoodride` |
| Tunnel | `journalctl -u cloudflared`, `systemctl status cloudflared` |

**Backups:** accounts live in one SQLite file, `/var/lib/hoodride/hoodride.db`,
with profile photos beside it in `avatars/`. Back up with SQLite's own backup
command, never a plain file copy while the app runs:
`sudo sqlite3 /var/lib/hoodride/hoodride.db ".backup '/path/to/backup.db'"`
(`sudo apt install sqlite3` first). Photos come back by themselves the next
time each person signs in. Everything else (who's on the map, rides,
messages) lives in memory and is never written down, by design.

**Run exactly one app server.** Everything live is in one server's memory: a
second server would be a separate world, where riders and drivers on
different servers never see each other.

## Make it yours

The code is yours to use (MIT), but the **Hood Ride name and logo are not**,
and the privacy policy and terms were written for hoodride.app. Before
inviting anyone, change:

**The legal pages**, written for hoodride.app, with its contact address:
- `priv/static/privacy.html`: your own privacy policy
- `priv/static/terms.html`: your own terms. When you change them, also
  change the version in `lib/hoodride/terms.ex`, so everyone is asked to
  agree again.
- `priv/static/privacy.<lang>.html` and `priv/static/terms.<lang>.html`
  (one pair per language): translations of the two pages. Each names the
  English page it was translated from, so once you change the English,
  `test_js/legal.test.mjs` fails until each is translated again from
  yours (the new fingerprint is in its message). Or delete them all, and
  that test with them: every language then gets the English pages.

**The name**, everywhere people see it:
- `priv/static/index.html`: the page title, the sign-in screen and the top bar
- `priv/static/manifest.json`: the name on the phone's home screen
- `priv/static/notfound.html`: the "page not found" page
- `lib/hoodride_web/controllers/page_controller.ex`: the link preview
  (`og:` tags) shown when the link is shared
- `priv/static/app.js` and `priv/static/sendfilter.js`: a few messages
  ("Can't reach Hood Ride…", the location-permission steps)
- the translations, `priv/gettext/<lang>/LC_MESSAGES/default.po` (one
  per language): the name in their English lines (`msgid`) and their
  translated ones (`msgstr`)
- `priv/static/i18n-<lang>.js` (one per language): made from the
  translations, never edited by hand

  In that order: change the name in the files above, **then** in every
  `default.po`, and only then run `mix hoodride.i18n.extract`, then
  `mix hoodride.i18n.build`. (A message whose English changed is a new
  message to the translations: changed in the `.po` first, it keeps its
  translation; otherwise it comes back blank, to translate again.)

**The pictures:**
- `priv/static/car.png`, `car-avatar.png`, `icon-180.png`, `icon-192.png`,
  `icon-512.png`, `favicon.ico`: the logo and app icons
  (`brand/car-source.png` is the original)
- `priv/static/og.png`: the link-preview picture, made from
  `assets/og/og.html` (instructions inside)

**Your contact email:** both legal pages give one. A free way to have an
address at your own domain: Cloudflare **Email Routing** (Email → Email
Routing) forwards it to an inbox you already have.

## Moving to another Cloudflare account

A tunnel can't move, so make a new one. Export the DNS records from the old
account and import them in the new one (not the automatic scan: proxied
records copied that way can cause error 1000), leaving out the old tunnel's
record. Turn DNSSEC off at your registrar first. Recreate your Cloudflare
settings, keep any `google-site-verification` record, then run the tunnel
steps above (step 6) with the new account and switch the nameservers at
your registrar. Afterwards, delete the old tunnel and its API token in the
old account.

## Growing

One server goes a long way: everything live is in memory, and the socket
link has no connection ceiling. If you ever outgrow it, the design notes in
[ARCHITECTURE.md](ARCHITECTURE.md) are the place to start. A second server
needs a redesign first (see "Run exactly one app server").
