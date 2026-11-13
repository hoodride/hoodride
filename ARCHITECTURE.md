# Hood Ride — Architecture

> Neighborhood p2p rides as a PWA. Chat-first, $0-cost-first, privacy-first.
> This doc captures every design decision made during initial design (Oct 2026).
> The frontend (mock-driven) is built; the backend described here is not yet.

## Product model

- **One account, two modes:** 🚶 Riding / 🚗 Driving — a toggle, not separate account types.
  Mode switching locks during an active ride/request.
- **Chat-first:** the conversation replaces Uber's machinery. Destination, pickup detail,
  negotiation — humans typing, not forms. No geocoding, no routing engine, no fare engine,
  no destination field, no phone verification. Deliberately cut, keep it that way.
- **Deliberate cost ceiling:** no service that charges per use, ever.
  - Map tiles: OpenFreeMap (free, no key) + MapLibre GL JS
  - Turn-by-turn: Google Maps **deep link** (just a URL, driver's own app does the nav)
  - Login: Google/Facebook OAuth (free to register)
  - Name and photo come ONLY from the sign-in provider (owner's choice,
    2026-10-26): not changeable in Hood Ride — Google/Facebook own and
    moderate them; a change there arrives at the next sign-in. Strangers see
    a FIRST name only (`Accounts.first_name/2`: Google `given_name`, else the
    full name's first word, else "Neighbor" — never the email; controls and
    format characters dropped, NFC, ≤ 30 graphemes); the full name isn't
    stored. No photo → 🙂. Settings: your photo top left opens a drawer from
    the left (sign out at its bottom, blocked during a ride or request).
  - **Privacy** (2026-10-26, owner: operator "Hood Ride", USA, 18+,
    contact@hoodride.app): `/privacy` (priv/static/privacy.html, public, linked
    from the login screen — Google's "home page" — and the drawer; CalOPPA's
    Do Not Track + no third-party tracking; effective date). COLLECT LESS: no
    email (Google `openid profile`; column dropped); prod logs no request
    lines (`:request_log false`); journald 14 days in daily files
    (deploy/journald-hoodride.conf — MaxRetentionSec is off by default and
    files span a month). **Delete account** (`Hoodride.AccountDeletion`,
    `POST /api/account/delete {confirm}`; a small link under Sign out, beside
    Privacy Policy, then a confirm step — Sign out itself has none, owner's
    choice: reversible):
    refused (409) in a ride or with your own request waiting; else the
    account's row and its sign-ins deleted FIRST, then off the map (going offline declines incoming requests, riders
    told), chats closed (partner told), presence + session stamp forgotten,
    the row deleted, every device disconnected, session dropped. Signing in
    again = a new account. 12 + 8 tests, 16 mutants; Chrome by measurement;
    systemd test 26/26 (journald settings live, no request lines). A
    lawyer's review before a public launch.
  - Hosting: one small VPS (~$5/mo) is the only recurring cost

## Stack

- **Frontend:** plain HTML/CSS/JS PWA. No framework, no build step. Files: `index.html`,
  `styles.css`, `app.js`, `manifest.json`, `sw.js`, `icon.svg`.
- **Backend (to build):** Elixir / Phoenix. Channels for realtime, Presence for who's-online,
  ETS for all live state, **SQLite for users only** (via Ecto / `ecto_sqlite3`;
  Postgres migration = adapter swap if ever needed). DECIDED 2026-10-21:
  successor is Postgres (not Mongo — Ecto first-class, data is relational).
  Triggers, not timeline: deploy friction, a write-bearing durable feature
  (e.g. ratings), or observed lock contention. Until then SQLite's whole-file
  write lock is irrelevant by design: the pen comes out only at login (upsert);
  rehydration and all profile traffic are WAL snapshot READS (lock-free);
  every hot path lives in ETS and never touches the database at all.
- Pure web app — **no app stores, no Capacitor** (owner's call). Consequence: no background
  GPS. Mitigations: wake lock on the map screen (dash-mount pattern), honest stale markers
  ("last seen Xm ago"), chat covers the gaps. Browser WONTFIX — not solvable in pure web.

## Core flows

```
rider:   browse → (optional ✋ broadcast) → chat → REQUEST → wait → ride → end
driver:  offline → GO ONLINE → see demand (cells) → chat → ACCEPT/DECLINE → ride → end
```

- Rider-initiated: tap a driver's car on the map → card → message → request.
- Driver-initiated: tap a ✋ on the map → card → message → rider answers *by requesting*.
- **The rider always creates the request; the driver only answers it.** A driver can invite,
  never commit a rider. (Symmetric powers, asymmetric commitment.)
- Pickup point = rider's live GPS dot, **or the 📍 pin if set** (pin wins, including for the
  Navigate deep link). Pin is set after connecting, optional, movable, and removable:
  tapping your own pin clears it (SHIPPED 2026-10-21 — the clear_pin wire event the
  protocol cross-check found orphaned), reverting the driver to your live dot.
  Rider-only authority both ways (set and clear), server-enforced.
- **TLS terminates at the reverse proxy** (deploy decision, not an omission —
  Sobelow's Config.HTTPS finding is this pattern): the app serves HTTP behind
  Caddy/nginx on the VPS; prod.exs already has the matching force_ssl +
  x_forwarded_proto rewrite + HSTS.
- Driver navigation: `google.com/maps/dir/?api=1&destination=lat,lng` deep link.
  While the driver is in Google Maps their socket is dead — this is normal, see Presence.

## Request lifecycle (the one real state machine)

```
requested ──→ accepted   (becomes the ride)
          ──→ declined   (by driver)
          ──→ cancelled  (by rider)
          ──→ expired    (sweeper, ~5 min unanswered)
```

- State lives **on the request object**, never on a person. Driver has no "request_pending"
  state — requests pile up independently in the inbox; one resolving touches nothing else.
- Driver states: `offline → online → in-ride`. Rider is bound 1:1 to their single open
  request (no double-booking — enforced server-side: one non-terminal request per rider).
- Every transition is precondition-checked (race: rider-cancel vs driver-accept):
  in-memory equivalent of `UPDATE ... WHERE status='requested'`, or a per-ride
  GenServer serializing all mutations. First action wins, the loser gets told.
- **Chats survive requests.** Cancel/decline resolves the request; the conversation and its
  history remain, and the Request/Accept buttons simply reflect current request state.
  Re-requesting after decline is allowed (anti-pester cooldown only if real usage demands;
  block/mute is the real abuse lever, future).
- Every state has an exit, for both people: ✋ toggle-off, Cancel request (rider),
  Decline (driver), End ride (either).
- **Unavailable driver = nobody waits (SHIPPED 2026-10-21).** A driver who goes
  offline, is grace-reaped, or enters a ride instantly declines ALL pending
  requests aimed at them (single choke point: `Geo.driver_offline`, which ride
  start already routes through). The `:busy` accept paths decline-with-notice
  instead of reinserting, so no request can race back in. `driver_busy` blocks
  new requests; this rule clears pre-existing ones. Riders are notified via the
  normal `request_declined` and re-shop immediately — no one waits out the 5-min
  TTL on a driver who can't come.
- Arrival is driver-declared (auto when their GPS nears the pin/rider, or the
  "I'm here" button), announced to both phones, survives rehydration.
- **Ending a ride (any path: End ride, abandonment) leaves the driver OFFLINE.**
  Reappearing on the browse map is an explicit GO ONLINE tap once the actual
  trip is over — the app never guesses when the drive finished. (The "ride" in
  Hood Ride is pickup coordination; the app's job ends at the curb.)

## Visibility & privacy model

1. **Invisible by default.** Browsing broadcasts nothing, for anyone.
2. **Visibility follows intent.** Driver: GO ONLINE = car visible to riders.
   Rider: ✋ Need a ride = anonymous demand marker visible to online drivers.
   Both instantly revocable.
3. **Staged disclosure**, matched to commitment:
   - ✋ on map → ALL online drivers see: approximate location only (cell-fuzzed), no identity
   - 🚗 on map → ALL riders watching see the same: its block (spot) only, no identity
     (since 2026-10-24; before, every car carried name, photo and exact GPS)
   - tap a marker → THAT person sees: name + photo (card)
   - accepted ride → YOUR ride partner only: exact live GPS + pin
4. **Live tracking is mutual and ride-scoped only.** Never ambient. Exact positions travel
   only inside an accepted ride's private channel. The ride keeps each person's LAST
   position — in its own process's memory, for the ride only — so a partner whose app
   reloads sees them at once; never on disk, never in `Rides.get`/`/api/state`, hidden
   from crash reports, filtered from every log line, gone when the ride ends (the app
   drops it then too). Retention to state in the privacy policy: "until the ride ends".
5. **Nothing is remembered** (see Ephemerality). No trip history, no chat archive,
   no movement logs. Only accounts persist.
6. **The server enforces all of it** (SHIPPED 2026-10-23, below). Hiding
   something in the app is not privacy: anything on the wire can be read.

### Who receives what (server-enforced, 2026-10-23)

Before this, every map watcher received BOTH layers (cars with name, photo
and exact position, AND raised hands) and both counts; the app only hid what
the user's mode shouldn't show. Anyone reading their own websocket saw other
riders' hands and rival drivers' positions. Now the server sends each client
only what its **server-derived role** (`Hoodride.Roles`) allows:

| Role (precedence top-down) | How the server knows | Receives from the map |
|---|---|---|
| **in a ride** (any seat, even `:pending`) | a row in `rides_by_user` | nothing |
| **online driver** | their car row in `geo_drivers` | raised hands + hand counts |
| **viewer** (everyone else) | — | cars + car counts |

- **One topic per layer.** `geo:d:<cell>` (cars), `geo:h:<cell>` (hands),
  `agg:d:<cell>` (car counts), `agg:h:<cell>` (hand counts). The client still
  sends cells; the WorldChannel decides which layer's topics it holds.
- **Snapshots carry one layer**: a viewer's cell snapshot has `drivers` only
  (no `hands` key at all), an online driver's `hands` only; counts likewise.
- **A count update carries only the side that changed.** Sending the other
  side too, even unchanged, would tell riders WHEN hands come and go (a
  timing leak). `shift_agg` knows which side moved; the recount's heal
  compares sides; an emptied hex publishes 0 to the side that emptied.
- **Role changes**: every change point pings `role:<user>` AFTER its write —
  a car's first row, a car leaving (`offline_core`: the button, a mode flip,
  a driver raising a hand, a sweep reap, a ride start), a seat claim and its
  error path, freed seats, the sweeper's orphan-seat reclaim. The ping
  carries nothing; the WorldChannel re-derives, drops every topic the new
  role may not hold, and pushes `role`. It subscribes nothing itself: the
  app clears the layer it lost (its `*_left` events will never come) and
  resyncs the same wish, and the ordinary reconcile, under the ordinary
  sync budget, brings the new layer. (A server-pushed snapshot would bypass
  that budget: ~2x the abuse cost of a sync.)
- **The live role is checked on every forwarded message** (two ETS
  lookups), so a broadcast queued in the mailbox before a role ping is still
  dropped. Every sync re-derives the role too, so a lost ping heals on the
  next sync (the app resyncs at least every ~60 s). The join reply carries
  the role, so the app can re-send a `driver_offline` the rate limit dropped.
- **Reveal**: a ✋ and a 🚗 are anonymous (id, cell, spot). Who it is comes
  from the WorldChannel's `reveal`, answered only for the role that receives
  that marker (an online driver for hands, a viewer for cars), and only
  while its channel is receiving that marker's hex (it's on their screen).
  Everything else gets the same `unavailable`. There is no profile lookup by
  id anywhere (`/api/users/:id` was deleted: it answered any id for any
  logged-in user, OWASP API1). Unknown `/api/` paths answer a JSON 404.
- **Cold contact** (no chat, no open request): you can only reach someone on
  YOUR screen, a car in a hex your map receives cars for, or (as an online
  driver) a hand in a hex it receives hands for. One rule for messages and
  requests (`HoodrideWeb.Reach`): the user channel asks the map channel on the
  SAME socket (one call, only for cold contacts; no answer → refused). Every
  refusal is `unavailable`, a missing id included (no existence oracle);
  `out_of_view` only when a viewer tries a car that is online but off
  screen. So drivers can't cold-contact drivers, and mid-ride nobody new.
  Before: message any id → a conversation exists → reload → `/api/state`
  returned that stranger's name and photo.
- **Ride chat at ride start**: `Ride.init` opens the pair's conversation
  (empty) before `ride_started` is broadcast, so the first mid-ride message
  is never a cold contact and a silent ride stays reachable afterwards
  (until the room empties, like any chat: both offline past grace means
  gone, by the owner's call). The app keeps server-backed empty chats.
- **Positions only while the ride lives**: the ride channel relays `pos`
  only from a user still holding a seat in that ride, and closes itself
  after pushing `ended`. A ride that crashes says `ended` from `terminate`
  (not on normal stops, which already said it); a killed one gets it from
  the sweeper's seat reclaim, once per ride. **A join racing the end:**
  Phoenix subscribes a channel only after `join/3` returns, so an `ended`
  in between reached nobody and the join succeeded onto a dead ride (found
  by the monster test). Every end frees the seats before it broadcasts, so
  the ride channel re-checks the seat once subscribed (`:confirm_seat`):
  still this ride → `ended` is still to come; otherwise it says `ended`
  itself. Tests: `ride_join_race_test.exs` (incl. a real race that fails on
  the old code; 4 mutants).
  **A position racing the end (2026-10-25):** the sender's seat check and
  the end aren't ordered, and Phoenix delivers a plain broadcast straight to
  the connection while `ended` goes through the channel, so a position sent
  at the moment of the end could land after `ended` (the mega monster). The
  ride channel intercepts `peer_pos` and pushes it only while the RECEIVER
  still holds a seat in this ride. `ride_pos_after_end_test.exs`, 4 mutants.
  **The last position, handed to a partner who rejoins (2026-10-25).** Positions
  were only relayed: a partner whose app reloaded saw nobody until the other
  phone's next send (up to ~24 s standing still at the pickup), and Navigate
  had no exact target. Now (the late-joiner last-value pattern: MQTT retained
  messages, RTI's last-value cache): `pos` is STORED in the ride process
  (`Rides.position/3`, synchronous) THEN relayed, and `:confirm_seat` — after
  the subscribe — pushes the partner's last one with `age_ms` (server steady
  clock). Stored before relayed + handed over after subscribing = never an
  older one after a newer one. Privacy, each tested: kept in a
  `Hoodride.Rides.Positions` wrapper that inspects as `#Positions<redacted>`
  (a crash report printed the WHOLE state in a stack trace — `format_status`
  can't reach it, and the sensitive flag didn't hide it: found by the test);
  `format_status/1` redacts state, message and sys log; the process turns
  sensitive at the end of start-up (positions never exist before, and
  start-up stays traceable); catch-all callbacks, so no message can crash it
  with its arguments printed; `config :phoenix, :filter_parameters` adds
  lat/lng (Phoenix logs every channel message's params at :debug — positions
  were in the dev log). App (`ridepos.js`): a position is FRESH under 2 × the
  longest heartbeat (48 s; presence systems call someone gone after ~two
  missed beats, PubNub heartbeat = timeout/2 − 1); stale → "last seen N min
  ago" in the banner, the peer card and on Navigate, and auto-arrival only
  aims at the pin or a FRESH exact position; every ride (re)join resets the
  send rule. Tests: ride_position_memory_test (15), ridepos.test (6), 17
  mutants; the monster checks every (re)join gets the hand-over first and
  within a tick (202 in a small run); Chrome: reload → marker in 0.8 s with
  the driver silent, "last seen 1 min ago" past 48 s, nothing exact after
  the end, `[FILTERED]` in the dev log.
  **Known limit — Navigate freezes the driver:** opening Google Maps puts
  Hood Ride in the background, and a backgrounded web app gets no GPS (iOS
  has no background location for web apps; W3C discussions confirm), so the
  rider's map holds the driver's last position — now honestly "last seen".
  Only a native app could keep sending.
- **Random user ids** (`Accounts.random_id`): every map payload carries an
  id, and sequential ids told anyone how many users exist and how fast that
  grows. Random integers in (2^32, 2^53): JS-exact, never meeting small test
  fixture ids. A taken id retries; a parallel first login of the same
  person returns that person (that race used to crash dev_login with a 500).
- **The service worker caches only our own files**, never `/api/` or
  `/auth/` (`/api/state` held every message text and the email — now
  previews, with the texts in `/api/chat`; cached, it
  outlived logout). Other sites (map tiles, style) are left to the browser's
  HTTP cache. MapLibre is vendored (npm sha512 verified) so the offline
  shell is complete without a CDN.
- **Versioned file addresses (2026-10-28, deploy day).** Behind Cloudflare,
  Plug.Static's plain `public` became "keep 4 hours" (edge and browser), so a
  new page could run old scripts. Now the standard cache busting (MDN, web.dev):
  `PageController` stamps the page and `sw.js` with `app.js?vsn=<sha256 of the
  file, 12 hex>` (`HoodrideWeb.StaticVersions`, fixed at boot in prod) — a
  year, `immutable` (Plug.Static's `?vsn=` answer); an unchanged file keeps
  its address across deploys. Anything unversioned is `no-cache` + ETag (a
  304). A `vsn` that isn't the file's current one (an old page after a
  deploy) is answered as unversioned, never kept a year under that name.
  The offline cache stores the same versioned addresses (offline, only an
  exact match is found). Tests: `static_versions_test.exs` (4 mutants).
- **Content-Security-Policy (2026-10-28).** The second lock against injected
  code (OWASP CSP cheat sheet, web.dev "strict CSP"): `HoodrideWeb.CSP` —
  scripts and styles `'self'` only (the pages have NO inline scripts, styles
  or handlers, `csp_test.exs` keeps it so; Google's nonces are for pages with
  inline or other sites' scripts, so `'self'` is OWASP's tighter baseline
  here) — plus `https://static.cloudflareinsights.com`, Cloudflare Web
  Analytics' beacon, which Cloudflare injects (owner's pick: visit counts, no
  cookies; named in the privacy policy; its data goes to our own
  `/cdn-cgi/rum`), connections to Hood Ride + its socket by name + tiles.openfreemap.org,
  pictures `'self' data: blob:`, workers `'self' blob:` (the offline service
  worker AND MapLibre's — `'self'` was missing at first; Chrome refused sw.js),
  no plugins, no `<base>`, forms to us, never framed. The privacy page's
  `<style>` moved to `privacy.css`. Rollout: prod REPORT-ONLY first
  (`config :hoodride, :csp_report_only` in prod.exs; `frame-ancestors`
  enforced throughout), violations to `/api/csp-report`, logged as rule +
  site only (`journalctl -u hoodride | grep csp:`), then delete the line to
  enforce. Dev and tests enforce. 5 mutants. ENFORCED in prod since
  2026-10-28. REPORTING OFF since 2026-10-29 (`config :hoodride,
  :csp_reporting`, default false: no report lines, `/api/csp-report` 404):
  ~30 reports per page from Brave Shields' injected styles, and the
  receiver's body read answered on the stale conn — Bandit then drained
  the "unread" body from the tunnel connection, eating the next request
  (fixed; `keepalive_test.exs`, a real Bandit socket). Its one real catch,
  Cloudflare injecting scripts, is now `deploy/cloudflare_check.sh` (run by
  deploy.sh: our page via the socket vs Cloudflare's copy; known additions
  in `cloudflare_expected.txt`). Back on only with flood protection.
- **Update after deploy (2026-10-25).** A single-page app never navigates,
  so a page left open keeps running old code after a deploy. The server
  fingerprints the app files at boot (`HoodrideWeb.Build`: names + contents
  of everything served, sha256 → 12 hex) — nobody bumps it, and a restart
  with nothing changed is the same build. `PageController` serves the page
  stamped with it (`<meta name="hoodride-build">`, for `/` and `/index.html`)
  and `sw.js` with its cache named after it (no hand-bumped "hoodride-vNN";
  `no-cache` so the browser finds updates). The world join reply carries
  `build`; on every (re)join, `visibilitychange` and a back/forward-cache
  `pageshow`, the app compares (rules: `update.js`): hidden and idle →
  reload silently; on screen, or busy (ride, request, ✋, shift, a typed
  message) → "Update available — tap to reload". Best practice per
  Chrome's Workbox guide, LiveView static tracking and common SPA practice:
  never yank a page someone is using. The wire `PROTOCOL` stays hand-set (a
  judgement: "old apps can no longer talk to this server"); a test holds
  app.js and `WorldChannel.protocol()` equal. `Plug.Static`'s dev-only
  `raise_on_missing_only` is off (it raised on the stamped files); a file
  missing from `static_paths` is caught by `static_files_test.exs`.
  Chrome-verified with real restarts: on screen → button, page untouched;
  hidden → silent reload onto the new build, old cache wiped.
  **A second way to hear of a new build (2026-10-25):** the build came only
  through the socket, so a tab that CAN'T connect never learned of one and
  retried forever — exactly the deploys that change how connecting works
  (the login lockdown refused pre-lockdown tokens; such tabs needed a manual
  reload). `/api/socket_token`, which the app calls after a failed connect
  (≤ once a minute), now returns `build` too, and the app runs the same
  `checkForUpdate`. Test: the reply's build equals the join reply's (one
  mutant). Chrome: a tab whose socket could never connect showed "Update
  available" within 35 s of a build change; the tap reloaded it onto it.
  Tabs from before this change still need one manual reload.
  **Prod prepares the stamped page and sw.js once, at start-up**
  (`config :hoodride, :prepare_pages_at_boot` in prod.exs →
  `PageController.prepare/1` from `Application.start`, kept in
  `persistent_term` beside the build): the running server serves exactly the
  version it started with — files changed under it (a deploy copying files
  before the restart) could otherwise go out as NEW code under the OLD build
  tag. Dev keeps reading per request, so edits to index.html/sw.js show on a
  reload. Tests: prepared copy served (with the build), disk path when off,
  the config switch; 4 mutants. The start-up call itself can't be unit-tested
  (the app starts once per run, switch off) — proven live instead: `elixir
  --erl "-hoodride prepare_pages_at_boot true" -S mix run -e …` reports it
  prepared; with the call removed it doesn't.
- **Cars travel like hands (2026-10-24).** On the browse map a car is
  `{id, cell, spot}`: `spot` is the res-9 hex (~block) its driver's app
  chose, the same fuzz as a ✋. No exact position and no name or photo
  reach the server's car row or any rider; the name comes only from
  `reveal`, and exact GPS only on the ride channel. Before: every update
  carried name, photo and exact GPS to everyone watching the hex, so a
  script could log faces and routines (the NDSS 2019 nearby-cars study
  found drivers' homes on 20 ride-hailing apps this way).
  - **Snapped, never jittered.** Random noise averages out over many
    updates; a fixed grid gives nothing to average.
  - **Sticky spot (hysteresis), in the app** (`sendfilter.js`
    `stickySpot`). A plain "the hex I'm in" leaks at edges: a phone parked
    on a border flip-flops and pins itself to the line (to a corner,
    between three). The spot moves only when the new hex's centre is closer
    than the current one's by more than 2 × the fix's accuracy (a fix off
    by r can shift that difference by 2r), r capped at half H3's average
    edge so a poor indoor fix can't freeze a moving car. The last spot is
    remembered on the device per user (cleared on logout; storage access
    guarded), so a home on an edge shows in the same block every day. Only
    the spot is sent: the SERVER derives the cell and count parents from it
    (Hoodride.H3 — one chain, so none of them can flap at its own edges, and
    nobody can claim areas they aren't in; step 5, 2026-11-13).
  - **Announced only on change.** A car's update is broadcast only when its
    spot or cell changes; a parked car's ~20 s heartbeat just refreshes
    `vouched_at` (the frozen-driver reap still works) and tells nobody
    anything. Far fewer broadcasts, too.
  - **"Location is blocked" (2026-10-29, owner's iPhone in Brave).** Every
    phone has two layers — the phone lets the BROWSER APP use location
    (iPhone: Settings › Privacy & Security › Location Services › the app;
    Android: Settings › Apps › the app › Permissions › Location), then the
    browser lets the SITE. With layer 1 at "Never" no prompt can appear: the
    page gets an instant "denied". So the banner names THE browser
    (`HoodSendFilter.browserOf`: CriOS/FxiOS/EdgiOS/"Brave"/navigator.brave,
    Instagram, Facebook; SamsungBrowser/EdgA/Firefox; named only when it
    says so — a Safari-looking iPhone gets "Safari Websites (or your
    browser's name…)"), adds Precise Location (one block needs it; Chrome
    on Android asks Precise/Approximate per site since May 2026 — undone
    with Reset permissions), and WRAPS (it was one line, cut with "…"
    exactly where the steps were). The browser keeps its "no" for the open
    page even after Settings allow it, so coming back after a "blocked"
    reloads once, quietly (`locator.js` onHidden/onVisible; never while a
    message is half-typed). No link can open Settings: iOS refuses
    prefs:/App-Prefs: from the web, Chrome refuses non-BROWSABLE intents.
  - **Navigate is a real link (2026-10-29, owner's iPhone).** It was
    `window.open(…, "_blank")`: iOS made a new tab, handed it to the Google
    Maps app, and left the tab behind blank. Now an `<a>` styled as the
    button (`navlink.js`): the tap fills in the directions address
    (Google's Maps URLs, `api=1`, comma as `%2C`) and the target — phones
    the SAME tab (Google's apple-app-site-association registers
    `/maps/dir/*` for `com.google.Maps`, so the app takes it and Hood Ride
    stays; with no app, Maps' site opens and Back returns), computers a new
    tab. A tapped link is what hands off to an app (script navigation is
    "untrusted"). Caveats: Brave's "Allow universal links to open in
    external apps" off keeps links in Brave; iOS remembers a per-domain
    "open in browser" choice. Tests: `navlink.test.mjs`,
    `navigate_link_test.exs`.
  - **Chat scroll and the meetup pin (2026-10-29, owner).** A new message
    scrolled the chat to the bottom always — yanking a reader away from
    older messages. Now (`chatscroll.js`, as iMessage/WhatsApp/Slack): it
    follows only if you were at the bottom (within 60 px) or it's your own;
    scrolled up, it holds and shows "↓ New message" (a tap goes down;
    reaching the bottom yourself clears it). Meet here / Move pin centre on
    you / the pin at `PIN_ZOOM = 16` (side streets named; a fingertip ≈ one
    corner), only ever zooming in. Tests: `chatscroll.test.mjs`,
    `chat_and_pin_test.exs`. (The close buttons were tried at 44 × 44 and
    reverted at the owner's word: they match the rest as they are.)
  - **Where the map opens (2026-10-29, owner).** It always opened on the
    Manhattan placeholder, and a quiet location reading at load didn't move
    it. Now: the area you last used on this device (`viewstore.js`, per
    account, ~10 m rounding; cleared on sign-out, account deletion and a
    signed-out start — the privacy page's "Signing out removes them"); the
    first location reading centres the map on you at `INTENT_ZOOM` unless
    you moved it first (`movestart` with an `originalEvent`); first visit
    without location: the placeholder. Tests: `viewstore.test.mjs`,
    `map_start_test.exs`.
  - **A shift or ride under way at page load resumes GPS at once
    (2026-10-29, owner).** iPhones forget an "allow" on reload, so a driver
    who refreshed got "riders can't see you" and had to find the Share
    button. Now the boot's first state load calls `loc.resumeAtLoad()`: with
    the browser at "ask", GPS starts straight away (its question, if any,
    comes at once) AND the Share button shows, in case a browser holds the
    question for a tap; a reading hides the button; the button asks afresh
    inside the tap. Only for what was under way at load — a ride the
    server starts later still asks only on a tap (web.dev; Lighthouse
    flags location asked on a plain page load). The resume flag lasts
    until a check decides (hydrate's own check may already be running).
  - **The page never zooms on the map screen (2026-10-29, owner's iPhone).**
    A pinch on the top bar zoomed the whole page; the pinch back out landed
    on the map, so the page stayed big. The standard fix (MDN touch-action;
    caniuse: iOS 13+, all Android; the viewport lock `user-scalable=no` is
    ignored by modern iOS): `.screen-map, .screen-map * { touch-action:
    pan-x pan-y }` — on everything inside, as WebKit reads it only up to the
    nearest scrolling area; MapLibre's more specific canvas rule (`none`)
    still wins, so the map keeps its pinch. Text boxes ≥ 16px (the chat box
    was 15: iPhones zoom the page into smaller ones on tap and don't zoom
    back). The sign-in screen and the privacy page stay zoomable (low
    vision). `zoom_css.test.mjs`.
  - **The camera at Go online and Need a ride (2026-10-29, owner).** Both
    centre on you at ONE zoom, `INTENT_ZOOM = 14` in app.js (about 3 km
    across on a phone): drivers see the ✋s around them, riders the cars
    around them. Need a ride used to go to "at least 15" (a quarter of the
    area — often no car in sight). `intent_zoom_test.exs` keeps the two
    on the shared constant.
  - **No good GPS reading → nothing on.** (Since 2026-10-24, following
    web.dev "User Location".) No location prompt on open: the map starts at
    the placeholder (Manhattan) with no blue dot; location is asked for only
    on a tap (◎, GO ONLINE, ✋, Request ride, "📍 Share your location").
    A live watch runs only while `gpsNeeded` (online driver, a GO ONLINE/✋
    waiting, or a ride under way) and is cleared otherwise. A reading is
    GOOD only if its accuracy ≤ one res-9 edge (~201 m); only good readings
    place a car, a ✋ or a ride position — coarser ones (warming up, or the
    phone's approximate mode, ≥1 km) move only the blue dot. GO ONLINE/✋
    wait for the first good reading ("Finding your location… ✕", tap to
    cancel); "Finding…" after 5 s, Precise Location steps after 15 s or an
    approximate reading. Blocked (error 1) cancels a waiting tap and, mid-
    shift, stops sending (the server reaps the car in 3 min; the banner says
    why); off/no signal (2) and timeout (3) keep the last block. A ride
    that starts (a server message, no tap) or a shift resumed after a
    reload starts GPS by itself if allowed, else offers "Share your
    location". Coming back to the app retries quietly if it's allowed now.
    Ride positions and auto-arrival use only a good reading from the
    current watch, aimed only at the pin or an exact ride position.
    The logic lives in `priv/static/locator.js` (GPS, permission check and
    clock passed in; tested with fakes in `test_js/locator.test.mjs`); the
    wording rules in `sendfilter.js`. "Blocked" is said once per thing that
    needs location (a shift, a ride), not once ever. An unanswered prompt
    (Firefox "Not now" gives no callback) says "allow location when your
    browser asks", not "approximate"; an installed app gets settings steps
    (it has no web address bar).
  - **Piles.** Markers in one block sit on exactly the same point (zoom
    never separates identical points), so the app draws one marker per
    (type, spot): a visible stack of up to three icons, then +N, and a tap
    opens a list. Its names load like any rate-limited per-row data
    (`priv/static/reveal_queue.js`): only rows on screen
    (IntersectionObserver), the rows of one moment in ONE `reveal`
    `{ids}` (the DataLoader pattern, ≤ the sync burst), and on "not yet"
    one timer with the server's exact `retry_ms`, refused rows first.
    Each name still costs one allowance (a batch must not make scraping
    cheaper); the answer is `{users, unavailable, later, retry_ms}`. A tap
    on a row asks at once. Before, every row asked alone and the refused
    ones all retried on a flat 2 s, mostly refused again (a tapped ⏳ row
    opened at once — its own fresh ask fitted). Research basis: NN/G found numbered cluster icons
    confusing and lists easier than crowded pins on phones; spiderfied
    pins are small touch targets. Markers are 44 px (Apple HIG).
  - **Protocol version** in the world join reply (`v`); a long-open tab
    whose app speaks an older protocol offers "Update available".
  - An older app that sends no spot is shown at its cell; its lat/lng is
    ignored, never stored.
- **Still not covered (owner deferred):** hiding where a shift starts and
  ends (a car appearing in its home block), blocking, a photo proxy (a
  Google photo URL is a stable id, revealed on tap). A fake driver (anyone
  can go online anywhere) can still reveal the hands it watches, paced by
  the sync budget; the real wall is real accounts (Google login) and blocks.
- Tests: `role_privacy_test.exs` and `contact_privacy_test.exs` (every leak
  written FAILING first against the old code), on `Hoodride.TestClient`:
  each simulated app runs in its own process, because Phoenix.ChannelTest
  delivers every channel's pushes to the joining process and two map
  clients in one process can't be told apart. Invariant #14 (every live
  ride has its conversation). `role_privacy_fuzz_test.exs`: five apps under
  300 random steps (online/offline, hands, rides started, ended, killed and
  failed, strangers' traffic, some of it in a hex nobody watches), with
  eight laws checked after EVERY step: no forbidden-layer frame, one side
  per count, no unchanged count, every role change announced, held topics
  only of the live role, one-layer snapshots, PubSub delivering exactly what
  is held, and every marker exactly {id, cell, spot} ({id} for a
  departure: never a position, name or photo; the storm checks the same).
  `car_privacy_test.exs`: the car payload, snapshot and row, announce-on-
  change, car reveal, the ghost-✋ fix, the protocol version. Seeded; the
  seed is in any failure.
  On its own it kills every map-privacy mutant; the mailbox race and
  two-map-channels cases have their own tests. `contact_fuzz_test.exs`:
  every message checked against a small MODEL of the cold-contact rule
  (ride partner / chat or request / car on screen / hand on screen /
  out_of_view / unavailable), with the apps resyncing on a role push as the
  real app does, chats dying only as the sweeper lets them, and a
  guaranteed tour that stages every case three times (coverage never
  depends on the seed). `role_privacy_storm_test.exs`: 1,500 operations
  from 8 processes at once; sentinels whose role never changes must never
  see a forbidden layer, and every churning app settles to its live role.
  `hostile_input_test.exs`: garbage ids, topic-shaped cell names, garbage
  targets: never a crash, never a leak, never an existence oracle. Mutants:
  28 Elixir (scratchpad `mutate_privacy.exs`; `ONLY_TEST=<file>` checks one
  test file alone) + 35 JS (`mutate.mjs`, incl. resync and browse.js).

## Threat model (adversarial sweep, 2026-10-21)

**Walls that exist (all tested):** channel ownership (user/ride topics refuse
non-members), ride authority (rider-only pin, driver-only arrival, participant-only
end), payload validation everywhere (coords, real block ids — every area derived server-side, msg ≤500),
signed sessions + 1-day socket tokens (unforgeable, verified), OAuth state
anti-CSRF (tested incl. forged state), prod dev_login explicitly off, self-action
guards (message/request/ride yourself: impossible), no profile lookup by id
at all (2026-10-23: `/api/users/:id` deleted; it was session-gated but let
any logged-in user list everyone; a hand's owner is named only by `reveal`),
role-filtered map data and the cold-contact rule (see "Who receives what"),
first-action-wins atomics (no double-booking, mutation-verified).

**Abuse controls (SHIPPED 2026-10-21, parts 1-3; blocks next).**

| Limit | Budget | Where it lives | Reply when over |
|---|---|---|---|
| user-channel events | 120/min, burst 30 | **per account** (`Hoodride.RateBudget` `:events`, since 2026-10-24) | `rate_limited`; fire-and-forget updates silently dropped |
| ride-channel events | 120/min, burst 30 | per account (`:ride`) — all connections' ride channels spend one budget | same |
| world sync + `reveal` taps | 60/min, burst 20 | per account (`:sync`) | `rate_limited` + exact `retry_ms` |
| channel joins (user, map, ride) | 30/min, burst 30 | per account (`:join`, `HoodrideWeb.JoinBudget`), checked FIRST in every join | `rate_limited` + `retry_ms`; Phoenix's client retries a refused join itself |
| socket connects | 20/min, burst 20 | per account (`:connect`), checked before anything else at connect | connect refused; the client retries with backoff |
| sockets | **1 per account at CONNECT** (2026-10-24); **the device chosen last wins** (session stamps, 2026-10-25: an automatic reconnect never takes over from a newer choice) | Phoenix's per-socket topic (`id/1` = `user_socket:<id>`) | an older socket holding a user channel gets the hand-over (`session_moved`, then its channel closes it); one without is closed directly |
| a socket that never joins its user channel | closed after **10 s** (`:join_deadline_ms`) | a token per latest connect (`:socket_slots`) | plain close |
| messages, total | 30/min | per account (`Hoodride.Throttle` → Hammer) | `rate_limited` |
| messages to one person | 15/min | per pair | `rate_limited` |
| cold contact (first message OR request to someone with no conversation and no open request) | 20/hour | per account | `too_many_new_chats` |
| re-asking a driver after a decline or cancel | 60 s from the moment of the "no" (or the cancel) | per rider→driver pair | `request_cooldown` + `retry_ms` |
| user-channel sessions | **1 per account, newest wins** (also on join) | presence Registry | old app told `session_moved`, then its socket closes |
| map channels | **1 per account, the device chosen last** (2026-10-23; by stamp since 2026-11-08) | `Hoodride.WorldChannels` Registry + the sockets' stamps | an OLDER device's map join is refused (`session_moved`); an older device's map already there goes with its whole connection (a map closed under a live connection never comes back); equal or unknown stamps are left alone. "Newest map join wins" let an older device's LATE join shut down the newer device's map (server review). Without a limit, world-only sockets multiplied the per-connection sync and reveal budgets |

Design notes:
- Budgets = honest maximum × margin (a moving driver sends ~40 updates/min;
  fast chat ~10-15 msgs/min), all judgement calls — tune from real usage.
- **No hang-ups anywhere.** Refusals cost microseconds and spend nothing.
- **Flow budgets are per ACCOUNT (2026-10-24).** They lived in each channel's
  assigns (`Hoodride.Lane`), so leaving and rejoining refilled them — a probe
  got 210 syncs through in 15 ms against 60/min — and a ride channel opened
  on several connections had a budget on each. `Hoodride.RateBudget` keeps
  one row per {budget, user} in a shared ETS table (`:rate_budgets`): same
  GCRA, same limits, exact `retry_ms`. Every spend first tries `insert_new`
  (creating a row is one atomic step), else a compare-and-swap
  (`select_replace`), so two connections spending at once are both
  counted. (A "look, then insert" first spend let two first spends both
  pass: measured 164 of 500 rounds under contention; insert_new-first
  removes that window instead of racing it.) Hammer's buckets were
  rejected for this: their
  leaky/token buckets read then write (racing spends both pass) and work in
  whole seconds and whole tokens per second (30/min can't be said). Full
  allowances are dropped by the sweeper (a full one = no row). OWASP
  API4:2023 ("limit how often a single client/user can execute an
  operation") and the usual WebSocket guidance (key limits to identity, not
  the socket; cap connections per identity) are the basis.
- **One socket per account, at connect.** A client can connect and never
  join anything; newest wins used to act only on a user-channel JOIN, so
  such sockets (idle, or a script's) piled up without limit. Now connect/3
  finds the account's older sockets through Phoenix's own per-socket topic
  (it runs before the new socket subscribes) and replaces them: a real tab
  through its user channel (the hand-over, so it stops reconnecting — no
  ping-pong), an idle one by a plain close. Plus the join deadline (Socket.IO
  does the same by default; 5–10 s is the usual "identify or be closed"
  convention), which also settles two tabs loading in the same instant.
  What's left per account is one socket; the number of accounts is the
  login lockdown's job (real Google accounts instead of `dev_login`).
- **A refused ride join doesn't end the ride**: the app ends it only for
  `gone`/`not_yours` (`HoodRehydrate.rideJoinLost`); `rate_limited` is
  retried by Phoenix.
- **The login lockdown (2026-10-25)** — before anyone outside this machine
  can reach the app:
  - **Sign-in was never real.** "Continue with Google" called the dev login
    and, when it failed (prod), silently entered a FAKE demo profile. Now it
    goes to `/auth/google` everywhere but this machine (`HoodSession.loginRoute`);
    demo mode is `?demo=1` only; the unbuilt Facebook button is hidden.
  - **dev_login only from a genuinely local request**: loopback address AND a
    local host name AND no forwarding header (a tunnel forwards from
    127.0.0.1 — the address alone isn't enough). Off in prod.
  - **Sign-in tokens — Phoenix's own design (phx.gen.auth), since 2026-11-08**
    (`Hoodride.SessionTokens`; OWASP: timeouts and logout "must be enforced
    server-side"): signing in makes a random 32-byte token; the session
    cookie holds it, the `user_tokens` table its SHA-256 (one row per
    signed-in device). Valid 30 days; while the app is in use (/api/state,
    /api/socket_token) a week-old token is REPLACED (the standard's reissue),
    so you're signed out only after 30 days without opening the app — and a
    stolen copy of an old cookie dies within 30 days even while you keep
    using it. A year at most from the real sign-in (`authenticated_at`,
    carried over). Read from MEMORY (`:session_tokens`, loaded before the
    web server): no database read per request. Every change takes the
    account's lock (`:global.trans`), database first, then memory — a
    replacement can't slip in between a sign-out's two steps (race test).
    Signing in again from the same browser replaces its token (the silent
    Google refresh does, on every return). Everyone signed in once more at
    the switch (owner: 3 accounts; it removed a whole changeover layer the
    reviews kept finding races in).
  - **The sign-out bug it closed**: a connection pass made DURING a sign-out
    carried a later time than the sign-out and stayed valid for a day. A
    pass now names its sign-in (the token's SHA-256 — the cookie's own value
    never reaches page scripts); the sign-out deletes it. Checked at connect
    AND at every join (`HoodrideWeb.SessionGate`: Phoenix subscribes a
    socket to its "disconnect" only after connect/3, so a connect racing the
    sign-out could miss it) AND before every user-channel action (a ✋
    queued meanwhile left a ghost hand). The app, refused `signed_out`,
    asks the server: really signed out → the sign-in screen; else a fresh
    pass. Only Hood Ride's own JSON 401/403 reloads (not a proxy's page).
    The first failed reconnect after being connected asks for a pass at once
    (signed out elsewhere → the sign-in screen in seconds), later ones once a
    minute. A Google refresh finishing after a sign-out everywhere doesn't
    sign that device back in.
  - **Logout signs out everywhere**: every sign-in token of the account
    deleted (no sign-out record is kept since 2026-11-12: a pass names its
    sign-in, so deleting the sign-ins refuses everything — the old
    `sign_outs` denylist had no reader left, and a sign-in/delete loop
    piled its rows up; the table stays, empty, for the release before),
    every socket of the account closed (92 ms, live). One live session per
    account already, so "everywhere" is right.
    Off the map at once too (owner, 2026-10-31): the car offline (riders
    waiting on it declined, each told) and the ✋ down, before the sockets
    close — they used to stay up until the sweeper's ~5 min grace. Refused
    (409 `in_ride` / `request_waiting`) during a ride or while your own
    request waits, as deleting the account is: the app's disabled button is
    only the first guard (another tab, an old app, a tap racing an accept).
    `LogoutOfflineTest`; the `signout` journey.
  - **Requests that change something come from Hood Ride's own pages only**
    (`HoodrideWeb.CrossOrigin`, 2026-11-08 — Go's net/http
    CrossOriginProtection rule, which OWASP points to): sign out, delete
    account, agree to the Terms, save car, dev login. The browser's
    `Sec-Fetch-Site` must be `same-origin` or `none`; without it, an
    `Origin` must be the request's own scheme, host and port (hoodride.app
    behind the tunnel — `force_ssl` rewrites to https/443 — and a phone on
    home Wi-Fi alike); `null`, malformed or repeated: refused; neither:
    allowed (not a modern browser). 403 `cross_site`, a warning by kind only.
    Before, only the cookie's SameSite stood between another site and these.
    Not the CSP reports (Safari sends them with `Origin: null`; they change
    nothing). The `crosssite` journey: a hidden form on another page.
  - **Only small JSON is read** (`Plug.Parsers [:json]`, 64 KB, counted as it
    arrives — 413 past it): forms and file uploads up to 8 MB used to be read
    on any address before any limit. Delete account and save car take JSON
    only (415) and their fields from the BODY only (`HoodrideWeb.JsonBody` —
    `?confirm=DELETE` used to count whatever the body said).
  - **Socket tokens in the WebSocket protocol header** (Phoenix `auth_token`),
    not the URL: never in a proxy's access log. A TOP-LEVEL socket option —
    set inside `websocket:` Phoenix overwrote it with nil and every header
    connect was refused (caught live: ChannelTest skips the transport; now a
    test checks how the endpoint mounts it). `?token=` still works for scripts
    (the monster, fixtures), same rules. Tokens name their sign-in, live a
    day, die at sign-out; the app refetches after a failed connect.
  - **Out of the logs**: `token` (Phoenix logs every socket connect WITH its
    params at :info — prod's level; it was in the dev log) and chat `text`,
    with `lat`/`lng`.
  - **Google**: PKCE S256 with the client secret (RFC 9700 recommends it;
    Google's discovery document lists S256); the redirect URI from the
    configured URL in prod (behind HTTPS the request says http://…:4000).
  - **Per-address HTTP budget** on `/api/*` and `/auth/*` (`HoodrideWeb.HttpBudget`,
    RateBudget: 120 at once, then 1 a second — a café on one IPv4 fits): IPv4
    per address, **IPv6 per /64** (a home gets a whole /64; per address is
    dodged by rotating — CVE-2026-45364); 429 + `Retry-After` (RFC 6585). The
    client address: `HoodrideWeb.ClientIp` reads `X-Forwarded-For` RIGHT to
    left, only from `TRUSTED_PROXIES` (Plug.RewriteOn trusts the leftmost,
    which a client writes — MDN). Off in dev (the monster is one address).
  - **Signed in, the HTTP budget is per ACCOUNT** (2026-10-25): many people
    share one address (a carrier's CGNAT, a café's Wi-Fi), so a per-IP budget
    on signed-in calls punished neighbours; per address only before sign-in
    (`/auth/*`, signed-out calls — rare). The budget runs after the sign-in
    check. The socket reads its address with the same reader
    (`ClientIp.from_headers`): Phoenix dispatches sockets BEFORE the endpoint's
    plugs (`plug :socket_dispatch`), so they get `peer_data` + `x_headers`;
    Cloudflare's `X-Forwarded-For` (equal to CF-Connecting-IP, or appended)
    serves both. Prod listens on 127.0.0.1 (`BIND_IP` overrides): behind the
    tunnel, reachable only through it. Deploy: SELF_HOSTING.md (Cloudflare
    Tunnel, one server, deploy-day checks).
  - **Or on a Unix socket** (2026-10-26, `SOCKET_PATH`, e.g.
    `/run/hoodride/app.sock`; cloudflared `service: unix:<path>` in a NAMED
    tunnel's config — quick tunnels can't target a socket): no temporary
    port per connection (127.0.0.1 caps near 28k concurrent), and only who
    the file's permissions allow can connect. A socket connection has no
    address (Bandit: `{:local, ""}`), so SOCKET_PATH also puts `:local` in the
    trusted list — one setting, "socket on, trust forgotten" can't happen; an
    IP list never covers a socket peer. No usable X-Forwarded-For over the
    socket (a local curl, a broken setup; Cloudflare always sends it): ONE
    shared budget key `:no_address`, never a crash (budget_key only knew
    IPs), and a warning once per boot. 13 tests, 10 mutants. Proven on Linux
    (WSL, the prod release): no TCP listener; page/sw.js stamped; visitor
    from XFF with a forged left ignored; 121 then 429 for one visitor, 200
    for the next; one warning; WebSocket 101 (forged token 403), handshake
    keyed per visitor. Found there: a stopped app leaves the socket file,
    and the next start failed ("port 0 already in use") → **fixed by
    `HoodrideWeb.SocketFile`** at boot: a socket nobody answers on is deleted;
    one that answers (another copy) → refuse; not a socket (a mistyped path)
    or no folder → refuse, never delete. 13 tests (one `:unix_socket`, Linux
    only: `mix test --only unix_socket` in WSL), 9 mutants; live in WSL:
    restart after stop and after `kill -9`, second copy refused, a regular
    file untouched, and without the boot call the restart fails again. Quick
    tunnel (TCP 127.0.0.1): the app keyed on the real public IP Cloudflare saw
    (forged XFF ignored); 3 WebSockets 101 end to end.
  - **Deploy files** (2026-10-26, `deploy/`, steps in SELF_HOSTING.md): `hoodride.service` (own user, `/run/hoodride` fresh each start, socket
    `srwxrwx---` for the hoodride group, database folder 0700, LimitNOFILE
    1048576, ProtectSystem=strict), `cloudflared.service` (own user in the
    hoodride group — not root as Cloudflare's installer does; LimitNOFILE
    1048576 too: one socket connection per person, and a service's default
    soft limit is 1024), `setup.sh`, `deploy.sh` (health check as the
    cloudflared user, switch back on failure, keep 3), `env.example`,
    `install_beam.sh`. **Connection limits** (owner's choice: "a very high
    number"): open files and Erlang's ports (`+Q`; files aren't ports since
    OTP 21) both 1,048,576 — the kernel's per-program maximum (`fs.nr_open`)
    and systemd's ceiling; +Q reserves memory at boot, measured: 65536 → 31
    MB, 1048576 → 46 MB, 16M → 286 MB. Memory/CPU are the real ceiling. Hitting
    a limit is NOT logged by the app today (Thousand Island only emits
    `[:thousand_island, :acceptor, :emfile]`; +Q exhaustion raises "Unexpected
    error in accept"); cloudflared logs ERR and visitors get 502. `rel/`:
    and **Erlang's node
    ports on 127.0.0.1** — a default release listened on `0.0.0.0` (epmd 4369
    + the node); `RELEASE_NODE=hoodride@127.0.0.1` (the default short name
    didn't resolve to it: rpc failed). The cookie lives in the env file; the
    release's world-readable `COOKIE` is deleted on deploy. Tested under
    systemd in WSL Ubuntu 24.04: 24/24 checks, both limits at 1048576 (cloudflared reaches the
    socket, others and the admin can't; cloudflared can't read the database;
    only 127.0.0.1/::1 listeners; rpc via the env cookie; visitor IP as the
    budget key; kill -9 → restarted; stop removes the socket folder; a
    broken release → switched back; 3 releases kept), then uninstalled.
    `plug_crypto` 2.2.0 → 2.2.1 (EEF-CVE-2026-105963: secret key base in
    stack traces).
  - **A per-address budget on every WebSocket handshake** (owner's choice,
    2026-10-25, "option 3"): counted BEFORE the token is checked, every
    attempt (valid or not), IPv6 per /64, at the signed-out HTTP budget's
    numbers — 120 at once, then 1 a second (`:ws_budget`; off in dev, the
    monster is one address). Basis: OWASP's WebSocket cheat sheet (per-user
    limits first, per-IP "where user identification isn't available"), OWASP
    API4 (tune to real use: a person connects ~once per page load, so a café
    on one Wi-Fi fits), Hammer's own plug pattern; Cloudflare counts per data
    center, this one server sees every attempt. Measured first: a garbage
    token costs ~0.9 µs to refuse, a forged signature ~6.5 µs, a replayed
    revoked one a database read (~140 µs) — the budget caps all three. Rejected:
    refusing only FAILED-heavy addresses before checking (can't tell real
    neighbours from attackers without checking). The account's connect budget
    still applies after. Live: valid 101 → 6 fakes → the same valid 403 → 11 s
    later 101 (a 4-burst test setting). A mutant showed `nil >= 100` is true in
    Elixir's term order — the config test now reads the prod-side value.
  - **Open sign-up, no caps** (owner's call: if it goes viral, nobody is
    turned away); every account still needs a Google account, and keeps the
    per-account budgets.
  - **Origin**: dev checks the socket's origin against the request's own host
    (`check_origin: :conn`); prod against the configured host. Secure cookie
    in prod. `GOOGLE_SETUP.md`: Testing mode (≤100 listed accounts) for the
    friend beta; publish + domain + privacy policy to open to anyone.
  - Tests: login_lockdown_test (35), session.test (+1), 24 mutants;
    test_load/newest_wins (+5 live); Chrome: sign-in, header socket (no token in the
    URL), real Sign out, a tunnel-like dev_login refused.
- Hammer algorithm `fix_window_per_key`, chosen from its source: O(1)
  direct-key lookups, atomic counters, windows anchored at a key's first
  hit (= a cooldown). Rejected `token_bucket` (whole tokens per second
  only) and `sliding_window` (counts via a guard → full-table scan per hit).
  Accepted: up to 2x a budget across one key's window boundary.
- Newest wins (not "cap N, refuse"): refusing would lock out a reload on bad
  signal, because the old socket lingers ~60 s until its heartbeat times
  out. Kicking the old one also cleans that stale socket immediately. The app
  disconnects itself on `session_moved` (no auto-reconnect → no two devices
  kicking each other) and offers "Use here".
- **The device you chose last wins (session stamps, 2026-10-25).** Newest
  CONNECTION winning had a hole: a phone that never heard `session_moved`
  (a tunnel; or the ~1-in-18k drop the monster hunt pinned BELOW the
  server — Bandit wrote the frame, the close frame and the FIN, each `:ok`,
  and Node's WebSocket client still saw 1006 with no data) reconnected by
  itself and kicked the laptop in use. Now (`Hoodride.SessionStamp`): a
  CHOICE (page load, refresh, "Use here": `takeover=true`) gets a new stamp
  and takes over; an AUTOMATIC reconnect (and the silent update reload,
  which hands its stamp over in a one-time sessionStorage note) carries its
  tab's stamp and gets in only if no higher stamp is known — the server's
  in-memory highest-per-account since boot, or a live socket's. Otherwise
  the socket is MOVED: every join answers `session_moved`
  (`HoodrideWeb.SessionGate`, checked before the join budget, so it costs
  nothing) and the server closes it (Phoenix's client retries refused joins
  while connected). No params = an old app = a choice, as before.
  - Basis: fencing tokens (Kleppmann: "a number that increases"; the
    checker keeps the highest and refuses lower), Kafka's producer epoch
    fencing zombies, WhatsApp Web's "Use here" (taking over is a click).
  - Stamps: µs of `System.system_time`, never below last+1 (`:atomics`
    CAS). This runtime is in multi time warp mode (the OTP 26+ default,
    checked on our OTP 29), so the clock CAN step back; the guard is what
    keeps stamps rising (the hybrid-logical-clock rule).
  - The stamp lives in page memory, never in sessionStorage: "Duplicate
    tab" copies sessionStorage, and two tabs with one stamp would both pass.
  - **Known cost of no database:** a restart wipes the server's memory, so
    a zombie that reconnects BEFORE the chosen device gets in for those
    seconds — until the chosen device's higher stamp arrives and moves it.
    Telling "zombie, laptop on its way" from "the only device left" needs
    memory that survives a restart.
  - Proof: a throwaway exhaustive model checker (3 devices, every order of
    choose / drop / lost "you moved" / timeout / auto-reconnect / quiet
    reload / restart, 12 steps, 25,759 states): this rule keeps all five
    promises; newest-wins breaks "auto never kicks the chosen device"; a
    live-only tab id breaks it after a restart; stamps without the server's
    memory let a zombie in during a blip. Then session_stamp_test (19) +
    session.test.mjs (7), 18 mutants all killed, test_load/newest_wins (13 new
    checks on real sockets), and the monster's "stale tab returns" chaos (a
    replaced tab reconnects with its old stamp: must be refused, the live
    tab undisturbed). The monster counts an old tab's 1006 loss of the
    message apart (client side, proven); any other miss still fails L4.
- **The monster's L6 "missed ride_started while connected" was the test's
  own error** (hunted 2026-10-25). It took the ride's start to be the first
  moment any party heard of it; when the parties it could see were away
  (a reload or blip) and learned from `/api/state` after reconnecting, that
  moment is AFTER the reconnect, so they were judged connected at a start
  they missed. Every case had a reconnect ending 200–500 ms before. The
  monster now records each accept's send→reply window (the server starts
  the ride inside it) and judges against that; rides whose driver is a
  browser fixture (start unseen) are judged apart. Proof: the fixtures
  logged their accept times, and each such ride's accept fell in its
  rider's reconnect gap (2/2, 0 real misses); then a clean 8/8 mega run.
- Order in send_msg/request_ride: free checks (self, length), then
  reachable? (a relation, or on your screen: HoodrideWeb.Reach), then the
  budgets are LOOKED AT, then the request or message — and only once it has
  gone are they charged: a refused contact spends nothing. (Until
  2026-11-08 they were charged before the cooldown and the request's own
  refusals: Request tapped during a cooldown, or while waiting on another
  driver, used up the hour's new contacts; a message refused by the
  per-person limit used up the total. Looking and charging are two steps:
  two sessions of one account at the same instant — a hand-over — can pass
  the limit by one.) (Until 2026-10-23 a "user
  exists" check ran first and answered `no_such_user`, which told anyone,
  unthrottled, which ids are real; a missing id is now simply unreachable.) The re-request cooldown is STARTED in
  Requests when a request ends with a decline or cancel (Hammer `set`, which
  opens the window at that moment) and only READ at request time. Starting
  it at request time instead was a real bug: a driver who took >60 s to
  decline gave the rider no cooldown at all (caught in discussion; the
  slow-decline test was written failing first). Going offline (decline-all)
  starts no cooldown — an offline driver can't be requested anyway.
- Tests: 16 in abuse_limits_test (budget math with an injected clock, every
  boundary, cross-session counting, cold-contact rules both orders,
  slow-decline cooldown, newest wins written failing-first); 9 mutants all
  killed. Plus `test_load/newest_wins.mjs` (real websockets, run against a live
  server): an old client that IGNORES session_moved is still closed by the
  server, in under 1 ms, with session_moved delivered first — ChannelTest
  can't prove this (its transport is the test process), and the browser
  check can't either (the app disconnects itself).

**Deploy-day settings (no release/proxy exists yet — apply then):**
- per-IP connection limit at the reverse proxy (e.g. Caddy/nginx ~10/IP);
- web server max connections (`thousand_island_options: [num_connections:
  ...]` in prod `http:` config), sized to the box;
- raise the BEAM process limit in the release's `vm.args` (`+P 2000000`).
Each socket costs ~3 processes. Its CHANNELS are 1 per account under newest
wins (the user channel since 2026-10-21; the map channel only since
2026-10-23: before that, world-only sockets escaped it). A bare socket with
no channel joined is bounded only by the per-IP proxy limit above, so the
process-table attack needs that limit plus mass account creation, which
OAuth makes costly.

**Remaining exposures:**
- *Join bombing:* **MITIGATED (Option B):** one WorldChannel per client,
  ≤120 held subscriptions (why 120: comment on `@max_watch`), sync budget.
- *Stale app versions fighting newest wins:* a tab running an app version
  from before the `session_moved` handler auto-reconnects when kicked and
  steals the session back (seen in dev with old localhost tabs). Phones get
  the new version via the service worker, so this is mostly a dev nuisance.
  Since 2026-10-25 an open app also learns of a new build on reconnect
  (update after deploy, above) and reloads when hidden.
- *Unwanted contact from one determined person:* blocks — designed, next.
- *Inbox raids* (many accounts × one message each): per-sender limits can't
  see it; future remedy is a "message requests" folder for strangers.
- *The scraper:* any member can subscribe to all cells and harvest every
  on-duty driver's name/photo/live GPS citywide. This is the product's own
  visibility rule weaponized; mitigations if ever needed: per-socket cell
  caps, join-rate limits, visibility radius.
- *Position honesty:* drivers self-report GPS (teleporting possible) — p2p
  trust by design; ratings (deferred) are the social correction.

**Trigger for the brake family:** before any launch beyond known neighbors.

## Ephemerality (owner's call: no stored chat/trip data)

Everything live is in ETS / process state. **Every piece of state has a death rule:**

| State                     | Lives in            | Dies when |
|---------------------------|---------------------|-----------|
| GPS positions             | ETS (geo tables)    | disconnect (instant) |
| Driver availability       | ETS + Presence      | explicit GO OFFLINE (instant) or grace expiry (~5 min after socket loss) |
| Requests                  | memory              | resolution (accepted/declined/cancelled) or expiry (~5 min) — deleted, not archived |
| Active rides              | GenServer per ride  | End ride, or abandoned sweep (both silent ~30 min) |
| Conversations + messages  | ETS                 | EITHER party offline past grace (5 min, checked each minute), unless the two share a ride — the same rule that takes a car or hand off the map (owner's call 2026-10-23; until then it took BOTH gone, no open request, no ride). Both sides are told (`chat_closed`); a message sent to someone away 5+ min is lost with the chat (accepted) |
| Aggregate counts          | ETS (derived)       | recomputed each tick from fine table |
| **User accounts**         | **SQLite**          | account deletion (the only durable data; block-list joins it later) |

- "Open states are held, terminal states are deleted."
- Accepted trade-off: a server restart/deploy drops live rides & chats. Acceptable at
  neighborhood scale (deploy off-hours; both parties have chat memory + each other's dot).
- App restart on a phone is fine: server memory is the truth; client rehydrates via
  `GET /api/state` → { user, ride?, conversations, open_request?, pending_requests,
  hand?, on_map } — hand/on_map SHIPPED 2026-10-21: a reload RESUMES a raised ✋
  or an on-duty shift (previously the row was orphaned: an immortal ghost hand,
  and a ghost car until the frozen-reap; now both resume seamlessly) — and
  Phoenix channel rejoin delivers current state. Client is a mirror, not an owner.
- **A reconnect is a reload (2026-10-23).** Before, a rejoin re-synced only
  the map: after a server restart the app still showed a raised ✋ no driver
  could see (reproduced in Chrome: "Looking for a ride…" with
  `/api/state.hand == null`), a request waited forever, an online driver
  looked online without a car. Now every join of the user channel runs
  `softReload` (app.js) — the FIRST one too (2026-10-25): the page load's
  `/api/state` was fetched before the channel listened, so anything in
  between was never heard. It fetches through `HoodRehydrate.freshState`: a
  snapshot that live news (user/ride frames, `countsAsLive`) overtook
  while in flight is fetched again — applying it would wipe what the news
  showed (the mega monster: an app forgot a ride that had just started).
  One reload at a time. Then: CLEAR the
  mirror (chats, pending flags, ride + its channel and pin, hand, shift) —
  hydrate only adds what the server has, it never removes what the server
  lost — then the same `hydrate` as a page load. The map, its position, the
  socket and the map sync are kept (they resync themselves). A short wifi
  blip loses nothing, and messages sent while disconnected now appear (they
  come back from the chat history). After a restart the user gets ONE
  banner for the most important thing lost (`HoodRehydrate`, rehydrate.js:
  ride > request > hand > shift); the ride channel's refused rejoin (which
  runs first) says it for a ride. Chrome-verified across 6 restarts (hand,
  request, ride ×2, shift) and blips (hand, ride, a message missed while
  offline). A deploy still drops live rides and chats — now visibly.
- **Light reload (2026-11-08/09).** A reload or reconnect used to bring
  every chat's every message. Now the app asks for the chat LIST
  (`/api/state?chats=list`): each chat as a summary (`Chat.summary/2`) — the
  last message's preview (whole characters, at most 100 and 400 bytes) and
  the partner's message ids for unread, no texts — plus the chat on screen
  in full (`open_peer`), so a reconnect keeps your place. A chat's messages
  load when it's opened (`GET /api/chat?peer=`, your own chats only, its own
  budget, no database read): "Loading…", Send waits (it looks as always, the
  text stays), "Couldn't load messages — try again" after a failure or 20 s.
  What arrives meanwhile is held in the chat and put in place by
  `HoodChatMerge` (chatmerge.js): the answer's messages, held ones newer than
  its newest, this app's notes after what they came after. Every answer is
  for that chat OBJECT or dropped (a reload or a closed chat makes a new
  one). A chat left before it loads stays unread. Without `chats=list` the
  server answers in full, as before (older app copies, a rollback). Journeys:
  lightreload.mjs, lightreload2.mjs.
- Conversations are created on **first message**, not on opening a chat window
  (no empty-chat rows — bug found and fixed in the mock, applies to backend too),
  or at **ride start** (2026-10-23), empty, so the ride's own chat is a
  relationship from its first second (see "Who receives what").

## Presence & disconnect grace

**Never equate socket-drop with "person left."** Mobile kills sockets constantly
(app switch, screen lock, and the driver's main legit activity: Google Maps navigation).

- Socket drops → start grace timer, state unchanged, marker goes honest-stale
  ("last seen Xm ago"). Reconnect cancels silently.
- Grace tiers:
  - Browse availability: stale immediately, removed from map after ~5 min no reconnect.
  - Active ride: NEVER auto-offline mid-ride. Only the abandoned-ride sweep (~30 min
    of both-silent) ends it. Going offline stops new demand, never an active ride.
  - Conversations: survive disconnects entirely; cleaned only by the empty-room rule above.
- Law: **state changes from absence of signal are slow and forgiving; state changes from
  explicit action are instant.**
- Phoenix Presence provides join/leave/heartbeat detection; we add only the grace policy.

## The sweeper

**Presence is DERIVED, not stored (SHIPPED 2026-10-21):** "online" means "a live
user channel exists right now", answered by a duplicate-key Registry that channel
processes register into at join — the Registry cannot lie, because dead processes
(clean close, crash, dirty socket death) vanish from it automatically. The stored
presence row only supplies the grace clock once no channel remains. The prior
last-writer design fell to two proven races (presence_proof_test was born failing):
a spare tab closing overwrote :online for a still-connected user, and a dirty
reload's heartbeat-timeout terminate landed after the new tab's join. Same lesson
as cookie-vs-bans: signatures/events carry claims; live questions need live sources.

A GenServer that wakes every ~60s, scans ETS, enforces every time-based death rule
**and reconciles race residue** (SHIPPED 2026-10-21): each heal restores its
invariant within one tick, with normal notices (losing cars decline their waiters).

**GeoWriter (SHIPPED 2026-10-21): the single serialized writer.** Every multi-table
geo mutation (driver_update / hand_up / hand_down / driver_offline / reindex)
funnels through one GenServer, making the cross-table checks atomic:
car+hand races, mid-ride ghosts (ride check runs INSIDE the serialized section)
and altitude orphans are now *impossible* per user, not just healed.
**CAS reconciler (SHIPPED 2026-10-21):** the recompute heals per-cell via atomic
compare-and-swap — it writes a cell ONLY if the row is provably unchanged since
its snapshot; any concurrent shift makes the CAS refuse and the cell heals at
its first quiet tick. Clobbering a live arrival is impossible by construction
(two prior designs fell to this race: snapshot-overwrite clobbered directly,
found by asking "can the counter go negative?"; diff-apply mis-measured when a
shift landed between its two snapshot reads — caught by the reconciler-duel
test, 50 short rounds of point-blank heals vs. a toggling driver).
**Torn reads: seqlock (2026-10-21) → REPLACED by pause-and-recount
(2026-10-22).** Even CAS couldn't see a TORN two-table read (parents written,
count not yet shifted — a nanosecond gap scheduler load can stretch; the
"1-in-20 flaky test" was the duel catching a real double count). The first
fix was a seqlock: one global version bumped entering and leaving every write,
the recount trusting only two identical EVEN reads (plus a 5 s time-lease
rescue for a counter wedged odd by a dead writer).
*Why it was replaced:*
- **It was unsound with sharded writers.** A seqlock requires writers to
  be serialized: the Linux kernel docs say the raw counter "does not protect
  against multiple writers" and must be paired with a writer lock; FreeBSD's
  `seqc(9)` allows "zero or one writer". Our 8 GeoWriter shards shared one
  counter with no lock, so two writers mid-op left it EVEN. Proof test, born
  failing: two entered writers plus the torn moment made the recount count
  one driver as two.
- **It starves under load.** Every driver position update bumped the
  version, even same-cell ones that change no count. At 10k drivers a clean
  snapshot window would almost never occur (FreeBSD's seqc(9) warns readers
  can starve under frequent writes).

*Now (the kernel's locking-reader form, `read_seqlock_excl`):*
`Geo.recompute_aggregates` (run by the sweeper, in the caller, never inside a
shard) pauses every shard via `Geo.with_writers_held`:
- It sends each shard a `{:hold, ...}` message. A GenServer handles one
  message at a time, so a shard can only pause BETWEEN ops: the op before
  has fully finished, and the ops after wait in its mailbox.
- Once all 8 reply "held", it copies the parents and tally tables and
  deletes altitude orphans (a parents row with no map row: crash residue),
  then releases the shards.
- The tally arithmetic and heals run after the release. Heals stay per-cell
  CAS, so a shift landing since makes a heal refuse, never clobber.

Safety:
- **A cap on how long the map can stall.** `@max_pause_ms` is 250. Each
  shard frees itself on release, on the holder's death (monitor), or at the
  cap. The holder trusts its copy only if the time since it SENT the holds
  is still under the cap (every shard's own timer started later), and the
  shard pids are unchanged (a restarted shard's fresh process was never
  held). Otherwise the result is `:skipped` and the next tick retries.
- **One recount at a time,** via `:global.trans`: two holders each pausing
  half the shards would only wait each other out.

The seqlock, `:geo_version`, every version bump and the lease rescue are
deleted.

Measured pause (bench/recount_pause_bench.exs, 8 schedulers): 0.6 ms at 1k
people, 4 ms at 10k, 28 ms at 50k. Map writes are delayed by that much, once
a minute.

Tests:
- The torn moment with a suspended (mid-op) shard: the recount must skip,
  then count once.
- Writes during a pause queue and apply in order.
- Prompt release; release on holder death; release at the cap for a wedged
  holder.
- A pause past its cap is discarded; a shard restarted mid-pause voids the
  pause.
- Orphan pruning; the sweeper ignoring a late reply.
- The duel and the storm: 20/20 repeat runs clean.
- Ten mutants, one per safety piece, all killed.

**Batched recount (SHIPPED 2026-10-23), replacing the single pause.** The
single pause grew with the world (27.6 ms at 50k). Now: many short pauses,
one batch of hexes each.

*How it works:*
- **`:geo_members`** `{{parent_cell, user_id}, role}` is the parents table
  keyed by cell (ordered_set).
  - It is written only by `set_parents/5`, the single place a parents row
    changes. There the row, the count shift and the membership rows move
    together, inside the user's own shard.
  - An unchanged role and cells (the common position update) write nothing,
    and cell lists are deduplicated on write.
- **Each pause** counts its hexes in place (`select_count` over each hex's
  key range, nothing copied), reads the stored counts, releases, then heals
  by per-cell CAS. A value CAS is sound because each batch's read is
  consistent.
- **If a pause can't be taken** (a writer stuck mid-op), the recount stops
  for that sweep.
- **Orphans** are removed through the user's OWN shard (row, membership and
  count together).
- **The sweeper runs `member_drift`** (index → parents pass plus an
  equal-count proof, like `cell_index_drift`) and per-user
  `rebuild_members` BEFORE the recount, because the recount trusts
  membership.
- **Holds are sent as PRIORITY messages** (OTP 28+, EEP 76): each GeoWriter
  creates `alias([priority])` at init, published in `:geo_writer_aliases`.

*Batch sizing — the safeguarded EWMA at a 250 µs target:*
- Predict the batch as target ÷ smoothed per-hex cost. This is
  pt-table-checksum's `--chunk-time` sizing; the EWMA estimator is the one
  TCP uses for RTT (RFC 6298).
- Never more than double the last batch (Percona's production lesson:
  unbounded growth once overloaded a cluster).
- The clock stops each pause at the target regardless.
- **Proven bound:** every pause is ≤ target + one hex. Every pause but the
  last does ≥ target of counting, so for total work W it takes ≤ W/target + 1
  pauses: within ONE pause of any algorithm (even a clairvoyant one) with
  the same per-pause cap. That is the standard greedy argument. Plain EWMA
  has no such bound.
- **The target is a requirement, not a law:**
  - Metronome uses 500 µs slices; ZGC targets < 1 ms; pt-table-checksum
    0.5 s.
  - Measured: 150–500 µs is a flat plateau, 250 the steadiest.
  - Writers take ~0.1–0.3 ms just to stop, so far smaller targets only
    multiply pauses.

*How it was chosen — all on a faithful model (`test/support/recount_model*.ex`,
38 tests incl. a writer stopped mid-op, crashes, orphans, duel, storm; same
writer code for every mode):*
- **Single pause vs versioned vs hybrid vs batched:**
  - versioned (Silo-style per-row stamps, optimistic, no pause) costs
    2.3–2.8× the recount time and 3× the memory, +17% per crossing, and
    STARVES the big cells under load (0/50 healed);
  - hybrid (optimistic, then pause) paused 10/10 at 50k anyway;
  - batched won on pause length and healing.
- **ABA bug found in the textbook versioned design** (storm 4/100 failures):
  a user passing THROUGH a cell inside the read window, then a newcomer,
  fools a value CAS. Proven by a deterministic hook test; fixed the Silo
  way (count rows carry a monotonic version, CAS on the version). Our pause
  designs can't have it: their reads are consistent.
- **Batch-size sweep** (`bench/batch_sweep_bench.exs`, realistic load at 50k,
  interleaved): every size 1–30 step 1 plus a coarse sweep to "all". Best
  fixed size 5–7, but world-specific.
- **Nine sizing rules compared:** fixed, clock budget, EWMA, safeguarded
  EWMA, AIMD, self-tuning (counting time = stop cost, my derivation — it
  LOST: 1,200+ pauses, slowest recount).
  - Safeguarded EWMA 250 µs: the steadiest across 3 runs — p99 0.51 ms
    every run, p99.9 1.2–1.6 ms, worst writer delay 2.7–3.8 ms.
  - The single pause: writers' p99.9 30–70 ms.
- **Priority holds:** no difference under realistic load (mailboxes almost
  empty — the ~1 ms "floor" was scheduling and the counting target, not
  queueing). Under a FLOOD (400 unpaced writers, queues 0–380):
  - 2–8× less waiting for writers;
  - 35–45% faster recounts;
  - batched pauses 9–14 ms vs 61–109 ms for the single pause.
  Kept.
- **High process priority:** rejected. It halves the recount's own wait but
  made users' p99 up to 4× worse (starvation, as the docs warn).

*Measured in the app* (`bench/recount_pause_bench.exs`, quiet machine, two
runs):

| People | Longest pause, old → new | Whole recount, old → new |
|---|---|---|
| 1k | 0.6 → **0.41 ms** | 2.5 → 6.5–7.4 ms |
| 10k | 4.0 → **0.61 ms** | 16 → 28–29 ms |
| 50k | 27.6 → **0.82 ms** | 80 → 70–72 ms |

- 15–198 pauses per recount.
- Writer cost: ~15 µs per crossing, ~4 µs per same-cell update (inside the
  shard). There is no pre-change measurement for comparison; the model
  predicted +55% per crossing.
- A disturbed first run read 4× worse on everything, writer cost included.
  The adaptive sizing learns from what it measures, so a noisy machine means
  smaller batches.

*Measured in the app under LIVE traffic* (`bench/recount_live_bench.exs`, two
runs). Every driver goes through the real write path; 8 paced writers send a
crossing per driver every ~2 min and a position every 5 s; there are 10
recounts 300 ms apart; then drift is planted in all 100 big hexes and one
recount runs under traffic.

| | 10k drivers | 50k drivers |
|---|---|---|
| longest pause per recount, median / worst | 1.0–1.3 / 5.1–5.8 ms | 1.3–1.5 / 6.4–6.5 ms |
| pauses per recount | 185–213 | 397–447 |
| whole recount | 90–100 ms | 165–213 ms |
| writer p99, no recount → recounting | 1.0 → 1.2–1.3 ms | 0.72 → 1.0–1.1 ms |
| writer p99.9, no recount → recounting | 5.4–9.6 → 5.2–5.4 ms | 1.4–2.8 → 2.5–2.6 ms |
| big hexes fixed by ONE recount | 100/100 | 100/100 |

- **Recounts barely touch writers:** p99 rises 0.2–0.4 ms; p99.9 stays
  within the no-recount noise of this desktop.
- **Under traffic the sizing takes 2–3× more, smaller batches** (hexes count
  slower while writers are busy). The whole recount grows but each pause
  stays ~1 ms: the trade the design is meant to make.
- **One 31.6 ms max writer update** (50k, run 2) in ~54k updates, not
  repeated. That recount's own longest pause was 6.35 ms, so it was most
  likely machine noise.
- **For contrast**, the single pause in the model under the same load:
  32–68 ms pauses, writer p99.9 30–70 ms, 53–86/100 big hexes fixed.
- **Not yet measured:** the total time paused per recount (estimated
  ~100–200 ms at 50k, in ~1 ms slices). It belongs in the planned
  sweep-timing telemetry on the production server, where the number is
  meaningful.

*Tests* (`batched_recount_test.exs` plus the aggregate, storm and fuzzer
suites):
- membership through join, crossing, mode flip, hand down and offline;
- deduplicated cells;
- a same-cell update writes no parents, membership or counts (traced ETS
  calls, non-vacuous);
- 350 hexes over many pauses;
- a stuck writer stops the recount after ONE pause;
- the hold jumps 3,000 queued messages (answered with > 2,500 still
  waiting);
- the growth cap (first batch ≤ 2 under a huge prediction);
- the clock check (no batch takes 3,000 hexes);
- drift: missing, stray, wrong-role and wrong-cell rows, plus a lone missing
  row caught by the count;
- the sweep repairs, then recounts;
- invariant #13 (membership ≡ parents) after every fuzzer op and at storm
  quiesce;
- 20/20 repeat runs clean.

Mutants: 14 killed, 2 equivalent:
- a role change not re-filed: a role change always passes through "no role"
  first (mode flips go offline first);
- the orphan check ignoring role: the shard's prune re-checks.

Decrements
also floor at 0 (ETS threshold form) and the client never renders count ≤ 0 —
belt and suspenders against any impossible number reaching pixels. Reads stay
direct-ETS and parallel. Cost: µs-scale ETS work per op, ~99% idle at 1k drivers.
**SHARDED (SHIPPED 2026-10-21):** PartitionSupervisor runs one writer per
scheduler, routed by user id — same user ⇒ same shard ⇒ same-account ops stay
strictly serialized (the only atomicity the races needed) while throughput
scales with cores. Cross-shard same-hex safety: shift_agg's emptied-cell delete
is an atomic compare-and-delete (select_delete on {cell,0,0}), so a concurrent
increment from another shard can never be lost. The sweeper heals REMAIN as the
unconditional repair layer: cross-system races (a create racing a driver_offline
lives outside the writer's walls → heal_unlawful_requests), crashes, future bugs.
Proven by the concurrency storm test: 24 parallel processes × 40 racing ops →
geo invariants (5–8) hold at quiesce BEFORE any sweep; one sweep → all 8 hold
(invariants shared with the sequential fuzzer via TestHelpers — one world-law).
(request expiry, abandoned rides, empty-room chat cleanup, count reconciliation), sleeps.
~40 lines. Supervised → restarts on crash, resumes next tick.

- **Naive first (decided):** full scan each tick. At hood scale: sub-ms. Honest math:
  at 100k entries with per-entry presence lookups it's ~0.5–1 s/sweep — still fine
  (own process, BEAM preemption, nothing blocks), but at that scale upgrade to a
  deadline-indexed `ordered_set` (sweep only what's due) or per-conversation
  self-deleting processes. Known, mechanical, later.

## Geo discovery: H3 cells (decided: cell-shaped from day one, real implementation)

- **Res 8** (~0.7 km² hexes) is the marker/hailing resolution.
- Client (`h3-js`): computes viewport cells and sends its COMPLETE wanted
  set as ONE `sync` message (`{"geo": [...], "agg": [...]}`) to its single
  `world` channel (Option B, SHIPPED 2026-10-21). The WorldChannel holds the
  client's watched topics as Phoenix.PubSub
  registry entries and RECONCILES each sync against what it holds: cap
  checked on the wanted set first (over 120 → `watch_limit`, nothing
  changes), unsubscribe dropped cells, subscribe new ones (never twice),
  snapshot only the new cells after subscribing, forward every watched
  broadcast down the wire. Same set twice = no-op. Since 2026-10-23 the
  topics are per LAYER (`geo:d:`/`geo:h:`/`agg:d:`/`agg:h:` + cell) and the
  user's server-derived role picks which layer a wished cell maps to (see
  "Who receives what").
- **Why full sets, not diffs (desync fix, 2026-10-21).** The first version
  sent diffs and the client tracked what the server held; a refused or lost
  sync left the two out of step permanently (reproduced in the browser:
  after a `rate_limited` refusal, home stayed blank until reload). Now the
  client keeps NO record of server state, so there is nothing to drift — the
  next sync to land carries the whole truth. Level-triggered reconciliation
  (Kubernetes controllers; full-set re-subscribe in Socket.io, Photon Fusion
  interest cells, geOps vehicle maps); diff/CRDT protocols only pay off for
  large state, ours is ≤120 short ids. Client scheduler: 250 ms settle, one
  sync in flight with latest-wins follow-up, `rate_limited` → retry at the
  server's exact `retry_ms`, timeout/error → backoff 1 s→30 s, (re)join →
  immediate sync, 60 s safety resync; snapshots/updates for cells no longer
  wanted are ignored. Verified in Chrome: the old repro heals in ~1.1 s,
  40 frantic moves → 1 sync, no ghosts, network drop → back in ~150 ms.
- **View margin = PADDED RECTANGLE with hysteresis (SHIPPED 2026-10-21,
  replaced the first "visible cells + gridDisk ring" version).** The client
  watches every cell touching a rectangle ~one cell width (√3 × average edge
  of the tier's resolution) larger than the screen on each side, at the
  marker tier and the count tiers, and remembers that rectangle + zoom
  (`plannedArea`). On each map move:
  - screen still inside the remembered rectangle AND same zoom → **no work
    at all** (4 comparisons, ~0 ms). Safe by the definition of overlap: any
    cell touching the screen touches a rectangle containing the screen, so
    it is already watched — no hex geometry, edge lengths or distortion
    assumed (H3 cell areas vary ~2× within a resolution, edge lengths at
    res 7–8 are extrapolated; a ring-based skip would have depended on them);
  - otherwise (left the rectangle, any zoom change, ride end) → recompute.
  Exact rectangle comparison relies on the map being flat and north-up
  (`maxPitch: 0`, rotation disabled in `initMap`); resizes and phone rotation
  fire `moveend` (tested), so a wider screen is always re-checked.
  **Choosing the level (2026-10-21, final):** ONE budget,
  `MAX_WATCHED_CELLS = 110` (app.js), on what is actually watched (screen +
  padding). Pick the finest ladder level whose padded rectangle is
  ESTIMATED (area ÷ `getHexagonAreaAvg`) to fit, list it once, and step one
  level coarser only if the EXACT count exceeds 110. The estimate only
  steers which level gets listed; the exact check guarantees the cap. This
  is the standard level-of-detail pattern — choose the level from a cheap
  scale measure, then load it (deck.gl TileLayer: target `tileSize`; Cesium
  3D Tiles: screen-space error; CARTO's H3 layer: zoom → resolution) — and
  it replaced an earlier two-budget version (80 visible / 110 padded) whose
  call order was steered by a tuned `MAX_CELLS / 2` threshold. Measured on
  the same 1,000 screens: old p95 8.8 ms → 5.4 ms, 1.04 H3 listings per
  recompute, no tuned thresholds left. Markers → counts on desktop at
  ~zoom 13.3–13.5 (was 13.2), coarse counts from ~11.75, floor at ~9.
  Same-zoom pans keep their tier (hysteresis); because the tier now comes
  from area, not position, that almost never differs from a fresh choice.
  **Verified (6,000 random moves: 2 desktop seeds + phone 390×844):** visible
  cells missed 0 (incl. on every skipped move), never > 110, recompute tier
  ≠ independent fresh computation 0 times; ~70% of moves skipped at ~0 ms;
  recomputes median 3.3–3.5 ms, p95 6.4–7.0 ms, p99 8.4–9.4 ms.
  Real app: car + hand at zoom 18; small pans 0 syncs, big pan 1; floor 0;
  desync repro heals in ~1.1 s; ghost ignored; ride clears and restores the
  plan; zero console errors.
  **Why:** fewer syncs (and fewer snapshots) for everyday small pans, and
  no pop-in at the edges — cars just off-screen are already loaded.
  **Cost:** ~30–100% more cells watched, so the phone also receives updates
  for cars just out of view (bounded by the 110 ceiling).
  **Prior art (researched 2026-10-21):** geOps realtime vehicle-map API
  ("a bounding box bigger than what the user actually sees", resend only
  when the view leaves it, to reduce communication load); Leaflet
  `keepBuffer` (2 rows/columns of tiles kept around the view, default) and
  `updateWhenIdle` (mobile loads only when panning ends — same idea as our
  250 ms settle); Bing Maps `SetTileBuffer` (rings of tiles outside the
  view); Flet pan buffer ("typically 0 or 1", warns larger hurts
  performance); Mirror hex spatial hashing (vis range ~10% beyond the camera
  so objects spawn just before they're visible); MMO interest-management
  hysteresis (subscribe at one range, unsubscribe at a larger one, so edge
  objects don't flicker). All agree: small margin, two boundaries.
  For the padded-rectangle skip specifically: geOps (resend only when the
  view leaves the bigger box), Leaflet `keepBuffer`, OpenLayers
  `renderBuffer` (100 px around the view; `updateWhileInteracting: false`).
  deck.gl/CARTO's H3 tile layer hit the same centre-containment problem
  ("tiles vanish prematurely") and oversamples; h3o-wasm (Rust→WASM) is
  experimental and "might be slower than h3-js", and h3-js is plain
  Emscripten JS (no WASM) — so fewer H3 calls, not a faster engine, is the
  available speed-up.
- **Browser sweep 2026-10-21 — verified:** floor + mid-ride pans send 0
  syncs (fixed a regression where every pan resent an identical empty
  set); ride tears down / rebuilds the browse layer; request-cooldown and
  too-many-new-chats banners show the right text in the real UI; 60 s
  safety resync heals a server wiped behind the app's back (~22 s, next
  tick); timeouts back off 1.1 s → 2.1 s then succeed; ghost filter for
  car/hand/count; live count updates 1→2→1; newest wins with two real tabs
  + "Use here" click; phone-size cell counts (390×844) well under limits.
- **Two pre-existing bugs found by the sweep — FIXED 2026-10-21:**
  1. *Street-level zoom showed nothing.* Plain `polygonToCells` counts a
     cell only if its CENTRE is in view ("containment is determined by
     centroids", H3 docs); zoomed in, the view often contains no centre →
     0 cells watched → empty map with a car mid-screen (old code: 278/1000
     random screens empty, 159/173 at z17; reproduced at z18).
     **Fix:** `viewportCellsAt` uses `polygonToCellsExperimental(…,
     containmentOverlapping)`. H3 source (polyfill.c) includes a cell if its
     centre is inside, the polygon's first vertex lies in it (screen inside
     one cell), or their boundaries cross — every overlap case. Fallback if
     it ever throws/is missing: centres + cells under corners and centre
     (StarRocks ships the same pinned-4.5.0-plus-fallback pattern).
     Verified before switching, 1000 random phone/desktop screens z12–18:
     never empty; ⊇ old result; contains the centre cell; all 441 grid
     sample points covered; no non-touching cells; old/new versions agree
     on centre mode. Cost: median 1.5–4.6 ms, p95 ≤ 7.5 ms per call (fixed
     per-call overhead of H3's compact walk — ClickHouse measured the same),
     one call per settled map move.
  2. *Zoomed-out freeze.* Listing every cell THEN checking the budget cost
     ×4 per zoom level out (z9 287 ms, z8.3 867 ms, z5 over a minute) per
     map move. **Fix:** estimate first — spherical screen area ÷
     `getHexagonAreaAvg(res)`; a rung estimated > 2× budget is skipped
     unlisted (area estimate is a lower bound on the overlap count: 101
     sampled skip decisions, 0 wrong). Now z8 0.1 ms, z5 0.2 ms, worst
     8.6 ms (z12).
  Side effect (expected): edge cells now count, so markers → counts moved
  slightly earlier at the time (~z13.2 instead of ~z13.0 on desktop). The
  separate 80-cell screen budget has since been removed — see "Choosing the
  level" above for the single 110 budget.
- **Viewport logic lives in `priv/static/viewport.js` (2026-10-21)** — pure
  functions (`planWatch`, `cellsInRect`, `padRect`, `estimatedCells`,
  `rectContains`), `h3` passed in, loaded by the browser as `HoodViewport`
  and by Node as a module. **`test_js/viewport.test.mjs`** (Node's built-in
  runner, no npm deps; part of `mix precommit`, a failure fails precommit)
  runs it against the same pinned `h3-js.umd.js`: NYC coverage, wrapped
  world copies, the 180° line, street zoom on 300 random phone/desktop
  screens with a 21×21 point grid, budget at zooms 3–18.5, three 2,000-move
  random walks replaying the app's skip rule against H3's exact answer, the
  overlap-mode-throws fallback, and the zoomed-out world. 5 mutants (no
  padding, skip always true, centre containment, no budget, no wraparound)
  all fail the suite. ~5 s.
- **Sync scheduler lives in `priv/static/sync.js` (2026-10-21)** — the
  "Humble Object" split (Meszaros, *xUnit Test Patterns*; Fowler's bliki):
  every rule (full wanted sets, change check, 250 ms settle, one sync in
  flight with latest-wins follow-up, retry at `retry_ms` + 50 ms slack,
  backoff 1→30 s reset on success, immediate sync on (re)join, 60 s safety
  resync, replies filtered to cells still wanted) is in `createWorldSync`,
  with the channel and timers injected; `app.js` keeps only glue (markers,
  counts layer, channel events). Injected timers rather than Node's
  `mock.timers` (described as experimental; can't intercept destructured
  imports). **`test_js/sync.test.mjs`** — 14 tests on a manual clock and
  fake channel, incl. the original desync repro and a 300-run chaos test
  (random wishes, refusals, lost replies with/without server apply,
  disconnects) that must always converge to server = wish. 10 mutants all
  caught. **Bug found by the suite and fixed:** the 60 s safety resync
  fired during a 30 s backoff wait (sending ~1 s early, defeating the
  backoff); it now stays quiet while a retry is scheduled.
  **Retry & timing policy (2026-10-21).** Phoenix's JS client has fixed
  retry tables and NO jitter (source: `socket.js` reconnect
  `[10…2000][tries-1] || 5000`, rejoin `[1000,2000,5000][tries-1] || 10000`,
  no `Math.random`), so after a deploy every phone would retry in
  lockstep. Now, all in `sync.js`:
  | Timer | Policy |
  |---|---|
  | socket reconnect / channel rejoin (`reconnectAfterMs`/`rejoinAfterMs`) | full jitter: rand·min(10 s, 1 s·2^(attempt−1)) |
  | sync retry after timeout/unknown error | full jitter, cap 30 s, reset on success |
  | `rate_limited` | `retry_ms` + 50 ms + rand·250 ms — never earlier |
  | permanent refusals (`watch_limit`, `read_only`) | not retried until the wish changes; retried once per rejoin |
  | driver/ride position heartbeat | 20 s ±20% (16–24 s, far inside the 3 min reap) |
  | safety resync | 60 s ±20%, rescheduled each run |
  Sources: AWS "Exponential Backoff And Jitter" (full jitter; no-jitter
  backoff "the clear loser"), Brooker 2022 (jitter smooths spikes; needs a
  retry policy — ours: server sync budget 60/min, one sync in flight, capped
  backoff), Google SRE ch. 22 (randomized exponential backoff; don't retry
  permanent errors; don't nest retry layers — ours are sequential: a sync
  retries only while joined, a channel rejoins only while connected),
  Retry-After guidance (honour as a floor + small jitter). The ±20% on the
  heartbeat and safety resync is a judgement call, not a standard: SCTP
  (RFC 9260 §8.3) jitters only the ~1 s RTO part of its 30 s heartbeat
  (≈ ±2% effective) — an earlier note here wrongly said "SCTP ±50%". Any
  ~10–50% meets our needs (spread fast, stay far inside the 3 min reap,
  keep the average). Verified in Phoenix's source that our functions are called fresh
  per attempt (counting from 1), reset on open, and that channels use the
  socket's `rejoinAfterMs`. Tests: 21 scheduler tests (ranges, caps,
  first-attempt, permanent refusals) + 19 mutants all caught; Chrome: 200
  draws per attempt in range, 5 back-to-back drops reconnect in 0.15–0.8 s.
  **Position send rule lives in `priv/static/sendfilter.js` (2026-10-21)** —
  distance filter (15 m browse / 10 m ride) + cell/parent change + jittered
  heartbeat (16–24 s), plus the reload seed and the haversine `metersBetween`
  the whole app uses. `test_js/sendfilter.test.mjs` (11 tests): wobble
  swallowed, 15 m N/S **and E/W**, cell and parent changes, heartbeat due at
  its drawn time, 5,000 draws in range, a simulated 10-minute parked driver
  never silent long enough for the server's 3-minute reap, reload seed,
  ride threshold. 7 mutants caught — one (dropping the longitude term of
  the distance) first SURVIVED because every test moved north; east–west
  cases were added. Chrome: a parked online driver heartbeats at 22.3 s and
  18.0 s gaps; ride positions too. JS suites: 42 tests, 26 mutants.
  **Known web-app limitation (accepted 2026-10-21, owner's call):** mobile
  browsers pause geolocation when the app leaves the screen — e.g. the
  driver taps 🧭 (opens Google Maps directions in a new tab). The ride
  survives (rides end as abandoned only after BOTH sides are silent 30 min;
  drivers are off the browse map mid-ride, so the 3 min frozen reap doesn't
  apply), and the app catches up the moment it's visible again (Phoenix
  reconnects on visibility; the next 1.5 s tick sends the overdue
  heartbeat). Two UX gaps left as-is: (1) the peer's marker/banner freeze
  with no "location paused" indication; (2) a party who reopens the app
  mid-ride sees no peer marker until the next update, because the ride
  process doesn't keep last positions. Ready design if wanted later: stale
  after ~36 s without an update (1.5 × the 24 s max heartbeat), banner
  "· location paused N min ago" + greyed marker, receiver's own clock;
  ride process stores last pos + time per party and returns the peer's in
  the join reply. Speed-scaled send cadence was also considered and
  skipped: no marker animation, and updates stop in the background anyway.
  **PubSub subscription layout — `group_by: :key` (owner's choice, 2026-10-22).**
  Phoenix.PubSub keeps subscriptions in an Elixir `Registry`, split into
  partitions (default ceil(cores/4): 1 on a small VPS, 2 on the 8-core dev
  box; each partition = its own ETS tables + one cleanup process linked to
  its subscribers). Two layouts:
  - default `:pid` — partition chosen by subscriber; `duplicate_bag` hash
    table (fixed lock striping). Adds O(1); removing from a cell scans that
    cell's watchers, O(k); a broadcast checks every partition, O(P + k);
    a disconnect's rows all sit in one partition.
  - `:key` (Elixir 1.19+, phoenix_pubsub 2.3+) — partition chosen by topic;
    `ordered_set` with write_concurrency = a contention-adapting tree (CA
    tree; Sagonas & Winblad, Uppsala; in ETS since OTP 22): AVL trees under
    a routing layer that splits/merges locks where contention appears.
    Every add/remove O(log n); a broadcast reads one partition, O(log n + k);
    a disconnect's rows are scattered over all partitions.
  Measured (`bench/pubsub_layout_bench.exs`, `bench/pubsub_stress_bench.exs`:
  1,000 simulated phones × 80 cells, mixed load ~10k pans/s, disconnect/
  reconnect storms, a "stadium" cell with every phone, 1–16 partitions):
  for sparse cells (4–16 watchers) on small servers the default was faster
  at broadcasts (~1.5× throughput under load), pans and mass disconnects
  (1.4–2.6×); `:key` was 2–5× faster at leaving a crowded cell and overtook
  on broadcast throughput at 16 partitions. All differences are µs per
  operation (~0.1–0.2 s for 1,000 simultaneous disconnects). Chosen for
  predictable behaviour as users concentrate (at ~10k users in one city a
  busy cell has hundreds of watchers, the O(k) case). Note `write_concurrency:
  :auto` wouldn't fix the default's crowded-cell cost: one cell = one key =
  one bucket and lock, and the O(k) scan is independent of locking.
  **To switch back:** swap the two marked lines in `application.ex`
  (no data to migrate; takes effect on restart). Before a large launch,
  rerun the stress benchmark on the production machine at realistic scale.
  Community experience with `:key` was nil at the time (option released
  Aug 2026; no published benchmarks), so our own numbers are the evidence.
  **`mix precommit` now needs Node 22+ on PATH** (it runs
  `node --test "test_js/*.test.mjs"`; no npm packages). The `app.js` glue
  (marker/counts hooks, channel event filters, join order) is deliberately
  thin and verified in Chrome, not by saved tests — automating it would
  need a browser runner (e.g. Playwright, ~150 MB download).
  The zoomed-out viewport test now asserts ZERO cell listings instead of a
  wall-clock limit (timing assertions flake under load; counting is
  deterministic — cf. Rust perf's instruction counts).
- **Wraparound bug — FIXED 2026-10-21 (pre-existing).** MapLibre longitudes
  are continuous (pan around the globe and NYC reads −434 or 286); H3 needs
  −180…180 and can't take a polygon spanning 180° (H3 `polygonAlgos.h`;
  deck.gl's CARTO H3 layer splits wide boxes for the same reason). Before:
  NYC on a neighbouring world copy watched 0 cells (empty map, "zoom in"
  floor), and screens straddling 180° missed the far side. `cellsInRect`
  now shifts the rect into range and splits it at 180°; the skip check
  keeps using MapLibre's continuous longitudes, which stay self-consistent.
  Tests written first and failed (wrapped copy: different cells; straddle:
  11 visible cells unwatched). Verified in Chrome: NYC at lng −434 watches
  the same 63 cells and draws the car correctly.
- **h3-js pinned at 4.5.0** (`priv/static/h3-js.umd.js`, 216,070 bytes,
  Apache-2.0, no deps). Taken from the official npm tarball
  `registry.npmjs.org/h3-js/-/h3-js-4.5.0.tgz`, verified against npm's
  integrity `sha512-uKmdPc+DuarnR+XqZxEuWOMw7KzzKROrx3MLeJpFnMOs78S9M5eZ+X5RieS9UcSFQqbeXzbfWuX/W9Pyajinqw==`
  before use. Don't bump casually: `polygonToCellsExperimental` is still
  labelled experimental upstream — revalidate (the 1000-screen check) on
  any upgrade. Sources: H3 region docs, H3 polyfill-modes RFC, polyfill.c,
  h3-js CHANGELOG, StarRocks PR #80396, ClickHouse PR #123911, h3-go PR #151.
- **Cell index (SHIPPED 2026-10-21).** `:geo_by_cell`, an ETS `ordered_set`
  (now `write_concurrency: :auto`, like every table) keyed `{cell, user_id}` → `:driver | :hand`, one
  row per membership. `cell_snapshot` reads a cell by bound-prefix match —
  O(log n + k) — and confirms every hit against the main table (an index row
  caught mid-update can't produce a ghost). Maintained only in the four
  `*_now` write bodies; same-cell position updates
  never touch it. Invariant #10 (index ≡ tables exactly) runs after every
  fuzzer op and at storm quiesce; 6 mutants (each maintenance line removed)
  all killed; the sweeper finds drift read-only, then re-derives each
  suspect user inside that user's own writer shard.
  Measured (bench/cell_index_bench.exs): 80-cell sync at 10,000 drivers
  59 ms → 0.3 ms (199×); empty cell 591 µs → 1.5 µs; +1.2 µs per cell
  crossing. Known loss: a cell holding most of everyone online (200 of 300)
  is 2× slower (k lookups vs one scan) — 0.2 ms, irrelevant. Rule, verified
  (bench/prefix_vs_guard.exs): the cell MUST sit inside the key pattern; the
  same query as a guard returns identical results 341× slower.
  Rejected: `set` {cell,user} (listing = full scan), `bag` by cell (O(k) per
  key; docs warn), cell→MapSet value (O(k) copy per change + CAS with the
  map-pattern-is-subset trap).
- **Per-user indexes (SHIPPED 2026-10-22).** The same pattern applied to the
  per-request lookups that copied whole tables.
  - **What was slow:**
    - `Chat.conversations_for` ran on every `GET /api/state` (each app load).
    - `Requests.pending_for_driver` ran on every `GET /api/state` too.
    - `Requests.decline_all_for_driver` ran on every offline, ride start or
      reap, INSIDE a GeoWriter shard.
    Each copied the entire table to find one user's rows. Proof tests were
    born failing: one conversation among 10k cost 2.5 MB of copying.
  - **`:chat_by_user`** `{{user_id, pair_key}}`: two rows per conversation.
    Write order: a send writes the conversation THEN its index rows; a delete
    removes the index rows THEN the conversation. So no interleaving can
    leave a conversation without its index rows.
  - **`:requests_by_driver`** `{{driver_id, rider_id}, ts}`, ts = the
    request's own. A create writes the index row before `insert_new`; a
    losing create undoes its row, or restores the standing request's ts.
    Every consuming path (cancel, decline, accept, expire, decline-all)
    deletes exactly `{{d, r}, ts}` after its `take`, so a newer request
    between the same pair keeps its row. The main table's atomic `take`
    stays the only arbiter.
  - **Reads:** every index hit is confirmed against the main table, so a
    leftover row never shows a ghost.
  - **Sweeper heals:**
    - `Chat.heal_index` and `Requests.heal_index` re-add missing rows and drop
      stale ones (row by row via `foldl`, no table copy).
    - Stale request rows are dropped only past the request TTL: a younger one
      may be a create in flight.
    - The one possible gap (a same-pair re-request inside one second, which
      the 60 s cooldown nearly rules out) is closed by the next sweep.
  - **Invariants:** #11 (every request indexed, scope :all) and #12 (every
    conversation indexed from both sides, always).
  - **Tests:**
    - memory guards (lookup growth < 1/10 of the table's own size);
    - every end path and put-back;
    - the newer-row-survives case;
    - lost creates;
    - ghost and missing-row heals;
    - a send-vs-delete race;
    - write-order contracts checked deterministically by tracing the ETS
      calls (stress tests can't reliably hit a ~100 ns window);
    - 19 mutants, all killed.
  - **Measured** (bench/user_lookup_bench.exs), with 50k unrelated rows:
    - `conversations_for` 21 ms → 11 µs;
    - `pending_for_driver` 17 ms → 4 µs;
    - memory per 100 calls 12 MB → 137 KB, flat in N.
- **Every table `write_concurrency: :auto` (SHIPPED 2026-10-23).** All 14
  app tables are created through `Hoodride.ETS.new/2`, which always applies
  `write_concurrency: :auto` (OTP 25+: the runtime adjusts lock granularity
  to contention) and records the table.
  - **Before:** most tables had no write concurrency at all (one lock for the
    whole table); only the three index tables used `true`.
  - **Measured** (bench/ets_concurrency_bench.exs, our access patterns, 8
    schedulers, two runs):
    - driver rows (8 writers + 8 readers): 0.30–0.32M → 2.36–2.91M ops/s;
    - shared hot count rows (8 writers, `update_counter`): 0.11–0.14M →
      1.29–1.30M ops/s;
    - presence (200 processes): 0.40–0.52M → 3.88M ops/s.

    That is 8–10× the old setting. `:auto` beat `true` on every workload,
    most on the hot count rows (1.8×).
  - **Its one cost:** `:ets.info(t, :size)` at ~3.9 µs instead of ~0.1 µs
    (decentralized counters). Only the sweeper's few count-proof size reads
    per sweep use it: no hot path does.
  - **Enforced** (ets_tables_test.exs):
    - no raw `:ets.new` anywhere in `lib/` outside the helper;
    - every recorded table reports `:auto`;
    - one recorded table per call site;
    - a caller's own setting is overridden.

    Mutants: 3 killed, 1 equivalent. ETS uses the last occurrence of an
    option, so the explicit removal of the caller's setting is defensive.
    It is kept so correctness doesn't rest on that ordering.
- **Sweeper reads through `Hoodride.ETS.each_match`/`fold_match` (SHIPPED
  2026-10-22).** Every sweeper pass used to copy its whole table
  (`tab2list`), profile maps included.
  - **How it reads now:** each pass is an ETS `select` whose match spec
    holds the condition (expiry age, `ride_id =/= :pending`) and the
    projection (only the fields used: `{id, ts}`, ids, key pairs). Matches
    are paged 500 at a time under `safe_fixtable`. That is the Erlang
    efficiency guide's advice and Cachex's janitor pattern, plus paging.
  - **Cell index drift** is three row-by-row passes, collecting only
    suspects, instead of building sets of both map tables and the index.
  - **Expiry deletes the exact row it read** (`select_delete` on the row), so
    a fresh re-request that landed since is never expired.
  - **Orphan-seat reclaim deletes the exact `{user, ride}`,** never a newer
    seat.
  - **Proof test, born failing:** a 10k-driver healthy world, where one sweep
    grew 4.7 MB. Now the guard is < 1/10 of the bytes scanned.
  - **Edge tests:** expiry at the TTL vs one second past it; frozen at 3:00
    vs 3:01; grace at 5:00 vs 5:01; `:pending` seats never active; every
    drift kind (missing row, stray row, wrong role, wrong cell, car+hand in
    one cell); dead-ride seats reclaimed; more than two pages of matches.
    10 mutants, all killed.
  - **Measured** (bench/sweeper_select_bench.exs), one sweep of a healthy
    world at 50k drivers (+50k requests, conversations and seats):
    - memory 32 MB → 671 KB, and the new figure is flat in N;
    - time 554 → 541 ms, barely changed: copying was never the cost.
  - **Sweep optimized by measurement (2026-10-23), whole sweep 708 → 304 ms**
    at 50k (healthy world: every driver counted at altitude, everyone online
    in the UserChannels registry).
  - **Method:** tprof call_time for call counts per function
    (bench/sweeper_tprof.exs, after `Mix.ensure_application!(:tools)`); the
    real pass functions timed one by one (bench/sweeper_profile_bench.exs);
    every change A/B'd in interleaved rounds, min and median, because
    background load swung single runs 2× (bench/drift_ab_bench.exs,
    heal_ab_bench.exs, recount_parts_bench.exs). Two earlier explanations
    (presence checks dominate; foldl is the cost) were guesses from totals,
    and the profile disproved both.

    | Phase | Before | After | What changed |
    |---|---|---|---|
    | cell index drift | 130 | 27 | `lookup_element/4` reads one field (no row/profile copy). The default check is index → map rows (hash lookups) plus an equal-count proof; the map → index passes (tree lookups) run only when counts disagree. |
    | chat index heal | 139 | 43 | One pass over index rows: owner ∈ pair, conversation exists (hash), and an equal-count proof. The re-add/stale passes run only on failure. |
    | request index heal | 57 | 16 | One pass over index rows (one-field lookup of the rider's driver) plus an equal-count proof. |
    | hex recount | 83 | 49 | Tallies via `update_counter` on a private scratch table: 2× faster than a map of tuples; `Enum.frequencies` was slowest. |
    | stale drivers | 53 | 36 | `Geo.connected?`/`grace_since` with `now` read once per pass; `presence_of` read the clock per user even when online (100k clock reads per sweep). |
    | empty-room chats | 61 | 43 | Lazy checks, most decisive first; the old code computed ride and request checks for every conversation before the `if`. |
    | unlawful requests | 53 | 44 | `:ets.member` for "has a seat" (no row copy). |
    | `each_match` | — | — | Own loop, one call per row instead of two (~250k rows per sweep). |

  - **Count proofs are sound only because of check order:**
    - the index heals verify (or re-add) rows before counting, so only
      stale rows can make counts differ;
    - the drift check skips only when the index pass found nothing.
    Under concurrent writes the counts simply disagree and the full check
    runs.
  - **Tests for each skip:**
    - a missing+stale pair that would balance the count;
    - lone wrong-cell rows, driver and hand separately (counts equal);
    - a lone stray row;
    - a stray row on a later page;
    - a row under a user outside the pair;
    - an index row naming the wrong driver;
    - exact tallies per role;
    - a connected user with an ancient stored clock;
    - no presence row means long gone.
    18 sweeper mutants (filters plus each optimization) and 19 index mutants,
    all killed.
  - **What remains is the floor of "check every row every minute":** ~9 ms
    to page 50k rows, plus one ETS read per row per check (0.15–0.6 µs).
    Presence costs a `Registry.lookup`, two ETS reads, kept because the
    registry is the race-free source of truth. Lower would mean checking
    less: dirty tracking / incremental audits, at the cost of heal latency
    — an owner decision, not taken.
  - **Measurement trap found:** a `Registry.lookup` miss raises and catches
    `badarg` inside Registry. That costs ~0.2 µs in the sweep's shape, but
    grows roughly quadratically when many happen inside one loop that
    collects a big result list (1,000 → 2 ms, 50,000 → 1.6 s). It was not
    stack depth, live old-generation heap, or GC count — the exact VM
    mechanism is unconfirmed. No app code calls it in that shape (checked);
    probes that do, measure the probe.
  - **Cost in context:** ~0.5% of one core per minute at 50k, in the
    sweeper's own process; the writers pause only for the recount's copy
    (~31 ms at 50k).
- **Send-filter + heartbeat (SHIPPED 2026-10-21):** client tick runs every 1.5s
  but SENDS only when it matters — moved ≥15m (swallows parked GPS jitter), any
  H3 cell/parent changed (instant crossings preserved), or 20s since last send
  (the heartbeat: every marker is vouched-for within ~20s; parked drivers drop
  from 40 sends/min to 3). Same filter on the mid-ride stream; the auto-arrival
  distance check still runs every tick. Industry pattern ("distance filter +
  stationary heartbeat", researched: Uber ~4s + client interpolation; we trade
  a faster moving-cadence for no interpolation code). Driver rows carry a
  last-vouched timestamp; the sweeper reaps FROZEN drivers (silent >3 min with
  a live socket — wedged app) with full decline semantics. Hands are one-shot
  by design: grace-reaped only, never staleness-reaped.
- Server: **treats cells as opaque strings — no H3 math server-side** (built this way:
  avoids the `:h3` C NIF, which is painful to compile on Windows; the server never
  actually needs cell math — clients compute cells, centroids, and viewport coverage
  via h3-js). ETS `geo_drivers: user_id → {cell, lat, lng, profile}` +
  `geo_hands: user_id → cell`. Movement across a cell boundary = "left"/"update"
  events to the two topics. (Server-side H3 math only becomes necessary for the
  aggregate-counts tier — add the NIF then, or compute parents client-side too.)
  **Superseded 2026-11-13 (step 5):** the client-computed parents were believed —
  one car could count in 4 areas anywhere. The server now does the little H3 it
  needs itself, without the NIF: `Hoodride.H3` (bit math on the 64-bit id —
  validity, parent) checks the block id and derives the cell and the parents;
  the app sends only `{spot}`. Held to the app's own h3-js by
  `test/fixtures/h3_cases.json` (605 places incl. all 12 pentagons, 1,800 bad ids).
  Going online also needs a car on file (`Accounts.has_car?`, asked once per
  appearance, not per update).
- Drivers subscribe to own cell + k-ring (demand near them, not where they scrolled).
- **✋ demand is published at cell granularity (centroid)** — fuzzing is structural;
  the server never shares a rider's exact point pre-accept.
- **Dual-cell hands (decided after research):** topic/registration cell at res 8,
  but the hand's *displayed* position is a finer res-9 cell ("spot" in the payload,
  ~174 m edge — the location-privacy literature's ~200 m sweet spot). Deterministic
  cell-snapping deliberately chosen over random noise: snapping resists
  repeated-observation home-inference attacks (noise averages out; a snap never
  sharpens). Server treats both cells as opaque strings. (2026-11-13: it now
  derives the res-8 cell from the res-9 spot itself — see above.)
- Edge cases to handle: boundary jitter (only change cells on meaningful GPS movement),
  screen-edge demand (k-ring, not strict viewport).

### Zoom-out: resolution ladder + aggregates — FINAL DESIGN (research-confirmed,
### awaiting build go-ahead)

Validated against Uber's published pattern (hex-bucketed supply/demand; driver
heatmaps refresh on ~10 min cadence — our 60 s tick is 10× fresher), H3 4.x
official cell tables, and client-rendering benchmarks (MapLibre GeoJSON fills:
we draw 20–80 polygons; benchmarks run ~10k cells/tile — 3 orders of margin;
deck.gl unnecessary). No industry zoom→res lookup exists; the confirmed general
principle is budget-driven selection, which we already own:

- **Resolution selection = the existing 80-cell budget, applied down-ladder:**
  viewport res-8 cells ≤ 80 → live markers (today's behavior). Else try res 7
  (~5.2 km², Uber's reported surge unit) → aggregate hexes with counts. Else
  res 5 → same. Else the floor ("zoom in" hint). Screen-size-agnostic like the
  guard itself; no hardcoded zoom table.
- **Server stays H3-free:** driver_update/hand_up payloads grow a client-computed
  parent chain {cell8, cell7, cell5} — opaque strings; `agg_counts` ETS tallies
  per id. V1 = full recompute on the sweeper tick, broadcast changed cells to
  `agg7:<cell>` / `agg5:<cell>` topics (zero drift by construction). V2
  incremental stays shelved — freshness is already 10× industry.
- **Rendering:** MapLibre fill layers from client `cellToBoundary` (proven in the
  res-comparison demo), color ramp by count; tap a hex → zoom into it.
- Privacy: zoomed-out observers see only counts — strictly less than today.

(Original pre-research sketch follows for history:)

- Tie H3 resolution to zoom so cells-per-screen stays ~constant (a few dozen at any zoom).
- Zoomed in (res 8): individual markers. Zoomed out (coarse res, e.g. 6/4): **counts**
  per cell ("4 drivers, 2 hands") rendered as bubbles/heat — individuals would be
  meaningless and less private. Hard floor below ~res 4: no live layer, "zoom in" hint.
- One message shape from day one: `{cell, res, markers | counts}`.
- V1 scope: markers at res 8 + hard floor. Aggregate middle tier when there's more than
  one neighborhood of supply.

### Counts design

- `agg_counts (ETS): {res, cell} → {drivers, hands}` — a derived cache; `geo_fine` is truth.
- **V1 (shipped): periodic recompute.** Sweeper-tick scans the parents table, tallies,
  overwrites `agg_counts`, broadcasts only changed cells. Zero drift by construction.
- **V2 (SHIPPED 2026-10-21): incremental hot path on top.** `shift_agg` in Geo:
  on every parents-row write (driver_update / hand_up / driver_offline / hand_down —
  the only four write paths; sweeper + ride/request code all route through them),
  diff old vs new parent cells, apply net deltas via atomic `ets:update_counter`,
  broadcast only touched cells. Within-coarse-cell movement nets to zero → no churn.
  Crossings/arrivals/departures are visible to count viewers in <2s ("living
  organism"). The V1 recompute stays on every sweeper tick as the reconciler —
  it rebuilds from truth and heals any missed shift within 60s (verified by test:
  corrupt the counter, sweep, healed). Browser-verified live both directions.
- ETS (not process state) because many channel processes read counts concurrently on join.

## Capacity (measured 2026-10-26)

**How it's measured:** the prod build (`MIX_ENV=loadtest`: prod + dev_login +
no per-IP budgets, config/loadtest.exs) as a release in WSL Ubuntu, the
server PINNED to N cores (`taskset`; Erlang starts one scheduler per core it
may use — unpinned, a VPS uses all of them), the crowd on the other cores:
`test_load/capacity.mjs` (shards of Node processes, a WebSocket client on
`node:http` — Node 20's experimental one lost connections and hid HTTP 500s).
20% drivers driving non-stop at ~36 km/h (car updates through the app's own
send filter: a new spot or the 20 s heartbeat), 80% riders panning every
30–90 s, everyone in ONE 4 km-radius area (~50 km²) watching 7 res-8 cells
(~5 km², ~10% of it) — a DENSE, pessimistic scenario. Runner and restart
scripts: the session scratchpad (wsl_capacity.sh, wsl_restart.sh).
**CPU is "% of ONE core"** (200% = 2 cores full).

| People | 2 cores: CPU · sync p99 | 4 cores: CPU · sync p99 | Memory |
|---|---|---|---|
| 1,000 | 11% · 10 ms | — | ~310 MB |
| 2,000 | 31–37% · 13–114 ms | 34–52% · 4–9 ms | ~400–500 MB |
| 4,000 | 102–113% · 123–167 ms | 123–148% · 124–328 ms | ~780 MB |
| 5,000 | **199% (full)** · 499 ms, joins time out | — | ~1.1 GB |
| 6,000 | — | 294–327% · 355–664 ms | ~1.3 GB |

**Ceilings, this dense scenario:** 2 cores ~4,000 comfortable (limit
4,500–5,000); 4 cores ~6,000 held (one run timed joins out when 2,000
arrived at once at ~82%). ~160–210 KB per connected person.

**Why it grows faster than the crowd:** each car update goes to everyone
watching its block — more people means more cars AND more watchers per
block, so messages grow ~with the SQUARE of the crowd in one area (4,000 →
5,000: 1.25× people, ~1.5× messages). Hence 2× the cores carries ~√2 ≈ 1.4×
the people HERE; the same crowd spread over a city scales far better.
Measured per type at 4,000: in ~60 car updates/s (spot changes + heartbeats;
a parked car's heartbeat is never broadcast — geo.ex), 69 syncs, 68
heartbeats; out ~12,700 car updates/s + ~3,500 "car left"/s.

**Where the CPU goes** (`msacc` + process reductions at 4,000 on 2 cores):
delivering map updates — the WebSocket processes (encode + send, 46%) and
the map channels (receive, role check, push, 43%); socket I/O ("port") the
largest single cost, garbage collection ~1%; joins, database, map writers
under 2% together. **Not needed for the beta** (tens of people); if ever:
batch each watcher's updates (~0.5 s, one frame) — fewer socket writes;
then encode once per update; skipping the map-channel hop would move the
privacy role check, so last.

**No 28k connection ceiling — proven (2026-11-04).** Over 127.0.0.1 every
connection takes a temporary port from Linux's pool (`ip_local_port_range`,
default 32768–60999: 28,232), so a proxy on the same machine tops out there;
the tunnel reaches the app over the Unix socket instead. `test_load/
conn_ceiling.mjs` against the loadtest release in WSL (Ubuntu 24.04, open
files 1,048,576 for both sides, the release's `+Q 1048576`), 40,000
connections at ~2,000/s, each asking `GET /api/me` (answered 200 by the
app) and asking again every 30 s so the app's 60 s idle close can't free
ports:

| | over 127.0.0.1 | over the Unix socket |
|---|---|---|
| held open at once | **28,231**, then a hard stop | **40,000**, all |
| first failure | #28,232: `EADDRNOTAVAIL` (the pool is empty) | none |
| Linux's count of the app's open files | 28,263 | 40,032 |
| time | ~233 s (crawls as the pool runs dry) | ~31 s |

The app's memory peaked ~1.5 GB with 40,000 idle connections. (A first run
without the 30 s re-ask crawled to ~27,900 open, then rose only as the
oldest connections timed out — the idle close blurred it.) Past this,
memory/CPU and the configured 1,048,576 are the limits, not ports.

**Arrivals:** a burst of thousands joining at once is what tips a busy
server (join work + each newcomer widens the fan-out). The database used to
fail first — every connect read the user (pool of 5): fixed by the sign-out
DENYLIST (connects read no database; Hoodride.SignOuts — since replaced by
the in-memory sign-ins, Hoodride.SessionTokens) and the pool's
queue_target 1 s. The logger used to drop errors under bursts (Erlang drops
past 200 queued messages): connect/join lines at :debug, prod request lines
off.

**Deploys (4,000 on 2 cores):** an instant reconnect storm — all back,
p99 3.2 s. A restart with the app's own backoff: everyone back in 22 s
(retries grew to 8–10 s while the server was down; 15,609 attempts). With
the **restart notice** (HoodrideWeb.RestartNotice: `prep_stop` tells every app
"restarting" + a 4–10 s window; sync.js restartWait): everyone back in
**13.4 s, one attempt each, none refused**. A crash/kill/power loss sends
nothing: the normal backoff applies. (At 5,000, past the ceiling: 75 s.)

**Overload, the chosen behaviour** (Fred Hebert's "Handling Overload": pick
back-pressure or load-shedding deliberately): the map writer NEVER drops
work — every change matters. Its callers wait (back-pressure), then STOP
WAITING WITHOUT CRASHING (`GeoWriter.exec` → `{:error, :timeout}`): the
request is already in the writer's queue (OTP gen.erl sends, then waits)
and lands later, in order (one writer per user id); since OTP 24 a late
reply never reaches the caller. No retries (a second copy), no deadlines (a
late "lower ✋" must still happen), no high process priority (the writer
does fan-out work: it would starve every channel — OTP team's advice). A
ride looks both people up FIRST (`Accounts.profile/1`): a missing account
refuses the ride cleanly; a database that can't answer shows "Neighbor" —
the ride always starts and both are told (before: a failure on the second
lookup told one person "ride started" for a ride that didn't exist); its
map cleanup waits ≤1 s. A tap answers "unavailable". Only
`DBConnection.ConnectionError`/`Exqlite.Error` are absorbed; any other error
still crashes loudly. Upstream protection: per-person rate budgets, the
server's size. Known limit: the writer's queue is unbounded — under
sustained overload it costs memory, and drains once the burst ends.
Before the fix, 6,000 on 4 cores logged 192 channel crashes (writer
timeouts); after, 0. 17 tests (a writer made stuck with :sys.suspend, a
failing database), all mutants caught.

### The optimisation matrix (2026-10-26) — map batching ON at 500 ms

**A REALISTIC crowd first.** The tables above gave everyone a fixed 7-cell
view. A real phone (390×844 px, plus the app's one-cell margin) watches
15 cells even at street level (zoom 16), 34 at the app's opening zoom 14,
69 at zoom 13, up to the 110 budget at ~12.5. The harness now plans each
person's view with the app's own `planWatch` over a zoom mix (ZOOMS, default
50% at 15, 30% at 14, 20% at 13 — an ASSUMPTION), half the drivers parked
(PARKED), and times every 10th driver's car updates send → receipt (car
delay). Same dense 4 km area. Its old heartbeat began 30–60 s late — the
server's 60 s idle limit closed a few test riders: fixed (the app was fine).
Realistic views cost ~3× the old test: 4 cores carried ~4,000, strained.

**What was built (all behind switches, test-first, 14/14 mutants caught):**
- App: at most ONE redraw per screen frame (priv/static/mapframe.js;
  before, every car update regrouped and redrew every marker on screen).
- Server: MAP BATCH (`:map_batch_ms`, WorldChannel): each map channel holds
  its updates on its OWN timer (never a shared clock — every channel would
  send at once), keeps only the newest per car/hand/count cell, sends
  everything before any reply or "role" (a sync's snapshot is never
  followed by an older position), checks the role LIVE once at send time,
  and drops what's held on a role change. Protocol 3 (the app reads
  "batch"). The full suite also passes with it on (`MAP_BATCH_MS=500 mix
  test`; the 8 `:per_message` tests are skipped there). The MEGA MONSTER
  with batching on (400 × 4 waves × 300 s, chaos ×3; the monster judges
  every batch item by the same laws — its selftest has 3 batch cases):
  365,925 batches carrying 1,519,529 map items, L1–L8 all PASS, 0 replies
  over 1 s, idle memory flat after each wave (183 → 183 → 189 → 185 MB).
- First rejected, then BUILT: encode-once. A micro-test of ONE message
  (6,000 encodes 19 vs 18 ms; ~3 µs each) said "not worth it" — wrong
  context: under load that 3 µs is paid per update × per watcher, and once
  batching cut the frame writes, the profile (tprof inside 300 map channels
  at 4,000 people) showed JSON encoding at ~36% of a channel's time. Now
  the map writer encodes each update ONCE (Geo `with_json`: the broadcast
  carries `json` beside the plain update) and a batching channel puts it in
  its frame as-is (Jason.Fragment); batching off still sends the plain
  update (no `json` on the wire). Holding a message = one assigns update
  (was three). Tests: Hoodride.MapJsonTest (json is exactly the update;
  batch bytes identical with the switch on and off), count privacy covers
  `json`; 18/18 mutants. Switch `:map_encode_once` (MAP_ENCODE_ONCE=0) only
  to measure against. A/B, same build, alternating off/on ×2, 4 cores:
  CPU 53→38% (2k), 110→94% (4k), 174→157% (6k) — 10–14% where it matters,
  LESS than the profile's 20–25% estimate (tracing overstates small fast
  functions: the profile picks the target, the A/B gives its size); memory
  −33% / −19% / −15% (one shared binary per update instead of a copy in
  every watcher). 2,000-at-once arrival bursts at 6k failed with it on AND
  off (3 of 4 runs): burst noise. GC was ~4% of scheduler time: not tuned.
  Rejected without measuring: WebSocket compression (CPU per watcher).

**Results (server on 4 cores, realistic crowd), at 4,000 people:**

| Setting | CPU (one core) | Frames out/s | Car delay p50/p99 | Memory | 6,000 people |
|---|---|---|---|---|---|
| batching off | 213% | 28,798 | (the generator choked) | 1.4 GB | overloaded |
| 250 ms | 149% | 7,122 | 0.28 / 2.0 s | 1.5 GB | 2,000-at-once arrivals slow |
| **500 ms (default)** | **97%** | **4,222** | **0.44 / 1.1 s** | **1.9 GB** | arrivals p99 7 s, otherwise fine |
| 1 s | 88% | 2,438 | 0.81 / 1.6 s | 2.5 GB | arrivals slow |
| 2 s | 91% | 1,579 | 1.26 / 2.5 s | 2.8 GB | passed (luck: same CPU as 1 s) |
| 500 ms + view cap 60 | 89% | 4,250 | 0.46 / 1.3 s | 1.5 GB | passed |
| 500 ms + view cap 40 | 91% | 4,381 | 0.49 / 1.2 s | 1.6 GB | passed |

0 server errors in every run (one known start-up line on a fresh database).
Why 500 ms: most of the merging happens in the first few hundred ms; past
it CPU stays flat while memory and delay grow. The delay is invisible:
cars show as ~170 m spots, which a car at 36 km/h crosses in 17–35 s.
Batching halves the server's work AND the phones' (and cloudflared's,
not measured). Realistic capacity, 4 cores: ~4,000 strained → 6,000 fine
(only the slowest 1% of 2,000 joining in one instant wait ~7 s — a
restart, which the restart notice spreads over 4–10 s).

**View cap: kept at 110 (owner's call).** Cap 60 = ~8% less CPU and ~18%
less memory, but below zoom ~13.5 (a ~5 km-wide view) people see counts
instead of cars; 40 measured the same as 60 (zoom 14's 34 cells fit both);
30 would show counts at the opening zoom 14 — not an option. **FUTURE: if
memory becomes the limit, cap 60** — change MAX_WATCHED_CELLS in app.js
and keep the server's @max_watch (WorldChannel) just above it.

**Final numbers, all optimisations on (realistic crowd, 2026-10-26):**

| Server, area | 2,000 | 4,000 | 6,000 | 8,000 |
|---|---|---|---|---|
| 2 cores, dense 4 km | 26% | 60–76% | 113% (5% of joins fail, car p99 3.9 s) | 188% FULL (18% of joins fail, car delay 3 s) |
| 4 cores, dense 4 km | 38% | 94% | 157% | — |
| 4 cores, city 15 km | 19% | 37% | 58% | 99% (car delay 0.5 s steady) |

(CPU = % of one core: 2 cores max 200%, 4 cores 400%.) At 10,000 on 2
cores new sign-ups failed (database requests queued > 2.5 s behind a full
server, refused) — degrades, never crashes. **2 cores (the launch VPS):
comfortable to ~5,000 online at once in one dense area, far more spread
over a city. Upgrade to 4 cores at ~3,000–4,000 regularly online in one
area** (headroom for cloudflared, not in the test, and restart bursts).

**What breaks first: ARRIVALS.** A newcomer opens a socket, joins two
channels, subscribes ~34 cells and gets a snapshot of each — 2,000 at once
is ~68,000 subscriptions + snapshots in seconds, beside the live traffic;
staying costs ~2 small frames a second. Only a restart brings everyone at
once; the restart notice spreads it over 4–10 s. **Lever if crowds grow:
scale the reconnect window with the number connected** (e.g. 5,000 people
over ~20 s) — a small change to HoodrideWeb.RestartNotice. Not built.

**Reading CPU: idle schedulers SPIN.** An Erlang scheduler with no work
busy-waits briefly before sleeping, and the OS counts that as CPU — more
schedulers, more spin. At 4,000 people on 4 cores the schedulers' own
accounting (msacc) showed ~84% real work while the OS said ~118%: ~30% was
spin. So 2 cores looked CHEAPER than 4 for the same crowd (60% vs 94%), and
the earlier "2× cores = √2 people" was partly spin. Harmless (it yields to
real work at once), but judge fullness by reply times and msacc, not
`top`.

**What's left on one server:** each watcher's channel still RECEIVES every
update on its cells (batching merges what it sends, not what it gets):
~25% of a channel's time is that receive itself. Phoenix's fast path
(broadcasts straight to the connection) was REJECTED: it bypasses the
channel, so it would undo per-watcher batching (a cell gets an update only
~every 5 s per watcher — per-cell batching merges almost nothing; estimate
~120% CPU at 4,000 vs batching's ~95%), and the live role check at send
time would be gone (fixable only by unsubscribing synchronously before
every role change). Profile with batching + encode-once at 4,000 people:
map channels ~75% of process work, connections ~22%, map writers ~3%.

## Distances (2026-10-27)

The app shows distances ("🚗 Maria is on the way · 0.9 mi away"; the
peer card) from positions, with no routing service: Google/Mapbox cost per
request and send trips to a third party; a self-hosted router (OSRM) is $0
per request but a server of its own plus regular map rebuilds — the real
upgrade if true ETAs are ever wanted. So: the straight line × 1.3, the
established "detour index" / "circuity factor" (Cole & King 1968; Love &
Morris 1979 — it beat the grid "Manhattan" distance on urban samples;
Ballou, Rahardja & Sakai 2002 by country; Boscoe et al. 2012, 66,000 US
locations: road and straight-line distance correlate r² > 0.9, exceptions
at shorelines and barriers). Measured factors: US grid cities ~1.18–1.20,
city pairs median 1.235, ~300 European cities ~1.34, curvy suburbs > 1.5;
1.3 is the usual middle (owner's choice after the research). An average,
not a route; shown plainly ("0.9 mi away" — owner dropped "about");
under 0.1 mi, "nearby". Ride apps
use real routing and fall back to the straight line.

**Miles or km, automatically (owner: automatic, no setting).** The
standard: the user's locale looked up in Unicode CLDR's unit preferences
for ROAD length — the data iOS's and Android's own formatters use — which
give mile to US and GB only, kilometer to everyone else. Browsers can't do
the lookup yet (TC39 "smart unit preferences", Stage 1) and no JS library
does it (Globalize, FormatJS and ICU4X format units but don't pick one;
Elixir's ex_cldr_units does, server-side, at the cost of the whole CLDR
data set for a two-entry answer), so distance.js does it: the first
`navigator.languages` entry that names a region; else that language's
likeliest region (`Intl.Locale(...).maximize()`: en → US); else miles (the
US launch). Not Intl's default locale: Chrome builds it from the UI
language and can lose the region. Known limits: iPhone Safari takes the
region from the chosen language, not the Region setting; small mile-using
places (Guam, the Isle of Man, some Caribbean states) get km unless their
browser says en-US/en-GB — CLDR's own answer, which a later Auto/mi/km
setting would cover. "Nearby" is the same real distance in both units
(< ~160 m by road). Tests: distance.test.mjs (9); 9/9 mutants.

**In chat and requests (owner: "a rider messaging a driver already shows
consent").** Someone NOT DRIVING shares their ~170 m block — never a
position — with a person by messaging them or asking them for a ride.
Online drivers are public as cars, so theirs is never attached
(UserChannel.shareable_spot: a well-formed block, not an online driver's).
The block travels only WITH what's sent (never streamed): the latest per
sender per conversation (Chat, `:chat_spots`), and per request stamped
with that exact request (Requests, `:request_spots` — served only while
the same rider/driver/time request is open). Both go to that one person,
live and in /api/state with an age counted on the SERVER's clock (phones'
clocks can be off); both disappear with their conversation or request (and
the repair passes sweep strays). The app (priv/static/distance.js,
HoodDistance) measures to the best position it may have: the ride
partner's exact one → the block they show on your map → the block they
last shared, with its age ("0.6 mi away · 20 min ago") → nothing. The
privacy policy says so ("who sees what"). The chat box note "📍 Drivers you
message see roughly where you are (about a block)" is OFF since 2026-10-29
(owner) — commented out in index.html and app.js, to bring back. Why blocks: a
distance IS a location (trilateration located Grindr, Tinder, Bumble,
Hinge users from distances alone); "snap to grid" was the fix Recon and
Hornet adopted, and a fixed grid reveals nothing more however often it's
asked (random noise can be averaged out). Tests: shared_spot_test (9),
hot_paths (state survives a reload), distance.test.mjs (5); 14/14 mutants;
Chrome, two signed-in sessions (localhost and 127.0.0.1, stand-in GPS
~450 m apart): the driver, who can't see the rider on the map, reads "0.4 mi away" from the rider's message; the driver's reply carries no block;
the request's block reaches the driver's waiting list; both survive a
reload; a cancel removes the request's block while the chat's stays; no
console errors. (Running dev servers need a restart after this change: the
new tables are created at start-up, which every deploy does.)

## Profile photos: our own copy, made at sign-in (2026-10-27, BUILT)

Built as planned below: Hoodride.Avatars (+ AvatarsOffPlug in tests),
HoodrideWeb.AvatarController, the `:avatar` pipeline with HttpBudget's
`config:/name:` options (burst 40 — the shared GCRA budget allows burst + 1
at once, like every budget here), migration 20261027042532, the start-up
step in Application (folder made, unreferenced old files removed), the
privacy wording, priv/static/avatarretry.js. Tests: avatars_test (16),
avatar_serving_test (10), the Facebook sign-in tests rewritten, a test that
the budget stays 2× reveal's (WorldChannel.reveal_per_minute/0); 17/17
mutants (incl. a redirect to an ALLOWED host must still not be followed, a
lookalike host `evilgoogleusercontent.com` refused). Chrome: the user's
photo loads from /avatars/…; signed out → 401; a missing photo → 🙂, retry
at ~1.7 s and ~4.2 s, then stops. The Chrome check caught a real bug: the
"reset the retry count when an image loads" rule also fired for the 🙂
(which always loads) — a missing photo retried every 2 s forever; it now
resets only when one of our photos loads. Load test config left identical
to prod (a guard test caught an extra override). Untested until the keys
exist: real Google/Facebook downloads (Facebook Development-mode
behaviour is the thing to watch on deploy day).

Plan as agreed:

Owner asked whether provider photos are stored or loaded from Google/
Facebook. They were HOTLINKED: every viewer's phone fetched them from
Google/Facebook, telling them (viewer IP + Referer) who looked at whom;
Google's links can rot into a silhouette between sign-ins (developer
reports), and Facebook's tokenless picture address returns a SILHOUETTE
for apps in Development mode (Meta's own reference) — every Facebook user
in our beta. Privacy-minded platforms (GitLab's asset proxy, Lemmy's
image_mode, forum avatar caches) serve outside images themselves. Plan
(owner-approved after research rounds):

- **At sign-in** (Hoodride.Avatars): download ONE small copy. Google: the
  `picture` link with the documented size suffix `=s128-c` (People API
  image sizing), falling back to the link as given. Facebook: with the
  signed-in user's OWN token, `/me/picture?redirect=0&width=128&height=128`
  (Meta's reference) → its `url`, unless `is_silhouette` (→ no photo, 🙂).
- **Safe fetching** (OWASP SSRF): https only; hosts allowlisted
  (`*.googleusercontent.com`; `*.fbcdn.net`, `*.fbsbx.com`); NO redirects
  (they bypass the check); 3 s; ≤ 512 KB; the type from the BYTES (JPEG,
  PNG, WebP), never the header. Any failure: keep the current photo (or
  none) — sign-in never fails for a photo.
- **Stored** as files next to the database (prod /var/lib/hoodride/avatars),
  random 22-character names (unguessable, uncountable); `users.photo` =
  `/avatars/<name>`. An unchanged photo keeps its name (byte-identical);
  a new one gets a new name (browsers cache forever, a change shows at
  once); once the account is SAVED with it, the replaced file is kept a DAY
  (socket tokens carry the old link that long), then deleted — if the save
  fails, the new file goes at once and the old one stays the account's
  (`Avatars.keep_if_saved/3`, 2026-11-08: the old one used to be retired
  before the save); deleting the account deletes it at once;
  start-up removes any file nothing points to (older than a day).
- **Served** at `/avatars/:name` to SIGNED-IN users only; the name must
  match the pattern exactly; `Content-Security-Policy: default-src 'none'`,
  `nosniff`, `Cache-Control: private, max-age=31536000, immutable`
  (private: Cloudflare must not cache past the sign-in check).
- **Own budget** per account: burst 40, 120/min = 2× reveal's (20 names at
  once, 60/min) — a photo is only learned through reveal, chat or a ride,
  and each loads once per device. Off in dev/loadtest like the others.
- **The service worker skips `/avatars/`** (it stored every response,
  errors included, and kept others' photos after sign-out).
- **A failed photo**: 🙂 at once, then up to 2 retries (~2 s, ~4 s,
  jittered) while still on screen.
- **Existing outside links** cleared by a migration (🙂 until the next
  sign-in). Privacy policy: "a small copy of your profile photo, refreshed
  when you sign in, deleted with your account"; the line saying Google/
  Facebook can see when a photo is shown goes. `/privacy#delete-account`
  = Meta's data-deletion instructions page.

## Looking users up when things fail (2026-10-26)

Audit of every place a user is read or written (owner asked "all the
issues that come with getting user"). Sockets read no database (token
carries name/photo and names its sign-in, checked in memory); chat and
requests use the connection's copy. The rest:

**DONE:**
- **Opening the app never mistakes "can't reach" for "signed out".**
  `boot()` used to show the sign-in screen for ANY failure of /api/state —
  a deploy (Cloudflare 502), a database hiccup (500), the rate limit (429),
  no signal — though the session was fine. Now priv/static/boot.js
  (HoodBoot): only 200 `{user: null}` or 401/403 is signed out; anything
  else shows "Can't reach Hood Ride — retrying…" and retries with the
  reconnect backoff (HoodSync.reconnectBackoff), the server's Retry-After
  (seconds, capped 60 s), and at once on `online`/visible. The sign-in
  buttons start hidden ("Connecting…"). Rule as auth clients state it:
  clear only on 401/403, retry network/5xx. Chrome: server stopped →
  "retrying…", started → in by itself, no reload. 12 tests, 8/8 mutants.
- **The reconnect reload retries.** A failed /api/state after a rejoin
  waited for the NEXT rejoin (a live connection may not have one for
  hours); now it retries with the same backoff, and judges the answer with
  HoodBoot.classify (a 500's JSON body used to read as "logged out").
- **A database hiccup during reveal isn't "gone".** Accounts.profile/1
  tells nil (no account) from {:error, :unavailable} (the pool/SQLite
  couldn't answer); reveal now answers busy names with `later` (a batch:
  that name and the rest — a struggling database isn't asked again in the
  same breath) or `busy` (a tap: the app says "Couldn't reach the server —
  try again"), with `retry_ms` = the pool's own `queue_target`
  (WorldChannel.busy_wait_ms/0). It used to read "Not available" for good.
  The allowance is spent before the lookup, as before (scraping stays
  costly). 5 tests, 5/5 mutants.

- **A deleted account no longer comes back after a restart (privacy
  hole, reproduced by a test that failed on the old code).** The denylist
  reloaded from `users.logged_out_at` — deleted WITH the row — so after any
  restart within a day a leftover socket token (n/p, no database read)
  reconnected as the deleted account. Now revocations have their own table,
  `sign_outs` (user_id key, `at`; the later wins, never the older), loaded
  at start-up; deleting an account is ONE transaction done FIRST (row
  deleted + revocation saved): a database failure → 503, NOTHING changed
  (still signed in, still on the map) and a retry works — it used to revoke
  first, so a failed row delete left the person signed out, unable to
  retry, and the account came back at their next sign-in. Sign-out saves
  to the table too (and the `logged_out_at` column HTTP sessions still
  read). The table stays small with NO database work in the Sweeper (owner
  asked why the sweeper would need the database — it doesn't): rows only
  arrive with a sign-out or deletion, and that same write drops rows older
  than 30 days, as does the start-up load; the Sweeper still trims the
  in-memory copy. Migration 20261027032653 copies existing sign-outs.
  revocation_test.exs (8), 9/10 mutants (1 equivalent: the load's 30-day
  filter, redundant after the start-up trim — kept as a safeguard).

- **Sign-in: a database failure gets the friendly page.** Saving the user
  at the end of sign-in raised a raw error page; the callback now catches
  ONLY database errors (DBConnection/Exqlite) → 503, the same "sign-in
  failed — go back and try again"; no session is made; a bug still crashes.
- **Sign-out: complete, or clearly not done.** It refused in memory first,
  then wrote the database; a failed write left the app HALF signed in (the
  HTTP session — which reads the database — still valid, the socket —
  which reads the denylist — refused: an app that opened but never
  connected). Now the database step comes FIRST (column + `sign_outs`, one
  transaction), as with deletion: if it fails NOTHING changes (still signed
  in everywhere), the server answers 503 and the app says "Couldn't sign
  out — try again" (OWASP: a sign-out the server couldn't make is a failed
  one). The app forgets this phone's leftovers only after success.
  Tests: real failures (a table renamed inside the test sandbox); 7/7
  mutants. Chrome: a normal sign-out still lands on the sign-in screen.

- **The database off the busiest paths.** (a) WHO YOU ARE: every HTTP
  request read the user row (`Auth.session_user`) — after a restart,
  thousands of /api/socket_token + /api/state calls queued for a pool of 5.
  Sign-in now puts name, photo and provider in the (signed) session — they
  change only at sign-in, which always makes a new session — and a request
  checks, in memory: the session is < 30 days old, and the denylist (now
  restart-proof) holds no sign-out or deletion after it began. Measured:
  ZERO queries for a signed-in request. Sessions from before carry no name:
  checked the old way (one read) until the next sign-in — nobody signed
  out by the switch. Revocation tested with no database read and after a
  simulated restart (CVE-2026-86533's lesson: a reloaded user whose
  revocation record was never checked). (b) ONE QUERY, NOT ONE PER PERSON:
  `Accounts.profiles/1` (`WHERE id IN …`); /api/state (ride partner, every
  chat partner, every request) = 1 query (was 1 + N); reveal of 10–20 names
  = 1 query (was one per name), its per-name allowance and privacy check
  unchanged (in memory). A busy database: /api/state → 503 (the app
  retries — never a state with people missing); a reveal batch → ALL its
  names `later` (one query fails as one). hot_paths_test.exs (counts real
  queries via Ecto telemetry), 9/9 mutants.
  **Measured** (2 cores, 4,000 people, a deploy restart; the harness's
  phones now make the app's real reconnect calls — fresh socket token,
  then /api/state — which it hadn't, so earlier deploy numbers flattered
  the old code): BEFORE, 5,329 server errors on those calls (socket_token
  4,240, state 1,089), only 2,720 of 4,000 states reloaded, 608 log errors,
  the logger in drop mode twice, everyone back in 45.7 s. AFTER, three
  runs: 0 server errors on those calls and every state reloaded, every
  time. Recovery time (23–44 s) and arrival bursts swing as much between
  identical runs as between before and after: noise; the zero errors are
  the repeatable gain.
- **Join deadlines no longer crash during a deploy.** Each connection's
  10 s "must join" timer could fire while the old server was stopping,
  after the user-channel registry had shut down: "unknown registry" — 124
  errors in one second of a deploy (older code, exposed by the repeat
  runs), burying any real one. The timer now does nothing when that
  registry is gone.

- **"Neighbor" corrected mid-ride** (owner: "do it"). A database that
  couldn't answer at a ride's start shows the partner as "Neighbor"
  (overload fix) — and it stayed for the whole ride, only a reload fixing
  it. The ride now remembers whose name it lacks and asks again (the
  pool's own patience, doubling, at most 30 s, for as long as the ride
  lasts); once known it tells the RIDE channel (`peer`: id, first name,
  photo — only the two seated people can join it) and stops; an account
  gone meanwhile is dropped. Accounts.retry_wait_ms/0 is the one wait
  (reveal's busy_wait_ms uses it too). The app's handler updates the shared
  peer object (banner, open chat title, open card). 4 tests, 7/7 mutants;
  the app handler itself is glue, not run in a browser (it would need a
  real ride started during a database failure).
Backups (when added) must expire and be named in the privacy policy.

## Data model (reference — the durable subset is just `users`)

Conceptual relations (live in memory; only users on disk):

```
users          (SQLite: id (a RANDOM integer, not a count), name, email, photo, provider)
conversations  one per pair, created on first message or at ride start
messages       belong to conversation (NOT to requests — chats outlive requests)
requests       point at conversation; lifecycle above; rider creates, driver answers
rides          born from an accepted request; carry pin, started_at
```

Separate lifespans → separate structures: users(years) / conversations(while occupied) /
rides(hours) / requests(minutes) / positions(seconds).

## Push notifications (Web Push — backend era)

- Open standard, $0: Phoenix signs with VAPID keys and posts to the browser vendors'
  push services directly. No Firebase/FCM account, no per-message cost.
- Purpose: reach a phone whose socket is dead ("something happened, come back") —
  incoming message, incoming request, accepted/declined, driver arrived.
  Does NOT enable background GPS (nothing does, on the web).
- Routing via Presence: recipient connected → channel push; past grace → web push.
  Same presence machinery, second delivery leg.
- Caveats: iOS delivers only to an installed PWA (16.4+) → "Add to Home Screen" is a
  real onboarding step, especially for drivers. Android works in-browser too.
- Push subscriptions (endpoint + keys per device) are **durable by necessity** → SQLite.
  Durable set becomes: users, push_subscriptions, (later) blocks, ratings.

## Frontend status (built, mock-driven)

Two screens (login, map). Mock auth in `localStorage`. Mock drivers wander; mock riders
(✋ hand + direct incoming request) exercise the driver side; canned chat replies.
Implemented and tested: both modes, GO ONLINE/OFFLINE, ✋ toggle with cleanup,
multichat (per-peer history, unread badges, chat list when >1, straight-open when 1),
request lifecycle incl. Cancel request + race guard, Decline keeps chat + re-request,
pin placement/moving (pin wins for pursuit & Navigate), wake lock, PWA install,
state-aware banner. The mock `auth` object and MOCK-commented blocks in `app.js` are
the backend swap points; screens/flows don't change.

**Copy a chat message (2026-10-26, owner chose "tap → Copy chip"):** tap a
bubble (or Enter) → a "Copy" chip; tap Copy → the whole message is
copied, "Copied ✓" ~1.2 s, gone. One chip at a time; a second tap, another
bubble, an outside tap or the person's scrolling closes it (the app's own
scrolls — new message, opening the chat — are told apart by where the app
put the chat). Press-and-hold stays the phone's text selection (partial
copies); a tap during a selection shows nothing. Why not a button per
bubble: person-to-person chat apps don't (clutter, mis-taps; Google
Messages / Sendbird use a per-message menu); why not long-press-to-copy:
Safari allows the clipboard only inside a real tap. Fallback: execCommand
copy on plain http, else "Couldn't copy". priv/static/msgcopy.js
(HoodMsgCopy) + test_js/msgcopy.test.mjs (12 tests, 9/9 mutants);
Chrome-verified with real clicks. The chip is where Report/Block can go.
The chip FLOATS (owner caught v1 inserting it into the list, which pushed
every later message down): absolutely positioned inside the scrolling
message area (moves with its message, no re-measuring), placed by
HoodMsgCopy.place — BESIDE the bubble's empty side (WhatsApp), else ABOVE
it (iMessage), else BELOW (the chat's start would clip it). Plain
positioning, not CSS anchor positioning (Baseline only Jan 2026; Safari 26).
Measured: no message moves at 1,333 px or 390 px; every chip beside its
message there ("Couldn't copy", 106 px, flips above a full-width message on
a phone). Tap area 72×45 (::before, Apple 44 pt / Material 48 dp; WCAG
2.5.8), Escape closes and refocuses the message, aria-label "Copy message",
no iOS tap flash. 18 tests (2,000 random placements never cover the bubble
or leave the chat), 8/8 placement mutants.

## Backend build order — status (Oct 2026)

1. ✅ Phoenix + SQLite(users) + session auth. Google OAuth server flow coded,
   **waiting on credentials** (see GOOGLE_SETUP.md). Until then `/api/dev_login`
   (dev-only) gives the mock buttons real sessions — two browsers = two real users.
2. ✅ Presence + geo channels (opaque cells, h3-js client-side). Grace via sweeper.
3. ✅ Chat: routed through recipient's `user:<id>` channel, ETS conversations,
   created on first message, `/api/state` rehydration.
4. ✅ Requests (atomic `:ets.take` transitions) + GenServer-per-ride +
   `ride:<id>` two-party channels + naive sweeper (60s: request expiry,
   geo grace, empty-room chat cleanup).
   Verified by channel integration tests (`mix test`): full flow,
   cancel-vs-accept race, join auth, decline/re-request.
5. ✅ Aggregate tier SHIPPED (2026-10-21): budget-driven ladder (markers →
   agg res7 → agg res5 → floor, same 80-cell budget at every rung), client
   parent-chains keep the server H3-free, `agg:<cell>` read-only channels,
   sweeper-tick recompute with change-only broadcasts, MapLibre hex fills
   with count labels, tap-to-dive. Browser-verified across all four rungs.
6. ⏳ Later/maybe (owner decides): ratings, block/mute, request-cooldown,
   push notifications (installed PWA)

Dev notes: the app is the repository's top folder (frontend = `priv/static/`), run with
`mix phx.server` → http://localhost:4000. `?demo=1` forces the old mock world.
Demo-mode request flows mirror the real protocol but stay client-local.

## Coming back as what you were (driver/rider)

A reload or a sign-in restores the mode last PICKED on this device, per
account (priv/static/modestore.js, HoodModeStore: `hoodride_mode_<id>`,
"driver" or "rider" only; blocked storage = nothing remembered, nothing
breaks). What the server knows wins in hydrate: an online shift and riders
waiting → driver; a ride → its role; a waiting ride request or a raised ✋
→ rider. The MODE only: a driver comes back OFFLINE unless the server has
them on the map — going online is always a tap and a location. Kept across
sign-out (same person, same mode); someone else on the phone starts as a
rider; deleting the account forgets it. Same device only (across devices
would be a database write per switch). Tests: modestore.test.mjs (6), 7/7
mutants; Chrome: driver → reload → driver, offline; rider → reload → rider;
a second account starts as rider; its deletion removes its key and keeps
the other's; signing back in restores driver. Also live-checked (a
parked fixture car): with "driver" saved, a waiting request and a raised ✋
each come back as rider. The demo remembers its mode too, under its own
key (`hoodride_mode_demo`), offline.

## Your car (BUILT)

What a rider looks for on the street — colour, make, model (Uber: make,
model, plate; Uber paints the map car in its colour; rider safety advice:
"check that the make and colour match"). **No plate** (owner's choice).

* **Set** in Settings → "🚗 Your car", or in the box Go online opens when
  none is set ("Add your car" → "Save & go online"). Colour from a list (the
  common US colours first — iSeeCars 2025: white, black, gray, blue, silver,
  red ≈ 96%), make with suggestions under the box (36 common makes,
  HoodCar.suggest: starts-with first, then a later word — "benz" →
  Mercedes-Benz; at most 6; our own list, not a <datalist>: Chrome drew
  that popup outside the page, far to the left, where no test could see
  it; ↓/↑/Enter/Escape work); any make can be typed — make/model databases go stale, and this needs no
  outside service), model free text. Server rules (User.car_changeset; the
  form's car.js mirrors them, a test keeps the colour lists equal): all
  three required, spaces trimmed and squeezed, 1-24 characters (graphemes),
  and Unicode category C (control, zero-width, right-to-left override)
  REFUSED, not stripped — a stranger reads it on a card. POST/GET /api/car;
  503 when the database can't answer.
* **Required before going online — in the app.** The server doesn't check
  (that would be a database read on every location update); a modified app
  going online without one just shows "Driver".
* **Who sees it: riders only** — the name lookup for a rider looking at a
  car (`reveal`, one and batch), the ride's driver side (`ride_started`,
  the name retry's `peer`), /api/state's ride (when you're the rider) and
  open request. Other drivers never get it; a rider's own car (if they
  once drove) never travels. Shown on the car's card ("Silver Toyota Prius"
  / "0.2 mi away") and the rider's banners ("🚗 Sam is on the way · Silver
  Toyota Prius · 0.4 mi away", "🚗 Sam has arrived · …").
* **Read only when needed:** Settings opening, becoming a driver (so Go
  online is usually instant) — never on page load. The name lookups were
  already one query; the car rides along in it. Deleted with the account
  (it's columns on the user row). Edits show on the next tap.
* Map colouring (Uber-style) skipped: cars sit at their block, so it
  wouldn't help find them; the ride partner's exact marker could be tinted
  later from data the app already has.
* Tests: car_test (14), car.test.mjs (6); 15/15 mutants. Chrome (rider
  test account + an auto-accepting fixture car with a car set via the API):
  the card shows it; the ride banner shows it, also after a reload; Go
  online without a car opens the box, a wrong entry names the fields,
  saving goes online (on the map); the second Go online asks nothing;
  Settings shows and edits it; a right-to-left override sent as a JSON
  escape is refused (400).

## Chat list

Like chat apps (Messenger, Instagram, WhatsApp): the conversation with the
newest message ON TOP; unread rows bold (name and last message) with the
count bubble, read rows in normal weight; and how long ago the last
message came — "now", "5m", "3h", "2d" (relative, not a clock time: Hood
Cab's chats are short-lived) — redrawn every 30 s while the list is open
(the times only; rows stay put). priv/static/chatlist.js (HoodChatList).
Times: a live message is stamped on arrival; after a reload they're the
server's message stamps put on this phone's clock — /api/state carries
the server's `now`, so a phone whose clock is off still reads right (the
same reason distances' ages use the server's clock). Tests:
chatlist.test.mjs (5) + hot_paths (state has `now`); 8/8 mutants. Chrome:
a message from the oldest chat moves it to the top, bold, "now", "1"; a
"now" became "2m" at the 30 s redraw; opening it clears the bold; a real
conversation reloaded 1.14 min after its message reads "1m".

## Browser journeys (2026-10-30, BUILT)

The glue in `app.js` can't be loaded by the Node tests, and the Elixir tests
only read it — so a real browser runs it. `test/browser/journeys_test.exs`
starts the app on its own port (4100) with the test database (shared
sandbox; per-address budgets off) and runs each journey script in
`test_browser/`, one ExUnit test each — part of `mix precommit`.

- **No download.** `test_browser/cdp.mjs` starts the Chrome-engine browser
  already on the machine — Microsoft Edge (ships with Windows), else Chrome
  or Brave; `BROWSER=` picks one — headless, in a throwaway profile, and
  drives it over its own debugging connection (the Chrome DevTools Protocol)
  with Node's built-in WebSocket. Each person is a separate browser context
  (own cookies and storage), signed in by name (dev sign-in, local only),
  with the browser's location set and allowed.
- **Journeys:** `offline` (✋ / Go online / Drive-Ride refused while
  disconnected, working once back, the driver sees the ✋; a ✋ tap that
  waits for GPS, the connection dropping meanwhile: refused, the message
  stays), `chats` (a new
  chat and its text survive a reconnect; the text belongs to its person;
  unread after a reconnect and after reopening the app; a message with no
  answer isn't shown as sent; "isn't in view" / "isn't available" close the
  chat, text kept / dropped; sign-out erases the read note), `ride`
  (request; cancelling refused offline; accept, the car in the banner,
  "· Reconnecting…" mid-ride, End ride refused offline, then ends for
  both), `account` (a second device → "opened on another device", Use here
  takes it back; a new version deployed → "Update available — tap to
  reload" → the new version; Delete account → confirmed, signed out, the
  server knows nobody, the other person's chat closes). A journey can ask
  the test to act on the server: it prints `@@server <what>` (now:
  `new_build`) and reads the answer on stdin.
  `ridedetails` (a driver declines; "Too late" when the rider cancelled
  as the driver tapped Accept — the cancel held back on its way; a ride:
  Navigate to the rider, the 📍 pin set with a real click on the map and
  Navigate going there, I'm here), `map` (a pile of 3, its list by name;
  zoomed out: no markers, a count of 3 — the app's data, the drawn layer
  needs the map style from the internet; the map opening where you left
  it), `settings` (the drawer: name, no car, no Change for a dev account,
  sign out on all devices; Go online without a car opens the car form;
  the blank-form error; Other/Honda/Civic → online, "Honda Civic" in
  Settings and on a rider's card), `visitor` (the signed-out screen:
  Continue with Google, Facebook only if the server offers it, 18+ and the
  privacy policy, which opens; on hoodride.app the button goes to Google,
  here it signs in by name; the demo: pretend drivers, no account and no
  connection, ✋ → a pretend driver writes, a reply, a ride accepted and
  ended), `signout` (a rider signs out: her ✋ leaves the driver's map in
  seconds; a waiting request the phone hadn't heard of: the server refuses
  the sign-out, "Cancel your ride request first"; the driver signs out:
  his car leaves the rider's map, her request is declined).
- **Rule (owner, 2026-10-30):** any change to a feature adds or updates
  its journey. Not covered: Refresh from Google (needs a real Google
  sign-in) and the drawn zoomed-out layer (map style from the internet). Any page error fails a journey.
- **Run:** `mix test test/browser` (about a minute); one:
  `--only journey:chats`; `BROWSER_VERBOSE=1` prints the steps.
- **Proof:** 26 deliberate breaks of the app, each caught by its journey.
- **First find:** tapping ✋ offline started a GPS wait; the reading then
  redrew the banner and wiped "Can't reach Hood Ride — try again". Fixed:
  the taps are refused at once while not live, and the later refusal shows
  its message after the redraw.
- **Later:** Playwright would add WebKit (closest to iPhone Safari) — worth
  it if iPhone-only bugs appear; it's a download.

## Minified JS at deploy (2026-10-30, BUILT)

Our own JS is minified with esbuild in the **release copy only** (the repo
and the server's source stay readable): `deploy/deploy.sh` runs `mix
hoodride.minify --in-place` on the new release's `priv/static` after `mix
release`, before the switch — a failure stops the deploy with the running
release untouched. Settings and why: `config :esbuild` (config/config.exs).

- **The Phoenix team's `esbuild` package (0.10.0)**, program pinned to
  esbuild **0.28.2**; the download is checked against npm's signature and
  SHA-512. No bundling: esbuild then keeps every top-level name (the files
  share globals; the journeys call app functions).
- **The program, between deploys** (owner, 2026-10-31): the package only
  downloads when the program is missing, and an outdated one only gets a
  warning. A deploy builds from a fresh folder, so it re-downloaded every
  time: now `--keep ~/.cache/hoodride` holds it, put back only when it's the
  configured version (a version bump downloads the new one and keeps that),
  and minifying with any other version stops the deploy. MinifyTest.
- **Browsers:** `--target=es2020,safari13.1,ios13.4,chrome80,edge80,firefox72`
  — the minimum for what our code uses (`??`), so minifying never needs a
  newer phone than the code itself (`?.` is rewritten for Chrome < 91 /
  Firefox < 74). Not a standard list on purpose: Vite's "baseline widely
  available" (Safari 16+) would let the output break iOS 13.4–15.
  `--supported:destructuring=true`: esbuild counts destructuring only from
  Safari 14.1 / iOS 14.5 (edge-case conformance) and can't rewrite it; our
  code already relies on it. `--log-override:bigint=error`: esbuild only
  warns about BigInt.
- **Source maps** written beside the files (`--sourcemap=external`: no
  link in the JS), never served — not in `HoodrideWeb.static_paths/0` (a
  `.map` address gets the app's page, like any unknown path).
- **Left alone:** the libraries that come minified, and `sw.js` (the page
  controller rewrites its cache name).
- **Size:** our JS 242 KB → 103 KB raw, 78 → 32 KB gzipped; live `app.js`
  139 KB → 73 KB, 22 KB on the wire (Brotli).
- **Tests:** `minify_test.exs` (all files minified, < 60% size, every
  top-level name kept, maps written but never linked or served, BigInt
  fails the build); the **browser journeys run the minified files**
  (`HoodrideWeb.MinifiedStatic`; each page checks it got them). Every
  setting removed on purpose fails a test.

## Addresses that don't exist (2026-10-30, BUILT)

Any address that isn't a real page, the API, sign-in or a file answers a
real **404** — with the app as the page (`PageController.not_found`), so a
typo or a stray link still lands on the map. Google: "a 404 for a page that
could not be found"; it ignores the content of a 4xx and never indexes it,
so the app-as-404-page costs nothing in search (the GitHub Pages SPA
pattern, without its drawback: Hood Ride has no in-app pages). Scanners stop
reporting `/.env` or `/app.js.map` as found. Real pages keep 200: `/`,
`/index.html` (the offline copy downloads it — a 404 there and the service
worker never installs; a test checks every file in `sw.js` ASSETS answers
200), `/sw.js`, `/privacy`. Tests: `not_found_test.exs`; the visitor
journey opens a typo address (404) and lands signed in on the map.

## Terms of Use (2026-10-31, BUILT)

`/terms` (priv/static/terms.html, styled by privacy.css; PageController)
and a one-time **"Before you start"** screen before the map, kept minimal
(owner, 2026-10-31): "Please read and agree to our Terms and Privacy
Policy" and **I agree** (clickwrap — the kind courts enforce most
reliably). The rules themselves, 18+ among them, are in the Terms (and 18+
on the privacy page); the sign-in line says only "By continuing, you agree
to our Terms and Privacy Policy" (Uber, too, keeps 18+ in its terms rather
than asking at sign-up). Owner's choices: no state named (no
governing-law section), the $100 cap in bold, the one-year claim limit "to
the extent the law allows" with a fallback, and payments left open: section
4 says only that Hood Ride handles no payment and any arrangement is between
rider and driver (the no-profit rule is parked below). A lawyer's check is
still advised.

- **The server is the truth:** until the account has agreed to the CURRENT
  version (`Hoodride.Terms.version/0` — the page's effective date; TermsTest
  ties them) `/api/socket_token` answers 403 `terms`: no map, rides or
  chats. Sign-out, account deletion and both pages still work.
- **The proof:** `POST /api/terms/accept` saves `terms_accepted_at` and
  `terms_version` on the account (gone with it; the privacy page says so).
- **No database read on the token check:** the agreed version rides in the
  signed session cookie (`Auth.sign_in` copies it from the account;
  accepting adds it). A session from before an agreement made on another
  device: `/api/state` reads the account once and updates the cookie.
- **A new version** (a new date in both places): everyone is asked again;
  an open app's next token fetch gets 403 and reloads into the screen.
- The load scripts (`test_load/*.mjs`) agree through dev_login
  (`{"agree_terms": true}`); the journeys tap the real button
  (`signIn` in test_browser/cdp.mjs). The `terms` journey: the screen
  first, no token; offline → "Couldn't reach Hood Ride — try again";
  agreed → the map; reopened → not asked; a new version → asked again.

### Parked: the no-profit rule (owner, 2026-10-31)

Taken out of the live terms (payments left open, owner's choice) — kept here
word for word. Bringing it back changes the terms significantly: a new
version (`Hoodride.Terms` and the page's date), so everyone agrees again,
and TermsTest's "no money rule" test changes with it.

Section 4, as it was:

> **4. No profit.** Rides are favors between neighbors, not a business. A
> rider may offer to pay some or all of the real costs of the trip (fuel or
> electricity, tolls and parking), and the driver may accept, but no one may
> ask for or accept more than those costs, or require payment as a condition
> of the ride. Hood Ride never handles, sets or takes any payment. Any payment
> between users is solely at their own risk. Giving rides for profit can
> break the law and void your car insurance.

The "Before you start" point, as it was:

> **No profit:** a rider may cover the real costs (fuel, tolls, parking),
> nothing more.

Why it was there (research, 2026-10-31; general information, not legal
advice):

- **State rideshare (TNC) laws exempt cost-sharing carpools:** Texas
  excludes "shared expense carpool or vanpool arrangements" and rides where
  the driver's fee doesn't exceed the cost (TDLR TNC rules; Tex. Bus. & Com.
  Code § 113.0001); Florida the same (Fla. Stat. § 627.748); the NCOIL model
  act too. Texas: even rides arranged on social media need a TNC permit if
  the fee exceeds the cost. No state found uses the IRS mileage rate as
  the test.
- **Insurance:** the standard personal auto policy excludes carrying people
  "for a fee" but not a "share-the-expense car pool"; some forms add "not
  operated or arranged for profit".
- **Other carpool apps:** Lets Carpool (non-commercial; fuel or
  electricity, tolls, parking only), Waze Carpool (no profit; at most the
  IRS mileage rate), Ryde (costs, no profit).
- **Empower (DC):** "just software", drivers setting their own fares — held
  to be a vehicle-for-hire company (DC Court of Appeals, 2024), contempt and
  ~$8.85M in fines; a 2026 ruling let it give free rides.
- Open question for a lawyer: a rider covering ALL of the costs of a trip
  made only for them (insurance may see it as "for a fee").

## Open to anyone, anywhere; GDPR section (2026-10-31, BUILT)

The Terms no longer limit users to the United States (owner: anyone can
use it anywhere); "call your local emergency number (911 in the US)". The
privacy page still says where Hood Ride is RUN (the United States) — that's
the operator, not who may use it. TermsTest: no page says users must be in
the US.

The privacy page has a section for the EU, the UK and Switzerland (`#gdpr`),
GDPR Article 13's items in plain words: who's responsible (Hood Ride and the
contact address), the legal bases (contract: account, map area, rides,
requests, messages, ride location; legitimate interests: abuse prevention,
error logs, the Terms agreement record, cookieless visit
counts), the rights and how (one month to answer; the local data
protection authority), transfers (servers in the US; Cloudflare under the
EU-U.S. Data Privacy Framework and the SCCs — its DPA), that sign-in and
location are needed, no automated decisions, and retention (the table).
PrivacyTest pins each item. "For significant changes we'll tell you in the
app" is gone: no in-app notice exists for privacy changes (owner's pick).

When EU users actually appear (not solved by the page; a lawyer's call):
- **An EU representative** (GDPR Art. 27): a non-EU business offering its
  service to people in the EU must appoint one; the "occasional, low-risk"
  exemption very likely doesn't fit continuous location processing. A paid
  service, usually yearly.
- **The controller's identity:** today just "Hood Ride" and an email (no
  company); an LLC would make the company the controller.

### The contact address (2026-10-31)

The pages show **contact@hoodride.app** (owner's pick over a new Gmail).
Cloudflare **Email Routing** (free, receive-only) forwards it to the owner's
Gmail — SELF_HOSTING.md, "Make it yours". **Until hoodride.app is bought, on
Cloudflare, and routed, mail to it bounces** (Phase C). Then: send a test
from another account, check spam — forwarded mail can be filtered or, now
and then, rejected by Gmail. Google's consent screen keeps a Gmail support
address (it must be on the Google account). PrivacyTest: no @gmail.com on
the privacy page.
