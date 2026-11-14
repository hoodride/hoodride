// ============================================================
// Hood Ride — PWA frontend.
// Real mode (default): Phoenix channels — geo cells, chat,
// requests, rides. Demo mode (?demo=1, or no backend): mocks.
// ============================================================

// ===== Error reports (owner, 2026-11-10) — FIRST, before anything can throw =====
// An unexpected error: a small report to the server — WHAT broke, never who
// (HoodErrors: scrubbed, each once, at most 5 a minute / 30 a session).
// errors.js caught any error since the page began; from here the app takes
// them. The reporter is made at the first report, from what's already
// loaded — so a crash while this very file is starting is reported too.
let errorReports = null;
function reportError(e, where = "other") {
  if (typeof HoodErrors === "undefined") return; // its file didn't load: no reports
  // a network failure (no signal, a blip, the map's files) is the network,
  // not a bug — not reported (found by its own journey, 2026-11-10)
  if (HoodErrors.isNetwork(e)) return;
  if (!errorReports) {
    const br = typeof HoodSendFilter !== "undefined" ? HoodSendFilter.browserOf(navigator.userAgent, !!navigator.brave) : {};
    errorReports = HoodErrors.create({
      send: (r) => {
        // the demo talks to no server — asked at send time (a visitor's demo
        // starts after the app has); before DEMO exists: not the demo
        let demo = false;
        try {
          demo = DEMO;
        } catch (_) {}
        if (demo) return;
        fetch("/api/client-error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r), keepalive: true, credentials: "same-origin" }).catch(() => {});
      },
      now: () => Date.now(),
      build: (document.querySelector('meta[name="hoodride-build"]') || {}).content || "?",
      // ("Samsung Internet" — one word: the server takes no spaces there)
      browser: `${String(br.app || "Browser").replace(/\s+/g, "")}/${br.platform || "other"}`,
    });
  }
  errorReports.report(e, where);
}
if (typeof HoodErrors !== "undefined") HoodErrors.attach((e) => reportError(e));

// every visible message through t("…") with its English as the key
// (i18n.js; `mix hoodride.i18n.extract` collects them). Set when SHOWN,
// never once at load — the language is chosen after the scripts load
const { t, tc, tn } = HoodI18n;


const H3_RES = 8; // cell topics / registration (coarse)
const H3_DISPLAY_RES = 9; // car + hand display fuzz: ~block-level (research's ~200m sweet spot)
const AGG_RESES = [7, 5]; // aggregate-tier ladder, tried in order when markers overflow
// the one watch budget, at every altitude: the cells we ask the server for
// (screen + margin). Below the server's 120 cap (WorldChannel @max_watch)
// with headroom.
const MAX_WATCHED_CELLS = 110;
// the wire protocol this app speaks — must equal the server's
// (HoodrideWeb.WorldChannel @protocol); a mismatch offers a reload
const PROTOCOL = 3;

// ===== Auth =====
const auth = {
  devName() {
    let n = localStorage.getItem("hoodride_dev_name");
    if (!n) {
      n = "Tester-" + Math.random().toString(36).slice(2, 6);
      localStorage.setItem("hoodride_dev_name", n);
    }
    return n;
  },

  // The real provider (Google, Facebook) everywhere but this machine
  // (HoodSession.loginRoute → "dev" here). It used to call the dev login
  // and, when that failed (prod), silently enter a FAKE demo profile —
  // nobody could really sign in. Demo mode is ?demo=1 only.
  async signIn(provider) {
    if (HoodSession.loginRoute(location.hostname) !== "dev") {
      // Cloudflare's check first, when it's on (HoodTurnstile; the server
      // allows a start only with a passed one — HoodrideWeb.Turnstile)
      const meta = document.querySelector('meta[name="hoodride-turnstile"]');
      const go = await HoodTurnstile.start(provider, {
        siteKey: meta && meta.content,
        getTurnstile: () => HoodTurnstile.load(document, window),
        container: $("turnstile-box"),
        lang: HoodI18n.lang(),
        post: async (body) =>
          (
            await apiFetch("/auth/start", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
          ).json(),
      });
      if (go.url) {
        location.href = go.url;
        return new Promise(() => {}); // leaving the page
      }
      return { real: false, reason: go.error };
    }
    try {
      const res = await apiFetch("/api/dev_login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // no photo: a test account looks like anyone without one (avatar.js)
        body: JSON.stringify({ name: this.devName() }),
      });
      if (res.ok) {
        const st = await (await apiFetch("/api/state?chats=list")).json();
        if (st.user) return { real: true, state: st };
      }
    } catch (_) {}
    return { real: false };
  },

  // the old fake sign-in kept a "hoodride_user" here: gone (it's cleared on
  // load too — a browser that still has one never enters on it)
  signOut() {
    try {
      localStorage.removeItem("hoodride_user");
    } catch (_) {}
  },
};

// The car wherever the app shows one is the owner's picture (car.png) —
// never the emoji, which every phone draws its own way (and red). Text
// that starts with CAR shows the picture, then the words (setIconText).
const CAR = "\u{1F697} ";
function carIcon(cls = "car-icon") {
  const i = document.createElement("img");
  i.src = "car.png";
  i.alt = "";
  i.className = cls;
  return i;
}
// the other icons too (✋ 📍 🧭 💬): pictures, wherever the text has the
// emoji (icons.js). Each picture says which emoji it stands for
// (data-emoji) — the car's doesn't, it was always just the car.
function iconImg({ emoji, src }) {
  if (src === "car.png") return carIcon();
  const i = document.createElement("img");
  i.src = src;
  i.alt = "";
  i.className = "emoji-icon";
  i.dataset.emoji = emoji;
  return i;
}
// text: a string (its emoji shown as pictures), or a list of strings and
// {raw} — words shown exactly as written (what someone typed in a chat)
function setIconText(el, text) {
  // the same words again, still on screen: left as they are — a picture's
  // animation (the 📍 pulsing while finding your location) would start
  // over on every redraw and, redrawn often, never get past its delay
  const key = JSON.stringify(text);
  const nodes = el._iconNodes;
  if (el._iconKey === key && nodes && nodes.length === el.childNodes.length && nodes.every((n, i) => n === el.childNodes[i])) return;
  const items = Array.isArray(text) ? text : [text];
  el.replaceChildren(
    ...items.flatMap((item) =>
      typeof item === "string" ? HoodIcons.parts(item).map((x) => (typeof x === "string" ? x : iconImg(x))) : [item.raw]
    )
  );
  el._iconKey = key;
  el._iconNodes = [...el.childNodes];
}

// ===== Geo helpers =====
const DEFAULT_POS = { lat: 40.7128, lng: -74.006 };

const metersBetween = HoodSendFilter.metersBetween;

function offsetPos(pos, dxMeters, dyMeters) {
  return {
    lat: pos.lat + dyMeters / 111320,
    lng: pos.lng + dxMeters / (111320 * Math.cos((pos.lat * Math.PI) / 180)),
  };
}

function stepToward(from, to, meters) {
  const total = metersBetween(from, to);
  if (total <= meters) return { ...to };
  const frac = meters / total;
  return { lat: from.lat + (to.lat - from.lat) * frac, lng: from.lng + (to.lng - from.lng) * frac };
}

// "0.9 mi away" / "1.4 km away" / "nearby": the drive,
// estimated, in this browser's unit (HoodDistance — why 1.3, what it
// measures to, and how the unit is picked)
const UNIT = HoodDistance.unitOf(navigator.languages || [navigator.language]);
const away = (m) => HoodDistance.away(m, UNIT);

// ===== State =====
const state = {
  mode: "rider",
  me: { ...DEFAULT_POS },
  haveFix: false,
  worldSpawned: false,
  handRaised: false,
  online: false,
  ride: null, // {peer, status, id?, role?}
  pinPos: null,
  pinArmed: false,
  chatPeer: null,
  chatView: "msgs",
  cardPeer: null,
  pileKey: null, // the pile whose list is open ("type:spot"), if any
  realUser: null,
};

// Google can leave a bare "#" on its redirect back, and the browser carries
// it over our redirect to "/" (hoodride.app/#): tidy it away — same page, same
// ?query; replaceState, so no reload and no extra Back step
if (location.href.endsWith("#")) history.replaceState(null, "", location.pathname + location.search);

let DEMO = new URLSearchParams(location.search).has("demo");

let map, meMarker, pinMarker;

// ----- demo world -----
const drivers = [];
let mockHand = null;
let handPingTimer = null;
let carSheetOpener = null; // set when the car sheet opens
let demandTimer = null;
let requestTimer = null;
let bannerTimer = null;
// the message showing is location's own (transientBanner's fromLoc)
let bannerIsLoc = false;
// a request/accept on its way: the button's label while waiting, or null
// (startRideAction; here, early, because refreshControls reads it)
let rideActionInFlight = null;

// ----- real world -----
let socket = null;
let userChannel = null;
let rideChannel = null;
// the live connection: "Reconnecting…" while it's down (sync.js), and ✋ /
// Go online refused until it's back — never "they can see you" when the
// server heard nothing (owner, 2026-10-30)
const connWatch = HoodSync.createConnWatch({
  onChange: () => {
    if (!bannerTimer) setBanner(contextBanner());
  },
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (timer) => clearTimeout(timer),
});
const liveNow = () => !!userChannel && userChannel.state === "joined";
// anything that needs the server, tapped while not live: refused, and
// nothing changes on screen
const CANT_REACH = () => t("Can't reach Hood Ride — try again");
// Option B: ONE world channel multiplexes every map subscription — the
// server holds our watched cells as ~100-byte registry entries instead of
// one process per cell. These sets mirror what the server holds for us.
let worldChannel = null;
// what the app wants to watch lives in worldSync (sync.js), set up below
const aggData = new Map(); // cell → {cell, drivers, hands}
// realEntries: user_id → { peer, type: 'driver'|'hand'|'ridepeer', cell, spot,
// marker (ride partner only) }. Browse markers are drawn per PILE — one per
// (type, spot), HoodBrowse.groupMarkers — cached here by "type:spot" and
// updated in place, never rebuilt per render.
const realEntries = new Map();
const pileMarkers = new Map(); // "type:spot" → { marker, el, type, ids }
const realPeersById = new Map(); // user_id → stable peer object (chat identity)
let zoomedOutWarned = false;

// chats: Map<peer object, { msgs, unread, replyIdx, server, draft }>
// server: the server holds this conversation (from a reload, or a ride's —
// which exists from ride start even if nobody types), so it's never pruned
// draft: what's typed in it and not sent — each chat its own (opening
// another puts ITS text in the box: never sent to the wrong person), kept
// while you switch, "Draft" in the list (owner, 2026-11-07). Memory only.
const chats = new Map();
// the server's clock minus this phone's (ms), from the last /api/state:
// message times are the server's (HoodChatList.localAt)
let chatSkew = 0;
function chatFor(peer) {
  // lastAt: when its last message came, on this phone's clock (the chat
  // list: newest first, "2m" — HoodChatList). emptyAt: its time with no
  // message in it — when it was started here, or, for one a reload brought,
  // its last activity on the server — what a chat whose every message was
  // refused goes back to
  if (!chats.has(peer)) {
    peer.chatClosed = false; // a chat with them again (chat_closed)
    const now = Date.now();
    // loaded: its messages are here (a chat made on this phone always is;
    // one a reload brought as a summary isn't until it's opened — light
    // reload, owner 2026-11-08). summary: that summary {last, theirs}.
    chats.set(peer, { msgs: [], unread: 0, replyIdx: 0, server: false, lastAt: now, emptyAt: now, draft: "", loaded: true, summary: null });
  }
  return chats.get(peer);
}

// every chat's unsent text, and the box's: a reload or an update waits
// while any is there (HoodUpdate.isBusy)
function allDrafts() {
  return [$("chat-input") ? $("chat-input").value : "", ...[...chats.values()].map((c) => c.draft || "")].join("");
}

// ===== Mock peers (demo) =====
const DRIVER_SEEDS = [
  { name: "DeShawn", car: HoodCar.describe({ color: "Gray", make: "Honda", model: "Civic" }), emoji: "😎", bg: "#4a90d9" },
  { name: "Maria", car: HoodCar.describe({ color: "Red", make: "Toyota", model: "Corolla" }), emoji: "😊", bg: "#d94a8c" },
  { name: "Tony", car: HoodCar.describe({ color: "Black", make: "Ford", model: "F-150" }), emoji: "🧢", bg: "#50b86c" },
  { name: "Keisha", car: HoodCar.describe({ color: "White", make: "Nissan", model: "Altima" }), emoji: "💛", bg: "#b08ae0" },
];
const HAND_RIDER = { name: "Jaylen", emoji: "🙋", bg: "#e0a030" };
const REQUEST_RIDER = { name: "Aaliyah", emoji: "💃", bg: "#d9534a" };

// (functions: in the demo's language when said)
const DRIVER_REPLIES = () => [
  t("yo what's up"),
  t("yea I can grab you"),
  t("omw in a sec 🚗"),
  t("aight bet"),
  t("be there in a few"),
];
const RIDER_REPLIES = () => [
  t("yes please! I'm by the benches 🙏"),
  t("cool, I'll watch for you"),
  t("aight I see you"),
  "👍",
];

// ===== DOM =====
const $ = (id) => document.getElementById(id);

function show(screenId) {
  // a screen chosen: the neutral start is over (PageController.resuming)
  document.documentElement.classList.remove("resuming");
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
  // the page doesn't zoom on the map screen (styles.css html.on-map); the
  // sign-in screen stays zoomable
  document.documentElement.classList.toggle("on-map", screenId === "screen-map");
}

// ===== Banner =====
function setBanner(text) {
  const b = $("banner");
  if (!text) {
    b.classList.add("hidden");
    bannerFitted(b);
  } else {
    // laid out afresh when the text changes: Safari kept a longer text's
    // balanced wrapping (text-wrap: balance) for the shorter one after it —
    // "✋ … need a ride" went 1 line → 3 with "· nobody nearby yet" → 2 when
    // that went (owner's iPhone, 2026-11-10). Balancing off while the new
    // text goes in, back on two frames later: the browser's own layout in
    // between starts it fresh. NEVER a forced layout here (void offsetWidth):
    // it lays out the WHOLE page at once — with a 1 MB chat open, every
    // banner update took seconds and a reload missed its time
    // (lightreload2, 2026-11-10). Only when the text changes (every tick
    // calls this) and is banner-sized.
    // The box then hugs its lines (fitBanner, a frame after that): wrapped,
    // it stayed as wide as the cap, the balanced lines in its middle (owner,
    // 2026-11-10). Any new text starts unfitted — and isn't drawn until
    // fitted (.fitting): it flashed as wide as the cap for those frames
    // (owner, 2026-11-11). The banner as it was stays on screen meanwhile
    // (holdBanner); the text itself is in place at once (read, measured).
    // (only plain text is fitted: a list — a message's icon + raw text — or
    // a long text is drawn at once as it is; a list never matched its own
    // dataset copy and was kept hidden for its whole time: review, 2026-11-11)
    const fits = typeof text === "string" && text.length <= 300;
    const changed = fits && b.dataset.text !== text;
    if (changed) {
      holdBanner(b);
      b.classList.add("fitting");
      b.dataset.text = text;
      b.style.textWrap = "wrap";
      b.style.width = "";
    } else if (!fits) {
      b.dataset.text = "";
      b.style.width = "";
      bannerFitted(b);
    }
    // shown again unfitted (a rotation while it was hidden): fitted then
    const refit = !changed && !b.style.width && b.classList.contains("hidden") && b.dataset.text === text;
    if (refit) b.classList.add("fitting");
    setIconText(b, text);
    b.classList.remove("hidden");
    if (refit) requestAnimationFrame(() => requestAnimationFrame(() => (fitBanner(b, text), bannerFitted(b, text))));
    if (changed)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (b.dataset.text !== text) return;
          b.style.textWrap = "";
          requestAnimationFrame(() => (fitBanner(b, text), bannerFitted(b, text)));
        })
      );
  }
}

// the banner as it's showing now, copied to #banner-was while its new text
// is fitted. Only a banner on screen and drawn: one mid-fit keeps the copy
// already showing (the last one seen); a hidden one has nothing to keep
function holdBanner(b) {
  const was = $("banner-was");
  if (!was || !was.classList.contains("hidden") || b.classList.contains("hidden") || b.classList.contains("fitting")) return;
  was.replaceChildren(...[...b.childNodes].map((n) => n.cloneNode(true)));
  was.style.width = b.style.width;
  was.style.textWrap = b.style.textWrap;
  was.classList.remove("hidden");
}

// fitted (or nothing to fit): the banner drawn, the copy gone. For a text
// that's since been replaced, nothing — the newer one's own frames do it
function bannerFitted(b, text) {
  if (text !== undefined && b.dataset.text !== text) return;
  b.classList.remove("fitting");
  const was = $("banner-was");
  if (was && !was.classList.contains("hidden")) {
    was.classList.add("hidden");
    was.replaceChildren();
  }
}

// The banner's box as wide as its widest line. Called ONLY at the start of a
// frame after the browser's own layout of the text — reading it then costs
// nothing (never a forced layout: see setBanner). One reading per text
// change or rotation, never per tick.
function fitBanner(b, text) {
  if (!text || b.dataset.text !== text || b.classList.contains("hidden")) return;
  const range = document.createRange();
  range.selectNodeContents(b);
  const lines = range.getBoundingClientRect().width;
  const cs = getComputedStyle(b);
  const sides =
    parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  const fitted = Math.ceil(lines + sides) + 1;
  if (lines > 0 && fitted < b.getBoundingClientRect().width) b.style.width = `${fitted}px`;
}

// rotated or resized: the cap changed — the box fitted afresh (once per
// resize burst: cleared now, read two frames on, after the browser's layout).
// Not drawn unfitted meanwhile — the banner as it was shows instead, as for a
// new text. A new text's own fitting under way: left to finish it
let bannerRefit = false;
window.addEventListener("resize", () => {
  const b = $("banner");
  if (!b || (!b.style.width && !bannerRefit)) return;
  holdBanner(b);
  b.classList.add("fitting");
  b.style.width = "";
  if (bannerRefit) return;
  bannerRefit = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      bannerRefit = false;
      if (b.style.textWrap === "wrap") return;
      fitBanner(b, b.dataset.text);
      bannerFitted(b);
    })
  );
});

function contextBanner() {
  // the connection is down: say so first (the reconnect then re-reads
  // everything) — in a ride after the ride's own line, so who's coming
  // and which car stay on screen
  const lost = !DEMO && connWatch.lost();
  if (lost && !state.ride) return t("Reconnecting to Hood Ride…");
  const text = situationBanner();
  return lost ? t("{status} · Reconnecting…", { status: text }) : text;
}

function situationBanner() {
  // a tap waiting on location: what's happening, and (after a while, or if
  // the phone only gives an approximate position) what to change
  const waiting = !DEMO && loc.banner();
  if (waiting) return waiting;
  // on duty with no fix: nothing is sent, so the car isn't on anyone's map
  const noFix = !DEMO && loc.noFixBanner(state);
  if (noFix && !state.ride) return noFix;
  // Meet here / Move pin armed: the hint stays until the pin is placed (any
  // banner redraw — a ride update, the demo's moving driver — keeps it)
  if (state.pinArmed) return t("📍 Tap the map where you want to meet");
  if (state.ride) {
    const peer = state.ride.peer;
    if (state.ride.status === "requested") return t("⏳ Waiting for the driver…");
    if (state.ride.status === "arrived") {
      // a minute of "arrived", then the ride itself (HoodRidePos.arrivedPhase)
      const since = state.ride.arrivedAt == null ? null : performance.now() - state.ride.arrivedAt;
      if (HoodRidePos.arrivedPhase(since) === "riding")
        return CAR + t("Ride with {name}", { name: peer.name }) + (state.mode === "rider" ? HoodCar.inLine(peer.car) : "");
      return state.mode === "rider"
        ? CAR + t("{name} has arrived", { name: peer.name }) + HoodCar.inLine(peer.car)
        : CAR + t("You've arrived · picking up {name}", { name: peer.name });
    }
    // a stale partner position says so (ridepos.js: e.g. a driver in Google
    // Maps — a backgrounded web app gets no GPS)
    const seen = HoodRidePos.lastSeen(partnerAgeMs());
    return state.mode === "rider"
      ? CAR + t("{name} is on the way", { name: peer.name }) + HoodCar.inLine(peer.car) + (seen ? " · " + seen : "")
      : seen
        ? t("Picking up {name} · {seen} · tap 🧭 to navigate", { name: peer.name, seen })
        : t("Picking up {name} · tap 🧭 to navigate", { name: peer.name });
  }
  // looked around you, nobody yet (findNearest) — until someone shows up
  // (only about whom you look for NOW: a reconnect can make a rider who was
  // told "nobody" an online driver — that line was about cars)
  const nobody = nobodyNear && nobodyType === HoodNearby.lookingFor(state);
  if (state.mode === "driver" && state.online)
    return nobody ? t("🟢 You're online · nobody nearby yet") : t("🟢 You're online");
  if (state.mode === "rider" && state.handRaised)
    return nobody ? t("✋ Nearby drivers can see you need a ride · nobody nearby yet") : t("✋ Nearby drivers can see you need a ride");
  return null;
}

// ms: how long it stays (location steps are long: they get longer)
// `fromLoc`: location's own message ("location is off", "approximate…") —
// the next reading's redraw replaces it, as it always did: a good reading
// a second later must not leave "location is off" up (review, 2026-11-12)
function transientBanner(text, ms = 3500, fromLoc = false) {
  clearTimeout(bannerTimer);
  bannerIsLoc = fromLoc;
  setBanner(text);
  bannerTimer = setTimeout(() => {
    bannerTimer = null;
    bannerIsLoc = false;
    setBanner(contextBanner());
  }, ms);
}

// a ✋ / GO ONLINE tap (or its cancel): the person acting — a message on
// screen gives way to what the tap shows ("Finding your location…"); only a
// location reading's own redraw leaves a message alone (redrawBanner)
function locTap(which) {
  clearTimeout(bannerTimer);
  bannerTimer = null;
  bannerIsLoc = false;
  if (which === "hand") loc.tapHand();
  else loc.tapOnline();
}

// ===== Login wiring =====
async function handleLogin(provider, button) {
  const label = button.querySelector("span");
  const original = label.textContent;
  button.disabled = true;
  label.textContent = t("Signing in…");
  try {
    const result = await auth.signIn(provider);
    if (result.real) {
      await startSignedIn(result.state);
    } else if (result.reason === "blocked") {
      // the check couldn't run here (a blocker, a strict privacy setting)
      label.textContent = t("Couldn't check your browser — allow challenges.cloudflare.com, or try another browser");
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      label.textContent = t("Couldn't sign in — try again");
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    button.disabled = false;
    label.textContent = original;
  }
}

// a sign-in button only for a provider that works (the server stamps the
// list on the page — PageController; Facebook once configured, or in dev)
(() => {
  const meta = document.querySelector('meta[name="hoodride-providers"]');
  const offered = meta ? meta.content.split(",") : ["google"];
  $("btn-facebook").classList.toggle("hidden", !offered.includes("facebook"));
})();

// a photo that fails to load (an expired or removed one, any provider) shows
// what everyone without a photo gets — their initial (avatar.js; the <img>
// says whose it is: data-name) — never a broken image. Capture phase:
// image errors don't bubble.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.classList.contains("avatar") && !img.classList.contains("account-photo")) return;
    // the same <img> is reused (the peer card): no sticky flag — but never
    // swap the fallback for itself (no loop, even if it failed)
    const failed = img.src;
    const fallback = HoodAvatar.url(img.dataset.name);
    if (img.src !== fallback) img.src = fallback;

    // our own photo (a weak signal, a busy server): try again a little
    // later, at most twice (HoodAvatarRetry) — only if that image is still
    // on screen and still showing the initial (the reused <img> may show someone
    // else by now)
    if (!HoodAvatarRetry.ours(failed)) return;
    const done = Number(img.dataset.avatarRetries || 0);
    const wait = HoodAvatarRetry.retryDelay(done);
    if (wait == null) return;
    img.dataset.avatarRetries = String(done + 1);
    setTimeout(() => {
      if (img.isConnected && img.src === fallback) img.src = HoodAvatarRetry.retryUrl(failed, done + 1);
    }, wait);
  },
  true
);
// one of OUR photos that loaded starts its retry count afresh (the <img> is
// reused) — never the initial: it loads every time, and resetting on it retried
// a missing photo forever (caught in Chrome)
document.addEventListener(
  "load",
  (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && HoodAvatarRetry.ours(img.src)) delete img.dataset.avatarRetries;
  },
  true
);

$("btn-google").addEventListener("click", (e) => handleLogin("google", e.currentTarget));
$("btn-facebook").addEventListener("click", (e) => handleLogin("facebook", e.currentTarget));
// ===== Settings (your photo, top left → a drawer from the left) =====
// Sign out sits here, two taps away and far from Drive and the main button,
// so it's never a misclick. More rows (name, avatar…) go in the list as built.

// your sign-in photo; without one, your initial — what everyone else sees
// for you too
function myName() {
  return state.realUser ? state.realUser.name : t("Demo");
}
function myPhoto() {
  return (state.realUser && state.realUser.photo) || HoodAvatar.url(myName());
}

function setAccountButton() {
  $("account-photo").dataset.name = myName();
  $("account-photo").src = myPhoto();
  const name = state.realUser ? state.realUser.name : t("Demo");
  $("btn-account").setAttribute("aria-label", t("Settings ({name})", { name }));
}

// (a declaration, hoisted: refreshControls may run before this line)
function settingsOpen() {
  return $("settings-sheet").classList.contains("open");
}

// Name and photo come ONLY from the sign-in (no changing them in Hood Ride:
// the provider owns and moderates them). Where to change them, by provider
// — Facebook joins here when its sign-in is built.
const PROVIDERS = {
  google: { label: "Google", url: "https://myaccount.google.com/personal-info" },
  facebook: { label: "Facebook", url: "https://accountscenter.facebook.com/profiles" },
};

// Your name and photo (owner, 2026-10-29): a small "Change" under your
// name opens a box — where they come from, "Change on Google ↗", and
// "Refresh from Google". The W3C disclosure pattern: a real button with
// aria-expanded, the box `hidden` while shut.
function renderSource() {
  const p = state.realUser && PROVIDERS[state.realUser.provider];
  const link = $("settings-source-link");
  // only for a known sign-in (none in the demo or for a dev account)
  $("settings-change").classList.toggle("hidden", !p);
  if (p) {
    $("settings-source").textContent = t("Your name and photo come from {provider}", { provider: p.label });
    link.href = p.url;
    link.textContent = t("Change on {provider} ↗", { provider: p.label });
  }
  // Refresh: always in the box for Google (opening it says you came for
  // this) — in a ride a note instead: the round trip reloads the page
  const google = !!state.realUser && state.realUser.provider === "google";
  $("settings-refresh").classList.toggle("hidden", !google || !!state.ride);
  $("settings-refresh-later").classList.toggle("hidden", !google || !state.ride);
}

function setChangeBox(open) {
  const box = $("settings-change-box");
  box.hidden = !open;
  $("settings-change").setAttribute("aria-expanded", String(open));
}

$("settings-change").addEventListener("click", () => {
  const box = $("settings-change-box");
  const open = box.hidden;
  box.hidden = !open;
  $("settings-change").setAttribute("aria-expanded", String(open));
});

// "Change on Google ↗" opens Google's Personal info: a refresh is now due
// (taken the next time you're back — tryGoogleRefresh)
$("settings-source-link").addEventListener("click", () => {
  HoodGoogleRefresh.changeTapped(storageOrNull());
  awayFromApp = false;
});
// the button IS the refresh: nothing left for the automatic one to do
$("settings-refresh-link").addEventListener("click", () => HoodGoogleRefresh.take(storageOrNull()));

// The automatic refresh (googlerefresh.js): due, a Google account, back
// from being away, and nothing in progress — the busy rule app updates
// use (HoodUpdate.isBusy) — then ONE silent Google round trip. "due" is
// cleared first, so a failure can't loop. "Back": the page shown again,
// focus, a restored page, or opening the app (onSignedIn)
// what's in progress, for the busy rule (HoodUpdate.isBusy) — the app
// update's silent reload and the Google refresh's round trip both wipe the
// page: never while any of it is going on. The car form open: what's typed
// in it would go (U2, owner 2026-11-11)
function busyView() {
  return {
    mode: state.mode,
    online: state.online,
    handRaised: state.handRaised,
    ride: state.ride,
    draft: allDrafts(),
    form: carSheetOpen(),
  };
}
let awayFromApp = false;
let googleRefreshing = false;
function tryGoogleRefresh() {
  if (DEMO || !state.realUser || googleRefreshing) return;
  // stepped aside: Google's answer would come back as a new page load
  if (steppedAside()) return;
  const go = HoodGoogleRefresh.shouldRefresh({
    due: HoodGoogleRefresh.isDue(storageOrNull()),
    google: state.realUser.provider === "google",
    away: awayFromApp,
    busy: HoodUpdate.isBusy(busyView()),
  });
  if (!go) return;
  googleRefreshing = true;
  HoodGoogleRefresh.take(storageOrNull());
  location.href = "/auth/google?refresh=silent";
}
function onGoogleRefreshVisibility() {
  if (document.visibilityState === "hidden") awayFromApp = true;
  else tryGoogleRefresh();
}
document.addEventListener("visibilitychange", onGoogleRefreshVisibility);
window.addEventListener("blur", () => (awayFromApp = true));
window.addEventListener("focus", tryGoogleRefresh);
window.addEventListener("pageshow", tryGoogleRefresh);

function renderSettings() {
  $("settings-photo").dataset.name = myName();
  $("settings-photo").src = myPhoto();
  $("settings-name").textContent = state.realUser ? state.realUser.name : t("Demo");
  renderSource();
  // in a ride (or with a request waiting) signing out would vanish on your
  // partner: end it first — either side can, one tap (End ride / Cancel request)
  const requested = state.ride && state.ride.status === "requested";
  const busy = !!state.ride;
  const blocked = requested ? t("Cancel your ride request first") : t("End your ride first");
  // the demo: "Leave demo", any time, and no account to delete (owner,
  // 2026-11-02)
  $("btn-logout").querySelector(".settings-label").textContent = DEMO ? t("Leave demo") : t("Sign out");
  $("btn-logout").disabled = busy && !DEMO;
  $("logout-note").textContent = DEMO ? t("Back to the sign-in page") : busy ? blocked : t("On all your devices");
  $("delete-wrap").classList.toggle("hidden", DEMO);
  // the server refuses it then too (409): the same rule as signing out —
  // the sign-out row's note just above says why
  $("btn-delete").disabled = busy;
  // a ride started while the confirmation was open: back out of it
  if (busy) hideDeleteConfirm();
  // your car: read when Settings opens, not on every page load. In the
  // demo too (owner, 2026-11-13): kept on the page, never sent (saveCar)
  if (DEMO && state.myCar === undefined) state.myCar = null;
  renderCarNote();
  renderNavAppNote();
  if (!DEMO && state.myCar === undefined) loadMyCar().then(renderCarNote);
}

// ----- delete account: a second, explicit step -----
// and typed, not just tapped (owner, 2026-11-04): the red button wakes only
// once the box says DELETE — any case, spaces ignored (a phone capitalizes
// the first letter by itself); the server checks the same word. In the
// reader's language (Cloudscape: the confirmation word is localized —
// "ELIMINAR"); DELETE always works too (owner, 2026-11-04)
const deleteWord = () => tc("the word typed to delete the account", "DELETE");
// compared the forgiving way, as the server does (Hoodride.I18n.typed_word):
// no capitals, no accents or dots — "STERGE" for ȘTERGE, "sil" for SİL
// (Turkish's two i's), spaces around ignored (translators, 2026-11-04)
const plainWord = (s) =>
  s.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i");
const deleteTyped = () => {
  const typed = plainWord($("delete-typed").value);
  return typed === "delete" || typed === plainWord(deleteWord());
};

function showDeleteConfirm() {
  if (state.ride) return;
  $("delete-error").classList.add("hidden");
  // every time empty and locked: never left half-typed from last time
  $("delete-typed").value = "";
  $("delete-yes").disabled = true;
  $("settings-sheet").classList.add("confirming");
  $("delete-cancel").focus(); // the safe choice has focus
}

function hideDeleteConfirm() {
  $("settings-sheet").classList.remove("confirming");
}

async function deleteAccount() {
  if (state.ride || !deleteTyped()) return;
  $("delete-yes").disabled = true;
  const fail = (msg) => {
    $("delete-error").textContent = msg;
    $("delete-error").classList.remove("hidden");
    $("delete-yes").disabled = !deleteTyped();
  };
  let res;
  try {
    res = await apiFetch("/api/account/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: $("delete-typed").value }),
    });
  } catch (_) {
    return fail(t("Couldn't reach Hood Ride — check your connection and try again."));
  }
  if (res.ok) {
    // the same clean-up as signing out, and the remembered mode too: this
    // device keeps nothing of it
    forgetStoredSpot();
    HoodModeStore.forget(storageOrNull(), state.realUser.id);
    HoodViewStore.forget(storageOrNull(), state.realUser.id);
    HoodReadStore.forget(storageOrNull(), state.realUser.id);
    loc.stop();
    auth.signOut();
    location.reload();
    return;
  }
  const reason = (await res.json().catch(() => ({}))).error;
  if (reason === "in_ride") return fail(t("End your ride first."));
  if (reason === "request_waiting") return fail(t("Cancel your ride request first."));
  if (res.status === 401) return location.reload(); // already signed out
  if (reason === "confirm") return fail(t("Type {word} to confirm.", { word: deleteWord() }));
  fail(t("Couldn't delete your account — please try again."));
}

$("btn-delete").addEventListener("click", showDeleteConfirm);
$("delete-cancel").addEventListener("click", () => {
  hideDeleteConfirm();
  $("btn-delete").focus();
});
$("delete-yes").addEventListener("click", deleteAccount);
$("delete-typed").addEventListener("input", () => {
  $("delete-yes").disabled = !deleteTyped();
});
// Enter (the keyboard's "done") deletes only once the word is right
$("delete-typed").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (deleteTyped()) deleteAccount();
  }
});

// open/shut by class, so it slides; `inert` while shut keeps its buttons out
// of reach (tab order, screen readers) though it's only moved off screen
function openSettings() {
  closeMapOverlays();
  // the Change box never stays open by surprise
  setChangeBox(false);
  renderSettings();
  const drawer = $("settings-sheet");
  drawer.inert = false;
  drawer.classList.add("open");
  $("settings-backdrop").classList.add("open");
  $("btn-account").setAttribute("aria-expanded", "true");
  // the name at the top (the drawer's label), not ✕: code-moved focus on a
  // button can draw a ring after a tap (W3C dialog pattern: a static
  // element at the top, tabindex="-1")
  $("settings-name").focus();
}

// A key (Escape, or Enter/Space on a button: a click with detail 0) — not a
// tap or a click
function byKeyboard(e) {
  return e instanceof KeyboardEvent || (!!e && e.type === "click" && e.detail === 0);
}

// Closing a dialog puts focus back on what opened it (W3C dialog pattern).
// After a tap, without a ring — focus moved by code can inherit one (Safari)
// — focusVisible: false (Safari 18.4+, Firefox 104+, Chrome 145+; older
// browsers ignore it). After a key, the ring, so keyboard users see where
// they are. Never scrolls: an off-screen target would scroll its container
function returnFocus(el, e) {
  el.focus(byKeyboard(e) ? { preventScroll: true } : { focusVisible: false, preventScroll: true });
}

function closeSettings(e) {
  if (!settingsOpen()) return;
  const drawer = $("settings-sheet");
  drawer.classList.remove("open");
  hideDeleteConfirm(); // reopening starts from the drawer, never mid-confirm
  drawer.inert = true;
  $("settings-backdrop").classList.remove("open");
  $("btn-account").setAttribute("aria-expanded", "false");
  returnFocus($("btn-account"), e);
}

// ----- "Your car" (HoodCar; ARCHITECTURE.md "Your car") -----
// What riders look for: color, make, model (no plate). The app asks for it
// before a driver first goes online (riders can't find "Driver"). Read from
// the server only when needed — Settings, becoming a driver — and kept here:
// undefined = not read yet, null = none set.
// one ask at a time: Settings redraws often while the car is unknown —
// offline, every redraw sent another overlapping request (review
// 2026-11-14). A second ask joins the one under way
let carLoading = null;
function loadMyCar() {
  if (carLoading) return carLoading;
  carLoading = (async () => {
    try {
      const res = await apiFetch("/api/car");
      if (!res.ok) return false;
      state.myCar = (await res.json()).car;
      return true;
    } catch (_) {
      return false;
    }
  })().finally(() => (carLoading = null));
  return carLoading;
}

function renderCarNote() {
  $("car-note").textContent =
    state.myCar === undefined ? "" : state.myCar ? HoodCar.describe(state.myCar) : t("Add it before you drive");
}

function carSheetOpen() {
  return !$("car-sheet").classList.contains("hidden");
}

// goOnline: opened by Go online (no car yet) — saving then goes online
// From Settings it opens OVER the drawer, which stays (owner, 2026-11-13: as
// the language list does — closing it is back in Settings, not on the map)
function openCarSheet({ goOnline = false } = {}) {
  const car = state.myCar || {};
  $("car-color").value = car.color || "";
  $("car-make").value = car.make || "";
  $("car-model").value = car.model || "";
  hideMakes();
  for (const id of ["car-color", "car-make", "car-model"]) $(id).removeAttribute("aria-invalid");
  $("car-error").classList.add("hidden");
  $("car-title").textContent = goOnline ? t("Add your car") : t("Your car");
  $("car-why").textContent = goOnline
    ? t("Riders look for it when you pick them up. Add it to go online.")
    : t("Riders see this so they can find you");
  $("car-save").textContent = goOnline ? t("Save & go online") : t("Save");
  $("car-save").disabled = false;
  $("car-sheet").dataset.goOnline = goOnline ? "1" : "";
  // where focus goes back on close: Drive (going online), else its row in
  // Settings (still open under it)
  carSheetOpener = goOnline ? $("btn-mode") : $("btn-car");
  $("car-backdrop").classList.remove("hidden");
  $("car-sheet").classList.remove("hidden");
  // the title, not the color dropdown: on iPhone a focused <select> opens
  // its picker at once (WAI-ARIA dialog: a static element at the top is fine)
  $("car-title").focus();
}

function closeCarSheet(e) {
  $("car-sheet").classList.add("hidden");
  $("car-backdrop").classList.add("hidden");
  returnFocus(carSheetOpener, e);
  // new Terms came while it was open: asked now (refusedReload)
  if (reloadAfterCarForm) location.reload();
}

function carError(msg, fields = []) {
  for (const f of ["color", "make", "model"])
    $("car-" + f).setAttribute("aria-invalid", fields.includes(f) ? "true" : "false");
  $("car-error").textContent = msg;
  $("car-error").classList.remove("hidden");
}

// (functions: translated when shown)
const CAR_FIELD_NAMES = { color: () => t("color"), make: () => t("make"), model: () => t("model") };
function carFieldsMessage(fields) {
  return t("Check the {fields} (up to {max} letters each).", {
    fields: fields.map((f) => CAR_FIELD_NAMES[f]()).join(", "),
    max: HoodCar.MAX,
  });
}

async function saveCar(e) {
  e.preventDefault();
  const car = HoodCar.tidy({ color: $("car-color").value, make: $("car-make").value, model: $("car-model").value });
  const wrong = HoodCar.problems(car);
  if (wrong.length) return carError(carFieldsMessage(wrong), wrong);
  // the demo: the same checks, kept on this page only — no account, no server
  if (DEMO) {
    state.myCar = car;
    closeCarSheet();
    return renderCarNote();
  }
  $("car-save").disabled = true;
  let res;
  try {
    res = await apiFetch("/api/car", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(car) });
  } catch (_) {
    $("car-save").disabled = false;
    return carError(t("Couldn't reach Hood Ride — check your connection and try again."));
  }
  $("car-save").disabled = false;
  if (res.status === 401) return location.reload(); // signed out meanwhile
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && body.fields) return carError(carFieldsMessage(body.fields), body.fields);
  if (!res.ok) return carError(t("Couldn't save right now — try again in a moment."));
  state.myCar = body.car;
  const goOnline = $("car-sheet").dataset.goOnline === "1";
  closeCarSheet();
  renderCarNote();
  if (goOnline && state.mode === "driver" && !state.online && !state.ride) locTap("online");
}

HoodCar.COLORS.forEach((c) => $("car-color").add(new Option(HoodCar.colorName(c), c)));
// ----- the Make suggestions (HoodCar.suggest): our own list under the box -----
let makeActive = -1;
function makeOptions() {
  return [...$("car-make-list").children];
}
function showMakes() {
  const list = $("car-make-list");
  const found = HoodCar.suggest($("car-make").value);
  list.replaceChildren(
    ...found.map((m, i) => {
      const li = document.createElement("li");
      li.id = "car-make-" + i;
      li.setAttribute("role", "option");
      li.textContent = m;
      li.setAttribute("aria-selected", "false");
      // pointerdown, not click: the box keeps focus (no blur closing the list first)
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pickMake(m);
      });
      return li;
    })
  );
  makeActive = -1;
  $("car-make").removeAttribute("aria-activedescendant");
  list.classList.toggle("hidden", found.length === 0);
  $("car-make").setAttribute("aria-expanded", String(found.length > 0));
}
function hideMakes() {
  $("car-make-list").classList.add("hidden");
  $("car-make").setAttribute("aria-expanded", "false");
  $("car-make").removeAttribute("aria-activedescendant");
  makeActive = -1;
}
function pickMake(m) {
  $("car-make").value = m;
  hideMakes();
  $("car-model").focus();
}
function moveMake(step) {
  const opts = makeOptions();
  if (!opts.length) return;
  makeActive = (makeActive + step + opts.length) % opts.length;
  opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === makeActive)));
  $("car-make").setAttribute("aria-activedescendant", opts[makeActive].id);
}
$("car-make").addEventListener("input", showMakes);
$("car-make").addEventListener("blur", hideMakes);
$("car-make").addEventListener("keydown", (e) => {
  const open = !$("car-make-list").classList.contains("hidden");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!open) showMakes();
    moveMake(1);
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    moveMake(-1);
  } else if (e.key === "Enter" && open && makeActive > -1) {
    e.preventDefault(); // pick it, don't submit the form
    pickMake(makeOptions()[makeActive].textContent);
  } else if (e.key === "Escape" && open) {
    e.stopPropagation(); // close the list, not the whole form
    hideMakes();
  }
});
$("car-sheet").addEventListener("submit", saveCar);
$("car-cancel").addEventListener("click", closeCarSheet);
$("car-backdrop").addEventListener("click", closeCarSheet);
$("btn-car").addEventListener("click", () => openCarSheet());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && carSheetOpen()) closeCarSheet(e);
});

$("btn-account").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-backdrop").addEventListener("click", closeSettings);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsOpen()) closeSettings(e);
});

// a swipe left (back the way it came) closes it
(() => {
  let start = null;
  const drawer = $("settings-sheet");
  drawer.addEventListener("pointerdown", (e) => (start = { x: e.clientX, y: e.clientY }));
  drawer.addEventListener("pointerup", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = Math.abs(e.clientY - start.y);
    start = null;
    if (dx < -60 && dy < Math.abs(dx)) closeSettings();
  });
  drawer.addEventListener("pointercancel", () => (start = null));
})();

$("btn-logout").addEventListener("click", async () => {
  // the demo has no account: this row leaves it, for the sign-in page — no
  // server, nothing to forget (owner, 2026-11-02: it did nothing here)
  if (DEMO) {
    location.href = "/";
    return;
  }
  if (state.ride) return; // (the row is disabled then; belt and braces)
  // the server signs out first; only then does this phone forget anything.
  // If it couldn't, NOTHING changed (still signed in everywhere): say so,
  // never reload into a half-signed-out app
  let res;
  try {
    res = await apiFetch("/api/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch (_) {
    return transientBanner(t("Couldn't reach Hood Ride — try again"));
  }
  if (!res.ok && res.status !== 401) {
    // refused by the server too (409): a ride or a request this phone hadn't heard of yet
    const reason = (await res.json().catch(() => ({}))).error;
    if (reason === "in_ride") return transientBanner(t("End your ride first"));
    if (reason === "request_waiting") return transientBanner(t("Cancel your ride request first"));
    return transientBanner(t("Couldn't sign out — try again"));
  }
  forgetStoredSpot(); // a shared phone: the next person doesn't inherit it
  HoodGoogleRefresh.forget(storageOrNull());
  HoodViewStore.forget(storageOrNull(), state.realUser.id); // privacy page: signing out removes it
  HoodReadStore.forget(storageOrNull(), state.realUser.id); // and which messages you've read
  loc.stop();
  auth.signOut();
  location.reload();
});

// "Before you start": the Terms, agreed once (clickwrap; Hoodride.Terms).
// Resolves when the server has saved it; a failure says so and the button
// stays, to try again
function agreeToTerms() {
  show("screen-terms");
  return new Promise((resolve) => {
    const btn = $("btn-agree");
    const err = $("terms-error");
    btn.onclick = async () => {
      btn.disabled = true;
      err.classList.add("hidden");
      let res = null;
      try {
        res = await apiFetch("/api/terms/accept", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      } catch (_) {}
      if (res && res.status === 401) return location.reload(); // signed out meanwhile
      if (res && res.ok) {
        btn.onclick = null;
        return resolve();
      }
      btn.disabled = false;
      err.textContent = res ? t("Couldn't save that — try again") : t("Couldn't reach Hood Ride — try again");
      err.classList.remove("hidden");
    };
  });
}

// ===== App entry =====
// signed in — the ONE way in, for a page load and for the test login's
// button alike: the Terms of Use first, once per account (and again for a
// new version), never the map before — the server gives no connection token
// until then. (The button used to open the map straight away; the refused
// token then reloaded the page into the Terms — owner, 2026-11-04)
async function startSignedIn(data) {
  state.realUser = data.user;
  if (data.terms_agreed === false) await agreeToTerms();
  // (no map possible here: said so, nothing more — enterApp)
  if (!(await enterApp())) return;
  hydrate(data);
}

// → false when this browser can't draw the map (initMap): nothing more then
async function enterApp() {
  if (!state.realUser) DEMO = true;
  show("screen-map");
  setAccountButton();
  // the map FIRST: it needs no connection. Made after it, the map was blank
  // for as long as the connection's pass took (up to 15 s on a weak
  // signal), and a ◎ tap meanwhile lost the blue dot (crash review
  // 2026-11-14; test_browser/mapstart.mjs). Once the world channel joins it
  // asks for what's on the map (joinWorldChannel).
  if (!map && !initMap()) return false;
  if (state.realUser && !socket) await connectSocket();
  requestWakeLock();
  return true;
}

// ===== Real peers =====
function ensurePeer(profile) {
  let peer = realPeersById.get(profile.id);
  if (!peer) {
    peer = {
      kind: "person",
      id: profile.id,
      name: profile.name || "…",
      photo: profile.photo || null,
      pos: null,
      pending: false,
    };
    realPeersById.set(profile.id, peer);
  }
  if (profile.name) peer.name = profile.name;
  if (profile.photo) peer.photo = profile.photo;
  // a driver's car, as their rider sees it (only riders are sent one)
  if ("car" in profile) peer.car = carOf(profile);
  return peer;
}

// a car as the reader reads it: from its parts, in their language's order
// ("Nissan Altima blanco" — HoodCar.describe); a server from before sends
// only the English description
function carOf(x) {
  return x.car_parts ? HoodCar.describe(x.car_parts) : x.car;
}

// ===== Socket + user channel =====
// THE DEVICE YOU CHOSE LAST WINS (session.js, Hoodride.SessionStamp). This
// tab's stamp: null until the server gives it one, so the page load's
// connect is a choice; every later (automatic) connect carries it. Our
// silent update reload hands it over — it never takes over.
let sessionStamp = HoodSession.takeQuietReload(tabStorage());

function tabStorage() {
  try {
    return window.sessionStorage;
  } catch (_) {
    return undefined; // blocked storage: every page load is a choice
  }
}

// the session moved to another device or tab: stop auto-reconnecting FIRST
// (otherwise the two would keep kicking each other), then offer a way back.
// Told live on the user channel, or as the answer to any join of a socket
// that came back after a newer choice.
function onSessionMoved() {
  // (nothing looks on behind the cover)
  stopFindNearest();
  if (socket) socket.disconnect();
  showSessionMoved();
}
// the "Use here" cover is up: this tab stepped aside — nothing reloads or
// navigates on its own until the person taps "Use here"
const steppedAside = () => !!document.getElementById("session-moved");

// One account per tab (owner, 2026-11-08). Every tab of a browser shares one
// sign-in: when the browser becomes another account (another tab signed out
// and in…) while this tab still shows the first, its requests used to act on
// the other one — delete account, save car, sign out — and draw its data as
// this one's. Every /api request now says which account this tab shows
// (HoodrideWeb.SameUser); another account signed in → refused, nothing done,
// and this tab steps aside under the "Use here" cover IN PLACE (no reload:
// "Use here" reloads as whoever is really signed in). Checked on the HEADER —
// logout's own 409s carry a body its caller reads. The answer never comes
// (the caller shows no error, and builds no socket). window.fetch looked up
// at each call: the journeys wrap it.
// EVERY request gives up after API_TIMEOUT_MS (owner, 2026-11-13): fetch has
// no time limit of its own, and on a phone a connection can die silently
// (wifi to mobile data, a lift) — a request then waited for ever, and
// whatever waited on it with it: the loading screen (its retries wait on the
// first try), Save greyed out, a reconnect that never caught up. Given up,
// it fails like any network failure and the usual "try again" takes over
// (test_browser/hungrequest.mjs). An AbortController and a timer — not
// AbortSignal.timeout/any: those need iOS 16 / 17.4. A caller with its own
// signal (the chat's load) keeps its own deadline. The timer is never
// cleared: an abort after the answer has been read does nothing, and one
// mid-body (a body still trickling in at the limit) is a failure too.
const API_TIMEOUT_MS = 15_000;
function apiFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (state.realUser) headers.set("x-hood-user", String(state.realUser.id));
  let signal = opts.signal;
  if (!signal) {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), API_TIMEOUT_MS);
    signal = stop.signal;
  }
  return window.fetch(url, { ...opts, headers, signal }).then((res) => {
    if (res.headers.get("x-hood-other-account") !== "1") return res;
    onSessionMoved();
    return new Promise(() => {});
  });
}
const sessionMovedReply = (e) => !!e && e.reason === "session_moved";

// A join refused "signed_out": the sign-in this connection was made from is
// gone (signed out on another device, or the account deleted —
// HoodrideWeb.SessionGate). Stop reconnecting, then ask the server: really
// signed out → the sign-in screen; still signed in (the pass came from an
// older sign-in) → connect again with a fresh pass. Never a reload loop.
const signedOutReply = (e) => !!e && e.reason === "signed_out";
let signedOutCheck = null;
function onJoinSignedOut() {
  if (signedOutCheck) return;
  socket.disconnect();
  signedOutCheck = (async () => {
    try {
      const res = await apiFetch("/api/socket_token");
      if (refusedReload(await ownRefusal(res))) return;
      if (res.ok) {
        socketToken = (await res.json()).token;
        socketTokenAt = performance.now();
      }
    } catch (_) {}
    signedOutCheck = null;
    socket.connect();
  })();
}

// Hood Ride's OWN "not signed in" / "Terms first" answer — never just any
// 401/403 (a proxy's challenge page must not reload the app). → which
// ("unauthenticated" | "terms"), or false
async function ownRefusal(res) {
  if (res.status !== 401 && res.status !== 403) return false;
  try {
    const body = await res.json();
    return !!body && (body.error === "unauthenticated" || body.error === "terms") ? body.error : false;
  } catch (_) {
    return false;
  }
}

// refused (ownRefusal's answer): the reload shows the sign-in screen or asks
// for the Terms. New Terms with the car form open: the moment the form
// closes — saved or cancelled — not before (what's typed in it would go;
// saving it still works: the car save doesn't ask for the Terms — owner,
// 2026-11-11). Signed out: at once (nothing can be saved). → refused?
let reloadAfterCarForm = false;
function refusedReload(why) {
  if (!why) return false;
  if (why === "terms" && carSheetOpen()) reloadAfterCarForm = true;
  else location.reload();
  return true;
}

// browsers authenticate the socket with a signed token (session-cookie
// websocket auth requires a CSRF token our static page doesn't have)
// The socket's token: sent in the WebSocket protocol header (Phoenix
// authToken), never the URL — so never in a proxy's access log. It lives a
// day and dies at sign-out (HoodrideWeb.Auth): after a failed connect a fresh
// one is fetched (at most once a minute); "signed out" → back to the login.
let socketToken = null;
let socketTokenAt = -Infinity;
// failed connects since the socket was last open (onError)
let failsSinceOpen = 0;
// {min, max} ms after the server says "restarting" (a deploy), until connected
let restartNotice = null;

async function refreshSocketToken() {
  socketTokenAt = performance.now();
  try {
    const res = await apiFetch("/api/socket_token");
    // signed out (here or elsewhere), or new Terms of Use while the app was
    // open: the reload shows the sign-in screen or asks for the Terms
    if (refusedReload(await ownRefusal(res))) return;
    if (res.ok) {
      const body = await res.json();
      socketToken = body.token;
      // the second way to hear of a new version (the first is the map join
      // reply): a tab that CAN'T connect still gets "Update available"
      if (body.build) {
        serverBuild = body.build;
        checkForUpdate();
      }
    }
  } catch (_) {}
}

async function connectSocket() {
  await refreshSocketToken();

  // jittered reconnect/rejoin (sync.js reconnectBackoff). Phoenix calls these
  // fresh for every attempt (counting from 1) and resets once connected.
  socket = new Phoenix.Socket("/socket", {
    // read for EVERY connect attempt (functions): the stamp and token may be new
    params: () => HoodSession.connectParams(sessionStamp),
    authToken: () => socketToken || "",
    // a planned restart announced (restartNotice): the first reconnect
    // lands inside the server's window, not the growing backoff
    reconnectAfterMs: (attempt) => HoodSync.restartWait(attempt, restartNotice),
    rejoinAfterMs: (attempt) => HoodSync.reconnectBackoff(attempt),
  });
  // connected again: the restart (if any) is over
  socket.onOpen(() => {
    failsSinceOpen = 0;
    restartNotice = null;
    connWatch.up();
  });
  socket.onClose(() => connWatch.down());
  // live news a state snapshot could be overtaken by (softReload)
  socket.onMessage((m) => {
    if (HoodRehydrate.countsAsLive(m)) liveNews++;
  });
  // a refused or dropped connect: the token may have expired or been revoked.
  // The FIRST failure after being connected asks at once (signed out on
  // another device → the sign-in screen in seconds, not after a minute of
  // "Reconnecting…"); after that at most once a minute (a server down for a
  // while isn't asked by every phone every few seconds)
  socket.onError(() => {
    connWatch.down();
    const since = performance.now() - socketTokenAt;
    if ((failsSinceOpen++ === 0 && since > 5_000) || since > 60_000) refreshSocketToken();
  });
  socket.connect();
  joinWorldChannel(); // its join callback runs the first subscription sync
  userChannel = ownNews(socket.channel(`user:${state.realUser.id}`));

  // the server deleted a conversation (the other person has been gone past
  // grace): clear it here too, instead of leaving a chat that can't be used
  // the server is about to restart (a deploy): reconnect inside its window
  userChannel.on("restarting", ({ min_ms, max_ms }) => {
    restartNotice = { min: min_ms, max: max_ms };
  });

  // ended_by: someone tapped End chat (the chat fix, 2026-11-12) — else the
  // server ended it (someone away past grace)
  userChannel.on("chat_closed", ({ peer_id, ended_by }) =>
    closeChatWith(
      realPeersById.get(peer_id),
      ended_by == null ? null : ended_by === peer_id ? "peer" : ended_by === state.realUser.id ? "me" : null
    )
  );

  userChannel.on("msg", (m) => {
    const peer = ensurePeer(m.from);
    if (m.spot) rememberShared(peer, { spot: m.spot, age_ms: 0 });
    receiveMsg(peer, m.text, { ts: m.ts, id: m.id });
    refreshChatDistance();
  });

  userChannel.on("request", ({ from, spot }) => {
    const peer = ensurePeer(from);
    if (spot) rememberShared(peer, { spot, age_ms: 0 });
    peer.pending = true;
    receiveMsg(peer, t("📩 requested a ride"));
    refreshControls();
  });

  userChannel.on("request_cancelled", ({ from_id }) => {
    const peer = realPeersById.get(from_id);
    if (peer) {
      peer.pending = false;
      receiveMsg(peer, t("(request withdrawn)"));
      refreshControls();
    }
  });

  // about ONE driver's request (by_id): a late one for an older request
  // never wipes a newer (HoodrideWeb.RideGuardsWiringTest)
  userChannel.on("request_declined", ({ by_id } = {}) => {
    if (!state.ride || state.ride.status !== "requested") return;
    if (by_id != null && state.ride.peer.id !== by_id) return;
    state.ride = null;
    transientBanner(t("Driver can't take this one — try another"));
    refreshControls();
  });

  userChannel.on("request_expired", () => {
    if (state.ride && state.ride.status === "requested") state.ride = null;
    transientBanner(t("Request expired — ask again or try another driver"));
    refreshControls();
  });

  userChannel.on("request_expired_driver", ({ from_id }) => {
    const peer = realPeersById.get(from_id);
    if (peer) peer.pending = false;
    refreshControls();
  });

  userChannel.on("ride_started", (r) => startRealRide(r));

  // this account was opened somewhere else (another device or tab)
  userChannel.on("session_moved", onSessionMoved);

  // EVERY join reloads, the first one too: the page load's /api/state was
  // fetched BEFORE this channel listened, so anything in between (a driver
  // accepting right then) was never heard. Listen first, then snapshot.
  userChannel
    .join()
    .receive("ok", (reply) => {
      // this tab's stamp: from now on its connects are automatic
      if (reply && reply.stamp) sessionStamp = reply.stamp;
      if (hydrated) softReload();
      else reloadWhenHydrated = true; // the page's first hydrate is still to come
    })
    .receive("error", (e) => {
      if (signedOutReply(e)) onJoinSignedOut();
      else if (sessionMovedReply(e)) onSessionMoved();
      // this browser signed in as another account meanwhile: step aside
      // (one account per tab — the "retrying" loop it used to be)
      else if (e && e.reason === "not_yours") onSessionMoved();
      else transientBanner(t("Connection problem — retrying"));
    });
}

// UPDATE AFTER DEPLOY (rules: update.js). The page was stamped with its
// build as it was served; every map join tells us the server's. A newer
// one: reload silently if the app is hidden and nothing is in progress,
// otherwise offer the button. Checked on every (re)join and whenever the
// app is hidden or shown again (a resumed tab often runs stale code
// without asking the server anything).
const LOADED_BUILD = (document.querySelector('meta[name="hoodride-build"]') || {}).content || null;
let serverBuild = null;

// what to do about a newer build NOW: "reload" (quietly), "offer", or none
function updateDecision() {
  return HoodUpdate.decide({
    loadedBuild: LOADED_BUILD,
    serverBuild,
    hidden: document.visibilityState === "hidden",
    busy: HoodUpdate.isBusy(busyView()),
  });
}

function checkForUpdate() {
  const action = updateDecision();
  if (action === "offer") showUpdateAvailable();
  else if (action === "reload") reloadForUpdate();
}

// let the browser fetch the new service worker first, then reload (the
// worker is network-first, so the page and its files come fresh anyway)
function reloadForUpdate() {
  // stepped aside ("Use here"): no reload of its own — checked again just
  // before reloading, the cover may have come up while the worker updated
  if (steppedAside()) return;
  // not a choice: the reloaded page keeps this tab's stamp (session.js)
  HoodSession.noteQuietReload(tabStorage(), sessionStamp);
  const sw = "serviceWorker" in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
  sw.then((r) => r && r.update())
    .catch(() => {})
    .finally(() => {
      // decided again: the update can finish once the person is BACK and
      // using the page (a hidden phone freezes the page mid-update) — it
      // reloaded under them, what they'd typed lost (review 2026-11-14).
      // Still right: reload; else the offer, their tap
      if (!steppedAside() && updateDecision() === "reload") return location.reload();
      // no stamp left behind for a later page load
      HoodSession.takeQuietReload(tabStorage());
      if (!steppedAside() && updateDecision() === "offer") showUpdateAvailable();
    });
}

// The server runs a newer build, or speaks a newer wire protocol, than this
// (cached, long-open) app. A reload fetches the new app.
function showUpdateAvailable() {
  if (document.getElementById("update-available")) return;
  const btn = document.createElement("button");
  btn.id = "update-available";
  btn.textContent = t("Update available — tap to reload");
  btn.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);" +
    "top:calc(12px + env(safe-area-inset-top));z-index:9998;padding:12px 22px;border:0;" +
    "border-radius:999px;background:#ffc107;color:#111;font:700 15px system-ui,sans-serif;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer;max-width:calc(100% - 32px)";
  btn.addEventListener("click", () => location.reload());
  document.body.appendChild(btn);
}

function showSessionMoved() {
  if (document.getElementById("session-moved")) return;
  const el = document.createElement("div");
  el.id = "session-moved";
  el.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;" +
    "background:rgba(17,17,17,.94);color:#fff;font:16px system-ui,sans-serif";
  const msg = document.createElement("div");
  msg.textContent = t("Hood Ride was opened on another device");
  const btn = document.createElement("button");
  btn.id = "btn-use-here";
  btn.textContent = t("Use here");
  btn.style.cssText =
    "padding:12px 28px;border:0;border-radius:999px;background:#ffc107;" +
    "color:#111;font-weight:700;font-size:16px;cursor:pointer";
  // a fresh page reconnects on purpose and becomes the newest session
  btn.addEventListener("click", () => location.reload());
  el.append(msg, btn);
  document.body.appendChild(el);
}

// ===== Rehydration =====
// the server deleted a conversation (the other person has been gone past
// grace) — or a chat's opening found it gone (loadChat): cleared here too,
// instead of leaving a chat that can't be used. `peer` may be unknown
function closeChatWith(peer, endedBy = null) {
  // on screen: their chat itself — not the list you went back to from it
  // (that closed the whole list, other chats and all — owner, 2026-11-07)
  const isOpen = !!peer && state.chatPeer === peer && !$("chat").classList.contains("hidden") && state.chatView !== "list";
  const a = HoodBrowse.chatClosedActions({
    hasChat: !!peer && chats.has(peer),
    isOpen,
    name: peer ? peer.name : "",
    endedBy,
  });
  if (a.remove) {
    chats.delete(peer);
    // closed by the server — what a send failing afterwards needs to know
    // (a chat missing after a reload isn't closed: unsay)
    peer.chatClosed = true;
  }
  if (a.close) {
    state.chatPeer = null;
    closeChat();
  } else if (state.chatView === "list" && !$("chat").classList.contains("hidden")) {
    // the list: drawn again — or, nothing left in it, closed (not an empty
    // "Chats" panel; a reload does the same — softReload)
    if (chats.size) renderChat();
    else closeChat();
  }
  if (a.banner) transientBanner(a.banner);
  refreshControls();
}

// a message from the server, as this app keeps it (a reload, and a chat's
// messages when it's opened)
function fromServer(m) {
  return {
    text: m.text,
    mine: m.from === state.realUser.id,
    at: HoodChatList.localAt(m.ts, chatSkew),
    // the server's time and id: what "read up to" compares (HoodReadStore)
    ts: m.ts,
    id: m.id,
  };
}

// a chat's place in the list: its last message's time and id — else, not
// opened since a reload, its summary's last message — else when it began
function settleLast(c) {
  const last = c.msgs[c.msgs.length - 1];
  const s = c.summary && c.summary.last;
  if (last) {
    c.lastAt = last.at;
    c.lastId = last.id ?? null;
  } else if (s) {
    c.lastAt = HoodChatList.localAt(s.ts, chatSkew);
    c.lastId = s.id;
  } else {
    c.lastAt = c.emptyAt;
    c.lastId = null;
  }
}

function hydrate(st) {
  loadStoredSpot();
  // the mode last picked on this device (HoodModeStore) — the server's
  // state below (a ride, an online shift, riders waiting) overrides it.
  // The mode only: a driver comes back OFFLINE unless the server says
  // they're on the map.
  const savedMode = HoodModeStore.read(storageOrNull(), state.realUser.id);
  if (savedMode && !state.ride) state.mode = savedMode;
  if (state.mode === "driver" && state.myCar === undefined) loadMyCar();
  // message times are the server's; this phone's clock may be off
  chatSkew = HoodChatList.skew(st.now, Date.now());
  (st.conversations || []).forEach((c) => {
    const peer = ensurePeer(c.peer);
    const chat = chatFor(peer);
    chat.server = true;
    chat.emptyAt = HoodChatList.localAt(c.last_activity, chatSkew);
    if (Array.isArray(c.messages)) {
      // in full: the chat on screen (open_peer), or an older server
      chat.msgs = c.messages.map(fromServer);
      chat.loaded = true;
      chat.summary = null;
    } else {
      // a summary (light reload): its messages come when it's opened
      // (loadChat); meanwhile what arrives is held in msgs, not drawn
      chat.msgs = [];
      chat.loaded = false;
      chat.summary = { last: c.last || null, theirs: c.theirs || [] };
    }
    // its place in the list: the last message's time and server id (which
    // of two same-second chats is newer)
    settleLast(chat);
    if (c.peer_spot) rememberShared(peer, c.peer_spot);
  });
  applyReadState();

  (st.pending_requests || []).forEach((r) => {
    const peer = ensurePeer(r.rider);
    if (r.spot) rememberShared(peer, r.spot);
    peer.pending = true;
    // a pending request implies a driver context
    state.mode = "driver";
  });

  if (st.open_request) {
    const peer = ensurePeer(st.open_request.driver);
    state.ride = { peer, status: "requested" };
    // asking for a ride is a rider's (whatever mode was saved)
    state.mode = "rider";
  }

  if (st.ride) {
    const peer = ensurePeer(st.ride.peer);
    state.mode = st.ride.role === "driver" ? "driver" : "rider";
    state.ride = {
      peer,
      status: st.ride.arrived ? "arrived" : "connected",
      id: st.ride.id,
      role: st.ride.role,
    };
    if (st.ride.pin) applyRemotePin(st.ride.pin);
    joinRideChannel();
  }

  // a reload RESUMES live map presence instead of orphaning it:
  // your ✋ stays yours, your shift stays on duty
  if (st.hand && !state.ride) {
    state.handRaised = true;
    state.mode = "rider"; // a ✋ is a rider's (it may be from another device)
    setBanner(contextBanner());
  }

  if (st.on_map && !state.ride) {
    state.mode = "driver";
    state.online = true;
    requestWakeLock();
    setBanner(contextBanner());
    // SEED the send-filter, don't push: geolocation hasn't delivered its
    // first fix yet. The row already sits at our remembered spot; the first
    // real fix in another spot, or the 20s heartbeat, restamps it, well
    // inside the 3-min frozen-reap window (no fix at all: nothing is sent).
    lastGeoSent = HoodSendFilter.seed(state.me, mySpot || "", Date.now());
  }

  refreshControls();
  hydrated = true;
  // the first reading came before this (its search couldn't know you were
  // looking): looked now, as it would have — unless you've moved the map
  // yourself or a search is under way (findnearestdriving journey)
  const early = firstBeforeHydrate;
  firstBeforeHydrate = null;
  if (early && HoodNearby.lookingFor(state) && !movedByYou && !nearLooking) findNearest(early);
  checkRoleAgreement();
  if (reloadWhenHydrated) {
    reloadWhenHydrated = false;
    softReload();
  }
}

// ===== Geo subscriptions =====
// Which cells to watch is decided by viewport.js (HoodViewport) — pure
// functions shared with the Node test suite (test_js/viewport.test.mjs).

function screenRect() {
  const b = map.getBounds();
  return { n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() };
}

// THE MARGIN (padded rectangle, hysteresis): we WATCH every cell touching a
// rectangle about one cell wider than the screen on each side, and remember
// that rectangle. A later map move whose screen still lies inside it (same
// zoom) needs NO recompute at all: any cell touching the screen also touches
// a rectangle containing the screen, so it is already watched — true by the
// definition of "overlaps", no hex geometry assumed. Same pattern as geOps
// ("a bounding box bigger than what the user sees", resend only when the view
// leaves it), Leaflet keepBuffer, OpenLayers renderBuffer.
// The rect comparison is exact only because the map is flat and north-up
// (maxPitch 0, rotation disabled in initMap) — revisit if that changes.
// Resizes and phone rotation fire moveend, so a wider screen is re-checked.
let plannedArea = null; // {rect, zoom} the current wish was computed for

function screenInsidePlan() {
  if (!plannedArea || map.getZoom() !== plannedArea.zoom) return false;
  return HoodViewport.rectContains(plannedArea.rect, screenRect());
}

function syncGeoSubscriptions() {
  if (!worldChannel) return;

  // mid-ride the browse layer is torn down entirely — the only people who
  // matter are on the ride channel, so no cell subscriptions, no traffic
  if (state.ride && ["connected", "arrived"].includes(state.ride.status)) {
    plannedArea = null;
    setWanted(new Set(), new Set());
    return;
  }

  // an offline driver sees nothing on the map, so asks for nothing (the
  // server would only send what the app then hides)
  if (state.mode === "driver" && !state.online) {
    plannedArea = null;
    setWanted(new Set(), new Set());
    return;
  }

  // a pure pan inside the watched area: everything visible is already watched
  if (screenInsidePlan()) return;

  // the ladder (markers → agg7 → agg5 → floor), one budget at every level
  const plan = HoodViewport.planWatch(
    h3,
    screenRect(),
    [H3_RES, ...AGG_RESES],
    MAX_WATCHED_CELLS
  );
  if (plan) {
    plannedArea = { rect: plan.rect, zoom: map.getZoom() };
    zoomedOutWarned = false;
    if (plan.res === H3_RES) setWanted(plan.cells, new Set());
    else setWanted(new Set(), plan.cells);
    return;
  }

  // below even the coarsest rung — the floor
  plannedArea = null;
  setWanted(new Set(), new Set());
  if (!zoomedOutWarned) {
    zoomedOutWarned = true;
    transientBanner(t("Zoom in to see who's around"));
  }
}

// ===== world sync: rules in sync.js (HoodSync); this is only the glue =====
let aggRedrawQueued = false;
const worldSync = HoodSync.createWorldSync({
  push: (event, payload) => worldChannel.push(event, payload),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  random: Math.random,
  // a cell left the wish: its markers / counts go now (no more updates come)
  onDropGeo: (cell) => {
    [...realEntries.entries()].forEach(([id, e]) => {
      if (e.type !== "ridepeer" && e.cell === cell) dropEntry(id);
    });
    renderRealMarkers();
  },
  // drops arrive with the server's reply (after it let the cells go), not
  // when the wish changes: redraw then — once for the whole batch — or the
  // last count hexes stay painted over the markers after zooming in
  onDropAgg: (cell) => {
    aggData.delete(cell);
    if (aggRedrawQueued) return;
    aggRedrawQueued = true;
    queueMicrotask(() => {
      aggRedrawQueued = false;
      renderAggLayer();
    });
  },
  onSnapshot: ({ geo, agg }) => {
    // a snapshot is the whole truth for its cell: drop what it doesn't list
    // (the ghost fix — see browse.js), then add or refresh what it does
    HoodBrowse.staleInSnapshot(realEntries, geo).forEach(dropEntry);
    geo.forEach((s) => {
      (s.drivers || []).forEach((d) => upsertBrowseEntry(d, "driver"));
      (s.hands || []).forEach((h) => upsertBrowseEntry(h, "hand"));
    });
    renderRealMarkers();
    agg.forEach((counts) => aggData.set(counts.cell, counts));
    if (agg.length) renderAggLayer();
  },
});

function setWanted(geo, agg) {
  worldSync.setWanted(geo, agg);
  // (only what the view wants now is drawn: redrawn as the wish changes)
  renderMarkersSoon();
  renderAggSoon();
}

// an update for a cell we no longer want (e.g. still in flight from before
// the server processed our latest sync) must not create a ghost marker
function wantsDriverAt(d) {
  return worldSync.wantsGeo(d.cell);
}

// one browse entry gone (its marker is its pile's: redrawn by the caller)
function dropEntry(id) {
  const e = realEntries.get(id);
  if (!e) return;
  if (e.marker) e.marker.remove();
  realEntries.delete(id);
}

function joinWorldChannel() {
  worldChannel = socket.channel("world");
  // every cell event arrives multiplexed on this one channel; payloads
  // carry (or imply via lat/lng) their cell, so the handlers are global
  // live updates change the data at once and draw on the next screen frame
  // (HoodMapFrame): one redraw however many arrive. A server "batch" feeds
  // its items, in order, to these same handlers.
  // (who's where: HoodBrowse.mapMessageAction — an update elsewhere takes
  // the stale entry off; a "left" only where the app has them)
  const applyMapMessage = (kind, msg, type, wanted) => {
    const act = HoodBrowse.mapMessageAction(realEntries.get(msg.id), kind, msg, type, wanted);
    if (act === "keep") return;
    if (act === "upsert") upsertBrowseEntry(msg, type, { render: false });
    else removeBrowseEntry(msg.id, type, { render: false });
    renderMarkersSoon();
  };
  const mapHandlers = {
    driver_update: (d) => applyMapMessage("update", d, "driver", wantsDriverAt(d)),
    driver_left: (d) => applyMapMessage("left", d, "driver", true),
    hand_update: (h) => applyMapMessage("update", h, "hand", worldSync.wantsGeo(h.cell)),
    hand_left: (h) => applyMapMessage("left", h, "hand", true),
    agg_update: (p) => {
      if (!worldSync.wantsAgg(p.cell)) return;
      aggData.set(p.cell, p);
      renderAggSoon();
    },
  };
  for (const [event, handle] of Object.entries(mapHandlers)) worldChannel.on(event, handle);
  worldChannel.on("batch", ({ items }) => HoodMapFrame.unbatch(items, mapHandlers));
  // the server's role for us changed (it already dropped the old layer)
  worldChannel.on("role", ({ role }) => onServerRole(role));
  worldChannel.onClose(() => worldSync.onLeft());
  worldChannel.onError(() => worldSync.onLeft());
  // runs on the first join AND every automatic rejoin; the reply says
  // which role the server holds us in
  worldChannel.join().receive("ok", (reply) => {
    // a tab left open across a deploy: its code can't read the new messages
    if (reply && HoodBrowse.versionMismatch(reply.v, PROTOCOL)) showUpdateAvailable();
    if (reply && reply.build) serverBuild = reply.build;
    // the tab's stamp (as the user join's reply): kept even if that one is lost
    if (reply && reply.stamp) sessionStamp = reply.stamp;
    checkForUpdate();
    if (map && state.worldSpawned) syncGeoSubscriptions();
    if (reply && reply.role) onServerRole(reply.role, { rejoin: true });
    worldSync.onJoined();
  }).receive("error", (e) => {
    if (signedOutReply(e)) onJoinSignedOut();
    else if (sessionMovedReply(e)) onSessionMoved();
  });
}

// The SERVER decides what we receive, from what we are (viewer → cars,
// online driver → hands, mid-ride → nothing). When that changes, the layer
// we no longer receive must go: its *_left events will never come, so
// anything kept would be a ghost. Then ask again with the same wish — the
// server subscribes the new layer only when asked.
let serverRole = null;
function onServerRole(role, { rejoin = false } = {}) {
  const changed = role !== serverRole;
  serverRole = role;
  if (changed) {
    const keep = role === "viewer" ? "driver" : role === "driver" ? "hand" : null;
    [...realEntries.entries()].forEach(([id, e]) => {
      if (e.type !== "ridepeer" && e.type !== keep) dropEntry(id);
    });
    renderRealMarkers();
    // a card or list for a layer we no longer receive would point at ghosts
    closeMapOverlays();
    // counts carry one side per role: start the tier afresh
    aggData.clear();
    renderAggLayer();
    if (!rejoin) worldSync.resync();
  }
  checkRoleAgreement();
}

// Our "go offline" can be dropped (fire-and-forget under the rate limit):
// the server still sees a car we think is parked. Say it again. Only once
// hydrated — before that the app doesn't yet know it's resuming a shift.
// (The reverse — we're on duty, the server says viewer — is just the first
// GPS fix not sent yet: nothing to fix.)
let hydrated = false;
// the first location reading, when it came before hydrate (onReading)
let firstBeforeHydrate = null;
let reloadWhenHydrated = false; // the user channel joined before the first hydrate
let liveNews = 0; // live news received (HoodRehydrate.countsAsLive)
let reloading = false; // one softReload at a time…
let reloadAgain = false; // …and one more if another join asked meanwhile
// a reload that FAILED (no answer, 5xx, 429) is tried again with the
// reconnect backoff — it used to wait for the next rejoin, which a live
// connection may not have for hours
let reloadFailures = 0;
let reloadRetry = null;

// A RECONNECT IS A RELOAD. The server is the truth and the app its mirror,
// so after any reconnect the app rebuilds the mirror exactly as a page load
// does: clear it, then hydrate from fresh /api/state. (A rejoin used to
// re-sync only the map: after a server restart the app still showed a
// raised ✋ no driver could see, and a request waited forever.) Cleared
// first because hydrate only ADDS what the server has — it never removes
// what the server lost. The map, its position, the socket and the map sync
// stay as they are (the world channel resyncs itself). A short wifi blip
// loses nothing, and messages sent meanwhile now appear; after a restart
// the user is told what was lost (HoodRehydrate).
async function softReload() {
  if (DEMO || !hydrated) return;
  clearTimeout(reloadRetry);
  reloadRetry = null;
  if (reloading) {
    reloadAgain = true;
    return;
  }
  reloading = true;
  let st;
  try {
    // a snapshot that live news overtook while it was fetched is taken
    // again (HoodRehydrate.freshState): applying an older one would wipe
    // what that news already showed — e.g. a ride that just started
    st = await HoodRehydrate.freshState({
      // the same verdict as opening the app (HoodBoot.classify): a failure
      // is a failure, never "signed out"
      fetchState: async () => {
        // the chat list (light reload); the chat on screen comes in full, so
        // it stays where you were reading (asked again on each try)
        const onScreen = !$("chat").classList.contains("hidden") && state.chatView === "msgs" && state.chatPeer;
        const res = await apiFetch("/api/state?chats=list" + (onScreen ? `&open_peer=${encodeURIComponent(onScreen.id)}` : ""));
        const body = await res.json().catch(() => null);
        const verdict = HoodBoot.classify({ status: res.status, body });
        if (verdict === "retry") throw new Error(`state ${res.status}`);
        return verdict === "in" ? body : { user: null };
      },
      liveCount: () => liveNews,
    });
  } catch (_) {
    st = null;
  }
  reloading = false;
  if (reloadAgain) {
    reloadAgain = false;
    return softReload();
  }
  if (!st) {
    // failed: again after the reconnect backoff (a rejoin meanwhile runs it sooner)
    reloadRetry = setTimeout(softReload, HoodSync.reconnectBackoff(++reloadFailures));
    return;
  }
  reloadFailures = 0;
  if (!st.user) return; // logged out meanwhile: the socket's refusal handles it

  const before = HoodRehydrate.summarize(state);
  const openChatPeerId = !$("chat").classList.contains("hidden") && state.chatPeer ? state.chatPeer.id : null;
  // a chat on screen: where you were reading it — drawing it again sent you
  // to the newest, the "New messages" line and ↓ gone (owner, 2026-11-08)
  const reading = openChatPeerId && state.chatView !== "list" ? readingPlace() : null;
  // …if it was drawn: one still loading has no reading place to keep
  const wasLoaded = !!openChatPeerId && !!chats.get(state.chatPeer) && chats.get(state.chatPeer).loaded !== false;
  const openCardPeerId = !$("peer-card").classList.contains("hidden") && state.cardPeer ? state.cardPeer.id : null;
  // (a pile is remembered only while its list shows; the panel open with no
  // chat in it is the list)
  const openPileKey = state.pileKey;
  const pileScroll = openPileKey ? $("pile-list").scrollTop : 0; // (its place: below)
  const panelOpen = !$("chat").classList.contains("hidden");
  // what the server doesn't hold: the drafts, and the not-yet-written chats
  // while the window is open (HoodChatList.carried)
  const carried = HoodChatList.carried(
    [...chats].map(([p, c]) => ({ id: p.id, server: c.server, msgs: c.msgs, draft: c.draft })),
    !$("chat").classList.contains("hidden")
  );
  // 📍 Meet here tapped, the map tap not yet: the server doesn't know
  const armedRide = state.pinArmed && state.ride ? state.ride.id : null;
  resetMirror();
  hydrate(st);
  carried.forEach(({ id, draft }) => {
    const p = realPeersById.get(id);
    if (p) chatFor(p).draft = draft;
  });
  // …so it stays armed, if it's still that ride: a reload in between left
  // "Tap the map where you want to meet" on screen, and the tap did nothing
  // (owner, 2026-11-07). (Still yours to pin: only a connected or arrived
  // ride's rider has Meet here, and a ride that ends is gone)
  if (armedRide && state.ride && state.ride.id === armedRide) state.pinArmed = true;

  const msg = HoodRehydrate.lostBanner(HoodRehydrate.lost(before, HoodRehydrate.summarize(state)));
  // a message on screen keeps it (it restores the banner itself when it
  // ends): this runs right after start-up connects, and wiped e.g. the
  // "Couldn't refresh automatically" note (Chrome check, 2026-10-29)
  if (!bannerTimer) setBanner(contextBanner());
  if (msg) transientBanner(msg);

  // the chat that was open comes back — one the server has, or a new one
  // nothing was sent in yet (the server decides at Send whether they can
  // be messaged); if it's the one on screen (not the list), it's read
  const reopen = openChatPeerId && realPeersById.get(openChatPeerId);
  if (reopen && state.chatView !== "list" && !(wasLoaded && chatFor(reopen).loaded)) {
    // on screen but not drawn before (it was still loading), or back only as
    // a summary: opened as a tap opens it — "Loading…", then the line and
    // read (or at once, if the reload brought it in full)
    openChat(reopen);
  } else if (reopen) {
    state.chatPeer = reopen;
    // read only if it's the one ON SCREEN: with the list showing (‹ from
    // that chat) its news was marked read unseen — no unread, and saved as
    // read (owner, 2026-11-07)
    if (state.chatView !== "list") {
      chatFor(reopen).unread = 0;
      markSeen(reopen);
    }
    // the "New messages" line: above the same message (the reload rebuilt
    // them all — the same server id)
    if (reading && reading.lineId != null) chatLineMsg = chatFor(reopen).msgs.find((m) => m.id === reading.lineId) || null;
    renderChat();
    // scrolled up reading: back where you were — what came in meantime
    // counts on ↓ (at the newest: it stays there, as renderChat leaves it)
    if (reading && !reading.stuck) backToReadingPlace(reading, chatFor(reopen).msgs);
    // (always someone the app knows: it never forgets a person)
  } else if (panelOpen) {
    // the chat list, opened from 💬 Chat before any chat was: drawn again
    // from what the reload brought — it showed the old rows (no new
    // message, no unread) though the 💬 button counted it (owner, 2026-11-07)
    renderChat();
  }
  // the list with nothing left in it (everyone you talked to has gone) —
  // however it was opened, from 💬 Chat or ‹ from a chat: closed, as 💬 Chat
  // does, not an empty "Chats" panel (owner, 2026-11-07)
  // (a chat on screen is never empty here: drawing it keeps it)
  if (!$("chat").classList.contains("hidden") && chats.size === 0) closeChat();
  syncGeoSubscriptions();
  refreshControls();
  refreshWorldMarkers();
  // the card that was open comes back too, if they're still on the map
  // (this runs right after start-up connects: it closed silently, so a tap
  // in the first seconds lost its card — 2026-11-04)
  const cardBack = openCardPeerId && realPeersById.get(openCardPeerId);
  if (cardBack && realEntries.has(openCardPeerId)) openPeerCard(cardBack);
  // …and the list of who's in one block, if that pile's still there: it
  // closed under your finger (owner, 2026-11-07). (Gone, or down to one:
  // openPileSheet refuses)
  if (openPileKey) openPileSheet(openPileKey, { again: false });
  // …where you were in it: a long list (a busy block) went back to the top
  // under your finger (owner, 2026-11-08)
  if (state.pileKey) $("pile-list").scrollTop = pileScroll;
}

// everything hydrate rebuilds, back to a fresh page's state (the map, the
// peer objects behind map markers, and the socket are kept)
function resetMirror() {
  chats.clear();
  state.chatPeer = null;
  realPeersById.forEach((p) => {
    p.pending = false;
    p.pin = null;
    p.posExact = false;
    p.posRx = null;
  });
  // an open card or pile list would point at the old mirror
  closeMapOverlays();

  if (rideChannel) {
    rideChannel.leave();
    rideChannel = null;
  }
  if (state.ride && state.ride.peer) {
    const entry = realEntries.get(state.ride.peer.id);
    if (entry && entry.type === "ridepeer") {
      entry.marker.remove();
      realEntries.delete(state.ride.peer.id);
    }
  }
  state.ride = null;
  state.pinArmed = false;
  state.pinPos = null;
  if (pinMarker) {
    pinMarker.remove();
    pinMarker = null;
  }

  state.handRaised = false;
  clearTimeout(handPingTimer);
  // hydrate puts the shift back if the server still has the car
  state.online = false;
}
function checkRoleAgreement() {
  if (!hydrated || DEMO) return;
  if (serverRole === "driver" && !(state.mode === "driver" && state.online) && !state.ride) {
    pushDriverOffline();
  }
}

function ensureAggLayers() {
  if (map.getSource("agg-src")) return true;
  if (!map.isStyleLoaded()) {
    map.once("idle", renderAggLayer);
    return false;
  }
  map.addSource("agg-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "agg-fill",
    type: "fill",
    source: "agg-src",
    paint: {
      "fill-color": "#ffc107",
      "fill-opacity": ["interpolate", ["linear"], ["get", "total"], 1, 0.15, 8, 0.45],
    },
  });
  map.addLayer({
    id: "agg-line",
    type: "line",
    source: "agg-src",
    paint: { "line-color": "#ffc107", "line-width": 1.5, "line-opacity": 0.8 },
  });
  // labels go on a POINT source — polygons get tile-clipped and would render
  // one label per fragment (duplicate numbers, worst on the biggest hexes)
  map.addSource("agg-label-src", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "agg-label",
    type: "symbol",
    source: "agg-label-src",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 16,
      "text-font": ["Noto Sans Bold"],
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#111111",
      "text-halo-color": "#ffc107",
      "text-halo-width": 2,
    },
  });
  // tap a hex → dive toward it (back down the ladder)
  map.on("click", "agg-fill", (e) => {
    map.easeTo({ center: e.lngLat, zoom: map.getZoom() + 2.5 });
  });
  return true;
}

function renderAggLayer() {
  if (!map || !ensureAggLayers()) return;
  const hexes = [];
  const labels = [];
  aggData.forEach((p, cell) => {
    // same visibility rules as the marker tier, at altitude:
    // riders see supply, on-duty drivers see demand, offline drivers see nothing
    const count =
      state.mode === "rider" ? p.drivers || 0 : state.online ? p.hands || 0 : 0;
    if (count <= 0) return; // a hex never renders a zero — or an impossible negative
    // a hex the view no longer wants (its counts kept while the server
    // holds it): not drawn — never count hexes over the markers of a view
    // zoomed in meanwhile
    if (!DEMO && !worldSync.wantedAggHas(cell)) return;
    hexes.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [h3.cellToBoundary(cell, true)] },
      properties: { total: count },
    });
    const [lat, lng] = h3.cellToLatLng(cell);
    labels.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { label: String(count) },
    });
  });
  map.getSource("agg-src").setData({ type: "FeatureCollection", features: hexes });
  map.getSource("agg-label-src").setData({ type: "FeatureCollection", features: labels });
}

// A car or ✋ arrives anonymous: {id, cell, spot} — drawn at its spot's
// centre (block-level), filed under its topic cell. Who it is comes on tap.
// `render: false` when the caller redraws once for a whole batch.
function upsertBrowseEntry(data, type, { render = true } = {}) {
  if (state.realUser && data.id === state.realUser.id) return;
  // mid-ride, the partner is EXACT (their ride position): a late map update
  // must change nothing of theirs — checked before anything is touched (it
  // used to set their block centre first: their marker vanished, "on the
  // way" measured from the block)
  const entry = realEntries.get(data.id);
  if (entry && entry.type === "ridepeer") return;

  const peer = ensurePeer(data);
  peer.kind = type === "driver" ? "driver" : "rider";
  const spot = data.spot || data.cell;
  const [lat, lng] = h3.cellToLatLng(spot);
  peer.pos = { lat, lng };
  peer.posExact = false; // a block centre, never someone's position

  realEntries.set(data.id, { peer, type, cell: data.cell, spot });
  if (render) renderRealMarkers();
}

function removeBrowseEntry(id, type, { render = true } = {}) {
  const entry = realEntries.get(id);
  if (entry && entry.type === type) {
    dropEntry(id);
    if (render) renderRealMarkers();
  }
}

// Tapping a car or ✋: the card opens AT ONCE; a name we don't know yet comes
// from the map channel's `reveal`, which answers only the role that sees
// that marker, and only while it's on their screen — there is no
// lookup-anyone-by-id. Message stays disabled until the name is in (a chat
// opened before it would be titled "…" for good).
function openMarkerCard(peer, type) {
  closePileSheet();
  openPeerCard(peer);
  if (!HoodBrowse.needsReveal(peer)) return;
  revealPeer(peer, (result) => {
    if (state.cardPeer !== peer) return; // the card moved on meanwhile
    if (result === "ok") {
      openPeerCard(peer);
      return;
    }
    closePeerCard();
    transientBanner(
      result === "rate_limited"
        ? t("⏳ Slow down a sec")
        : result === "timeout"
          ? t("Couldn't reach the server — try again")
          : type === "hand"
            ? t("That rider isn't looking anymore")
            : t("That driver isn't around anymore")
    );
  });
}

// done("ok" | "rate_limited" | "unavailable" | "timeout")
function revealPeer(peer, done) {
  if (!worldChannel) return done("timeout");
  worldChannel
    .push("reveal", { id: peer.id })
    .receive("ok", (u) => {
      peer.name = u.name;
      peer.photo = u.photo;
      if ("car" in u) peer.car = carOf(u);
      done("ok");
    })
    // "busy": the database couldn't answer — the person isn't gone, so say
    // what the timeout says ("couldn't reach the server — try again")
    .receive("error", (e) =>
      done(e && e.reason === "rate_limited" ? "rate_limited" : e && e.reason === "busy" ? "timeout" : "unavailable")
    )
    .receive("timeout", () => done("timeout"));
}

function browseVisible(type) {
  if (type === "driver") return state.mode === "rider" && !state.ride;
  return state.mode === "driver" && state.online && !state.ride; // hand
}

// live map updates draw at most once per screen frame (HoodMapFrame)
const renderMarkersSoon = HoodMapFrame.createFrameRender(() => renderRealMarkers(), (f) => requestAnimationFrame(f));
const renderAggSoon = HoodMapFrame.createFrameRender(() => renderAggLayer(), (f) => requestAnimationFrame(f));

function renderRealMarkers() {
  // the ride partner: its own marker, shown only once an EXACT ride
  // position came in (a block centre would look like "they're here")
  realEntries.forEach((entry) => {
    if (entry.type !== "ridepeer") return;
    const p = entry.peer;
    if (state.ride && p.posExact && p.pos) entry.marker.setLngLat([p.pos.lng, p.pos.lat]).addTo(map);
    else entry.marker.remove();
  });

  // everyone else: one marker per pile (same type, same spot)
  // (only cells the view wants now: one it left keeps its people's data
  // while the server holds it, not their markers — never markers under
  // the count hexes of a view zoomed out meanwhile)
  const shown = new Map([...realEntries].filter(([, e]) => e.type !== "ridepeer" && browseVisible(e.type) && worldSync.wantedGeoHas(e.cell)));
  const live = new Set();
  HoodBrowse.groupMarkers(shown).forEach((g) => {
    live.add(g.key);
    let pm = pileMarkers.get(g.key);
    if (!pm) {
      pm = makePileMarker(g);
      pileMarkers.set(g.key, pm);
    }
    pm.ids = g.ids;
    drawPile(pm);
  });
  pileMarkers.forEach((pm, key) => {
    if (!live.has(key)) {
      pm.marker.remove();
      pileMarkers.delete(key);
    }
  });
  if (state.pileKey) renderPileSheet();
  nearbyArrived();
}

function makePileMarker(g) {
  const el = document.createElement("div");
  el.className = "marker-bubble" + (g.type === "hand" ? " hand" : "");
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  const pm = { el, type: g.type, ids: g.ids, key: g.key };
  const tap = (e) => {
    e.stopPropagation();
    onPileTap(pm);
  };
  el.addEventListener("click", tap);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") tap(e);
  });
  const [lat, lng] = h3.cellToLatLng(g.spot);
  pm.marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  return pm;
}

// a visible pile, not a number: up to three overlapped icons, then +N
function drawPile(pm) {
  const n = pm.ids.length;
  // its look depends on the count alone: redraw only when that changes (a
  // crowd re-rendered every pile ~14×/s — wasted work, and it swapped the
  // icons under a finger mid-click)
  if (pm.drawnN === n) return;
  pm.drawnN = n;
  const look = HoodBrowse.pileLook(n);
  const car = pm.type === "driver";
  pm.el.classList.toggle("pile", n > 1);
  pm.el.replaceChildren(
    ...Array.from({ length: look.icons }, (_, i) => {
      const s = car ? carIcon() : iconImg({ emoji: "✋", src: "hand.svg" });
      s.className = "pile-icon pile-icon-" + i;
      return s;
    })
  );
  if (look.more) {
    const m = document.createElement("span");
    m.className = "pile-more";
    m.textContent = `+${look.more}`;
    pm.el.append(m);
  }
  pm.el.setAttribute(
    "aria-label",
    pm.type === "driver" ? tn("{count} car here", "{count} cars here", n) : tn("{count} person here", "{count} people here", n)
  );
}

function onPileTap(pm) {
  if (pm.ids.length === 1) {
    const e = realEntries.get(pm.ids[0]);
    if (e) openMarkerCard(e.peer, pm.type);
  } else {
    openPileSheet(pm.key);
  }
}

// ----- the pile list: who is in this block -----
// again: false — reopened by a reload, not by you (below)
function openPileSheet(key, { again = true } = {}) {
  // only a pile of two or more has a list: one person is their card (a
  // tap opens it), none is nothing — refused here, whoever asks (owner,
  // 2026-11-07: an empty sheet otherwise)
  const pm = pileMarkers.get(key);
  if (!pm || pm.ids.length < 2) return;
  closePeerCard();
  // an explicit open asks again for anyone refused before — a reload's
  // reopen doesn't: on a flaky connection every reload asked again, each
  // ask spending a name lookup (owner, 2026-11-07)
  if (again)
    pm.ids.forEach((id) => {
      const e = realEntries.get(id);
      if (e) e.peer.revealGone = false;
    });
  state.pileKey = key;
  renderPileSheet();
  $("pile-sheet").classList.remove("hidden");
}

function closePileSheet() {
  state.pileKey = null;
  pileRowsOnScreen.clear();
  $("pile-sheet").classList.add("hidden");
}

// both map overlays: whenever what they point at may be gone (a ride
// starts, going offline, a mode switch, a role change, a reconnect)
function closeMapOverlays() {
  closePeerCard();
  closePileSheet();
}

function renderPileSheet() {
  const pm = pileMarkers.get(state.pileKey);
  if (!pm || pm.ids.length < 2) {
    // the pile shrank to one or dissolved: the list has nothing to choose
    closePileSheet();
    return;
  }
  const n = pm.ids.length;
  $("pile-title").textContent =
    pm.type === "driver"
      ? tn("{count} car around here", "{count} cars around here", n)
      : tn("{count} person needs a ride here", "{count} people need a ride here", n);
  const list = $("pile-list");
  list.replaceChildren();
  pileRowWatch.disconnect();
  pm.ids.forEach((id) => {
    const e = realEntries.get(id);
    if (!e) return;
    const peer = e.peer;
    const row = document.createElement("button");
    row.className = "pile-row";
    const img = document.createElement("img");
    img.className = "avatar avatar-mini";
    img.alt = "";
    img.dataset.name = peer.name || "";
    img.src = peer.photo || (pm.type === "driver" ? "car-avatar.png" : "hand-avatar.svg");
    const name = document.createElement("span");
    name.className = "pile-name";
    name.textContent = peer.revealGone ? t("Not available") : peer.name;
    row.append(img, name);
    // a tap asks at once, ahead of the queue (openMarkerCard)
    row.addEventListener("click", () => openMarkerCard(peer, pm.type));
    row.dataset.id = id;
    list.append(row);
    pileRowWatch.observe(row);
  });
}

// The names in the list: only rows on screen, one request for the rows of
// one moment, and on "not yet" the server's exact wait (reveal_queue.js).
// Each render re-observes the rows; the observer reports each one's
// visibility, and the queue ignores names already asked for.
const pileRowsOnScreen = new Set();
const pileNames = HoodRevealQueue.create({
  send: (ids, reply) => {
    if (!worldChannel) return reply(null);
    worldChannel
      .push("reveal", { ids })
      .receive("ok", reply)
      .receive("error", () => reply(null))
      .receive("timeout", () => reply(null));
  },
  wanted: (id) => {
    const pm = state.pileKey && pileMarkers.get(state.pileKey);
    const e = realEntries.get(id);
    return !!pm && pm.ids.includes(id) && pileRowsOnScreen.has(id) && !!e &&
      HoodBrowse.needsReveal(e.peer) && !e.peer.revealGone;
  },
  onUser: (u) => {
    const e = realEntries.get(u.id);
    if (e) {
      e.peer.name = u.name;
      e.peer.photo = u.photo;
      if ("car" in u) e.peer.car = carOf(u);
    }
  },
  // they're leaving; their marker goes with driver_left / hand_down
  onGone: (id) => {
    const e = realEntries.get(id);
    if (e) e.peer.revealGone = true;
  },
  onChange: () => {
    if (state.pileKey) renderPileSheet();
  },
});
const pileRowWatch = new IntersectionObserver(
  (seen) =>
    seen.forEach(({ target, isIntersecting }) => {
      const id = Number(target.dataset.id);
      if (isIntersecting) {
        pileRowsOnScreen.add(id);
        pileNames.want(id);
      } else {
        pileRowsOnScreen.delete(id);
        pileNames.drop(id);
      }
    }),
  { root: $("pile-list") }
);

$("pile-close").addEventListener("click", closePileSheet);

function ensureRidePeerEntry(peer) {
  let entry = realEntries.get(peer.id);
  if (entry && entry.marker) entry.marker.remove();
  entry = {
    peer,
    type: "ridepeer",
    marker: makeBubbleMarker(state.mode === "rider" ? CAR : "🙋", () => openPeerCard(peer)),
  };
  realEntries.set(peer.id, entry);
  renderRealMarkers();
  return entry;
}

// ===== My broadcasts =====
// On the browse map a car and a ✋ are a SPOT (a res-9 hex) — never a
// point; exact positions go only to a ride partner. The spot is sticky
// (HoodSendFilter.stickySpot) so an edge can't leak by flip-flopping, and
// remembered on this device per user so a home on an edge shows in the same
// block every day. Only the spot is sent: the server works out the
// neighborhood and the zoomed-out count areas from it (Hoodride.H3 — it
// used to take our word for them, step 5).
let mySpot = null;

// localStorage, or null where touching it throws (some private modes)
function storageOrNull() {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

function spotKey() {
  return state.realUser ? `hoodride_spot_${state.realUser.id}` : null;
}
function loadStoredSpot() {
  try {
    mySpot = (spotKey() && localStorage.getItem(spotKey())) || null;
  } catch (_) {
    mySpot = null; // storage blocked (private mode): stickiness within the session only
  }
}
function forgetStoredSpot() {
  try {
    if (spotKey()) localStorage.removeItem(spotKey());
  } catch (_) {}
}
// signed out with no account known (expired, signed out on another device):
// every account's block goes — a rough home or work area, left on a shared
// phone (leftovers review, 2026-11-13; test_browser/signedout.mjs)
function forgetAllSpots(storage) {
  if (!storage) return;
  try {
    const spots = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith("hoodride_spot_")) spots.push(k);
    }
    spots.forEach((k) => storage.removeItem(k));
  } catch (_) {}
}
// the spot to broadcast now, or null at a placeholder location (no GPS fix)
function currentSpot() {
  if (!state.haveFix) return null;
  const spot = HoodSendFilter.stickySpot(mySpot, state.me, h3, H3_DISPLAY_RES);
  if (spot !== mySpot) {
    mySpot = spot;
    try {
      if (spotKey()) localStorage.setItem(spotKey(), spot);
    } catch (_) {}
  }
  return spot;
}

// when to send our position: sendfilter.js (HoodSendFilter) — on the browse
// map a new SPOT or the jittered heartbeat; in a ride a distance filter.
// The 1.5 s tick re-checks it.
let lastGeoSent = null;
let lastRidePosSent = null;

function pushDriverUpdate() {
  if (!userChannel || state.mode !== "driver" || !state.online || state.ride) return;
  // at a placeholder location (no fix yet) nothing is said: a car there
  // would be in the wrong city (the server drops a silent car in 3 min)
  if (!HoodSendFilter.gpsAllows(state.haveFix, "send")) return;
  const spot = currentSpot();
  const now = Date.now();
  if (!HoodSendFilter.shouldSend(lastGeoSent, now, state.me, spot, HoodSendFilter.BROWSE_MIN_METERS))
    return;
  lastGeoSent = HoodSendFilter.stamp(state.me, spot, now, Math.random);
  userChannel.push("driver_update", { spot });
}

function pushDriverOffline() {
  if (userChannel) userChannel.push("driver_offline", {});
  // the server just declined everyone waiting on us — mirror it locally so
  // no stale Accept resurfaces when we come back online
  chats.forEach((_c, p) => {
    if (p.pending) p.pending = false;
  });
}

// What YOU do is news too: a reload whose snapshot was taken just before
// it reached the server would put things back as they were — a ✋ down on
// your screen while every driver still sees it, a message gone from your
// chat though it was delivered (both found 2026-11-07, owner). Anything
// you send while a reload is loading makes it ask again
// (HoodRehydrate.freshState). Every push on your own channel and your
// ride's counts — except the position updates, sent every ~1.5 s (a reload
// would never settle): going online is counted where it's tapped, and "I'm
// here" (said again with each update at the pickup) once per ride, where
// it's said (declareArrived). (Accept,
// the pin, End ride: the server already answers them with news of its own
// — ride_started, pin, ride_ended — so for them this is a second safety net,
// for any later action it doesn't answer; test_browser/tapreload.mjs.)
const QUIET_PUSHES = new Set(["driver_update", "pos", "arrived"]);

function tapNews() {
  liveNews++;
}

function ownNews(channel) {
  const push = channel.push.bind(channel);
  channel.push = (event, ...rest) => {
    if (!QUIET_PUSHES.has(event)) tapNews();
    return push(event, ...rest);
  };
  return channel;
}

function pushHand(up) {
  if (!userChannel) return;
  if (up) {
    const spot = currentSpot();
    if (!spot) return; // no fix: the tap was already refused
    userChannel.push("hand_up", { spot });
  } else {
    userChannel.push("hand_down", {});
  }
}

// how old the partner's position is (ms), on this device's steady clock;
// null before any (ridepos.js)
function partnerAgeMs() {
  const p = state.ride && state.ride.peer.posRx;
  return p ? HoodRidePos.ageMs(p, performance.now()) : null;
}

function pushRidePos() {
  if (!rideChannel || !state.ride) return;
  // only in a live ride, with a good reading from the CURRENT watch: never
  // the placeholder, a coarse reading, or one left over from placing a ✋
  if (!HoodRidePos.mayAnnounce(state.ride, loc.liveFix())) return;
  // auto-arrival runs EVERY tick — it's local math and must fire the moment
  // we're close, never wait for the send gate. It aims only at the pin or an
  // EXACT and FRESH ride position: never a block centre, never one the
  // partner's phone stopped updating (HoodRidePos.arrivalTarget).
  if (state.ride.status === "connected" && state.ride.role === "driver") {
    const target = HoodRidePos.arrivalTarget(state.ride.peer, partnerAgeMs());
    if (target && metersBetween(state.me, target) < 35) declareArrived();
  }
  const now = Date.now();
  if (!HoodSendFilter.shouldSend(lastRidePosSent, now, state.me, "", HoodSendFilter.RIDE_MIN_METERS))
    return;
  lastRidePosSent = HoodSendFilter.stamp(state.me, "", now, Math.random);
  rideChannel.push("pos", { lat: state.me.lat, lng: state.me.lng });
}

function declareArrived() {
  if (!state.ride || state.ride.status !== "connected") return;
  if (rideChannel) {
    // news once per ride: at the pickup it's said again with every update
    // (~1.5 s) until the server's answer comes — counted each time, a
    // reload loading meanwhile threw its answer away and asked again, over
    // and over (owner, 2026-11-07). Remembered on the ride itself (its id
    // may come again after a server restart; a reload counts one more)
    if (!state.ride.arrivedNews) {
      state.ride.arrivedNews = true;
      tapNews();
    }
    rideChannel.push("arrived", {});
    // status flips when the "arrived" broadcast comes back — one source of truth
  } else {
    markArrived(); // demo mode: local only
  }
}

// the ride is now "arrived", as of now on this device: "You've arrived" for
// a minute, then "Ride with X" (HoodRidePos.arrivedPhase) — redrawn then
let arrivedTimer = null;
function markArrived() {
  state.ride.status = "arrived";
  state.ride.arrivedAt = performance.now();
  clearTimeout(arrivedTimer);
  arrivedTimer = setTimeout(() => {
    if (state.ride && state.ride.status === "arrived") setBanner(contextBanner());
  }, HoodRidePos.ARRIVED_SHOW_MS);
  setBanner(contextBanner());
  refreshControls();
}

// a message's own id (the server dedupes a retry by it): random, unguessable
function newMessageId() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ===== Real ride =====
function startRealRide(r) {
  // already in this ride (a reload's snapshot had it, and the live news
  // arrived after): joining its channel again would only churn it
  if (state.ride && state.ride.id === r.ride_id && rideChannel) return;
  const peer = ensurePeer(r.peer);
  peer.pending = false;
  // a driver's ride starting: the server declined everyone else waiting on
  // him (Requests.decline_all_for_driver, told only to them) — mirrored
  // here, as going offline does: no stale Accept for them after the ride
  // (owner, 2026-11-10: tapping it said "Too late — the request was withdrawn")
  if (r.role === "driver") realPeersById.forEach((p) => p !== peer && p.pending && (p.pending = false));
  closeMapOverlays();
  state.ride = { peer, status: "connected", id: r.ride_id, role: r.role };
  state.handRaised = false;
  syncGeoSubscriptions(); // tears down the browse layer for the ride
  ensureRidePeerEntry(peer);
  joinRideChannel();
  // the server opened this pair's conversation at ride start: keep it in
  // the inbox after the ride, even if nobody typed (the lost-phone case)
  chatFor(peer).server = true;
  // accepting takes both of you to the MAP (the car coming, Navigate, the
  // countdown); the chat is one tap away on 💬 Chat, and the partner's
  // messages still show as a banner
  closeChat();
  setBanner(contextBanner());
  refreshControls();
  refreshWorldMarkers();
}

function joinRideChannel() {
  if (!state.ride || !state.ride.id || !socket) return;
  lastRidePosSent = null; // a fresh ride always announces immediately
  // one ride channel at a time: an old one left open could clean up THIS
  // ride with its "ended" or its join error (HoodrideWeb.RideGuardsWiringTest)
  if (rideChannel) rideChannel.leave();
  rideChannel = ownNews(socket.channel(`ride:${state.ride.id}`));

  // live, or — right after we (re)join — the partner's LAST position with
  // its age (age_ms), kept by the server for exactly this
  rideChannel.on("peer_pos", (p) => {
    const { from, lat, lng } = p;
    if (!state.ride || from === state.realUser.id) return;
    state.ride.peer.pos = { lat, lng };
    state.ride.peer.posExact = true; // the only source of an exact position
    state.ride.peer.posRx = HoodRidePos.received(p, performance.now());
    let entry = realEntries.get(state.ride.peer.id);
    if (!entry || entry.type !== "ridepeer") entry = ensureRidePeerEntry(state.ride.peer);
    entry.marker.setLngLat([lng, lat]);
    // the entry may have been created before any position was known —
    // attach the marker to the map on the first real fix
    if (!entry.marker._map) entry.marker.addTo(map);
    // rider's live countdown while the driver approaches
    // (not over a message that's up, e.g. "location is blocked")
    // (a stale hand-over shows "last seen" instead: contextBanner)
    // (and not over "📍 Tap the map where you want to meet" while you place
    // the pin: it was gone within a second of a moving driver's update —
    // owner, 2026-11-07; placing it brings the distance back)
    if (state.ride.status === "connected" && state.ride.role === "rider" && !bannerTimer && !state.pinArmed) {
      const meetAt = state.pinPos || loc.best;
      setBanner(
        meetAt && HoodRidePos.fresh(partnerAgeMs())
          ? CAR +
            t("{name} is on the way", { name: state.ride.peer.name }) +
            HoodCar.inLine(state.ride.peer.car) +
            " · " +
            away(metersBetween(state.ride.peer.pos, meetAt))
          : contextBanner()
      );
    }
  });

  rideChannel.on("pin", ({ pin }) => applyRemotePin(pin));

  // the partner's real name, when the ride started without it (the server's
  // database couldn't answer then: "Neighbor") — the same peer object the
  // banner, chat and card use, so each follows
  rideChannel.on("peer", (p) => {
    const { id, name, photo } = p;
    if (!state.ride || state.ride.peer.id !== id) return;
    const peer = state.ride.peer;
    peer.name = name;
    peer.photo = photo;
    if ("car" in p) peer.car = carOf(p);
    setBanner(contextBanner());
    // their chat on screen: its heading; the list (however it was opened):
    // their row — the heading is "Chats" there, and stays so (owner,
    // 2026-11-08)
    if (!$("chat").classList.contains("hidden")) {
      if (state.chatView === "list") renderChat();
      else if (state.chatPeer === peer) {
        // (not renderChat: it would send a reader scrolled up to the bottom)
        $("chat-name").textContent = name;
        $("chat-photo").dataset.name = name || "";
        $("chat-photo").src = peer.photo || HoodAvatar.url(name);
      }
    }
    // their card, if it's showing (Message hides it, keeping cardPeer: it
    // popped back up over the chat — owner, 2026-11-08)
    if (state.cardPeer === peer && !$("peer-card").classList.contains("hidden")) openPeerCard(peer);
    refreshControls();
  });

  // arrival is driver-declared (auto or button), announced to both phones
  rideChannel.on("arrived", () => {
    if (!state.ride) return;
    markArrived();
  });

  rideChannel.on("ended", ({ by }) => {
    const mine = state.realUser && by === state.realUser.id;
    if (!mine) transientBanner(t("Ride ended"));
    realRideCleanup();
  });

  rideChannel
    .join()
    .receive("ok", (st) => {
      if (st.pin) applyRemotePin(st.pin);
      // (a missed broadcast while reconnecting: it just happened)
      if (st.arrived && state.ride && state.ride.status === "connected") markArrived();
      // every (re)join, not only the first: the partner hears us at once
      lastRidePosSent = HoodRidePos.afterJoin();
      pushRidePos();
      if (!realEntries.get(state.ride.peer.id)) ensureRidePeerEntry(state.ride.peer);
    })
    .receive("error", (e) => {
      if (signedOutReply(e)) return onJoinSignedOut();
      if (sessionMovedReply(e)) return onSessionMoved();
      // over the join budget: the ride is fine — Phoenix retries this join
      // by itself (HoodRehydrate.rideJoinLost)
      if (!HoodRehydrate.rideJoinLost(e)) return;
      // the ride is gone (a server restart, or it ended while we couldn't
      // hear "ended"). This runs before the reconnect's soft reload, which
      // would then see no ride to report — so say it here.
      if (state.ride) transientBanner(HoodRehydrate.lostBanner(["ride"]));
      realRideCleanup();
    });
}

function makePinEl() {
  const el = document.createElement("div");
  el.className = "marker-pin";
  el.append(iconImg({ emoji: "\u{1F4CD}", src: "pin.svg" }));
  el.title = t("Tap to remove");
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    clearPin();
  });
  return el;
}

// the inverse gesture of tap-to-place: tapping your own pin removes it,
// and the driver goes back to targeting your live position
function clearPin() {
  const isRider = DEMO ? state.mode === "rider" : state.ride && state.ride.role === "rider";
  if (!state.pinPos || !isRider) return;

  if (!DEMO) {
    if (rideChannel) rideChannel.push("clear_pin", {});
    // rendering happens on the "pin" broadcast (both sides, consistent)
    transientBanner(t("📍 Pin removed — your driver will come to you"));
    return;
  }

  applyRemotePin(null);
  transientBanner(t("📍 Pin removed — your driver will come to you"));
  if (state.ride) receiveMsg(state.ride.peer, t("aight, coming to you then"));
}

function applyRemotePin(pin) {
  if (!pin) {
    state.pinPos = null;
    if (state.ride) state.ride.peer.pin = null;
    if (pinMarker) {
      pinMarker.remove();
      pinMarker = null;
    }
    refreshControls();
    return;
  }
  state.pinPos = { lat: pin.lat, lng: pin.lng };
  if (state.ride) state.ride.peer.pin = state.pinPos;
  if (!pinMarker) {
    pinMarker = new maplibregl.Marker({ element: makePinEl(), anchor: "bottom" });
  }
  pinMarker.setLngLat([pin.lng, pin.lat]).addTo(map);
  refreshControls();
}

function realRideCleanup() {
  // the conversation survives — only the ride dies
  if (rideChannel) {
    rideChannel.leave();
    rideChannel = null;
  }
  const peer = state.ride ? state.ride.peer : null;
  state.ride = null;
  state.pinArmed = false;
  state.pinPos = null;
  if (pinMarker) {
    pinMarker.remove();
    pinMarker = null;
  }
  if (peer) {
    const entry = realEntries.get(peer.id);
    if (entry && entry.type === "ridepeer") {
      entry.marker.remove();
      realEntries.delete(peer.id);
    }
    peer.pin = null;
    // nothing exact outlives the ride, here either
    peer.pos = null;
    peer.posExact = false;
    peer.posRx = null;
  }
  // a finished ride leaves the driver OFFLINE — back on the map only via an
  // explicit GO ONLINE tap, once the actual trip is really over
  state.online = false;
  setBanner(contextBanner());
  syncGeoSubscriptions(); // ride over — the browse layer comes back
  refreshControls();
  refreshWorldMarkers();
}

// ===== Map setup =====
// a pan or pinch of yours: the first location reading then leaves the map
// where you put it (onReading)
let movedByYou = false;

// the area on screen, remembered on this device (HoodViewStore) so the map
// opens where you were — real accounts only
function rememberView() {
  if (DEMO || !state.realUser) return;
  const c = map.getCenter();
  HoodViewStore.save(storageOrNull(), state.realUser.id, { lng: c.lng, lat: c.lat, zoom: map.getZoom() });
}

// your blue dot on the map, drawn UNDER everyone else's marker (owner,
// 2026-11-09): markers stack in the order they're added, and the dot comes
// with your first reading — after cars already drawn; so it goes in first,
// straight after the map's own picture. A car right by you is never hidden
// by it (find the nearest counts what you can see).
function showMe() {
  meMarker.addTo(map);
  map.getCanvas().after(meMarker.getElement());
}

function initMap() {
  // the phone's own edges the page is drawn under (find the nearest counts
  // them as covers — nearCovers): read from this element's padding
  if (!document.getElementById("safe-probe")) {
    const probe = document.createElement("div");
    probe.id = "safe-probe";
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
  }
  // where it opens: the area you last used here, else the placeholder (a
  // location reading then centres it on you — onReading)
  const start = HoodViewStore.startView(
    DEMO || !state.realUser ? null : HoodViewStore.read(storageOrNull(), state.realUser.id),
    DEFAULT_POS
  );
  // a browser that can't draw the map (WebGL off or blocked: hardware
  // acceleration off, some privacy browsers, old Android) throws here.
  // Everything after it used to be skipped — a blank screen, no word, the
  // same on every reload, while the server saw the person online. Said
  // plainly instead, and nothing connects (test_browser/mapstart.mjs)
  try {
    map = makeMap(start);
  } catch (e) {
    map = null;
    showMapUnavailable();
    reportError(e, "map");
    return false;
  }
  map.touchZoomRotate.disableRotation();

  // map tiles come from the internet: one that can't load (no signal) stays
  // blank and is asked for again on the next move — nothing to report
  // (owner, 2026-11-01). Any other map error is. (With no listener here,
  // the map library prints every tile failure as an error.)
  map.on("error", (e) => {
    if (e.tile || e.sourceId) return;
    console.error("map:", e.error?.message || e.error);
    reportError(e.error || e, "map");
  });

  const el = document.createElement("div");
  el.className = "marker-me";
  // your blue dot appears only once a real reading says where you are —
  // never at the placeholder (it would claim you're in Manhattan)
  meMarker = new maplibregl.Marker({ element: el }).setLngLat([state.me.lng, state.me.lat]);
  if (DEMO) showMe();

  map.on("click", (e) => {
    if (state.pinArmed) placePin({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  map.on("moveend", () => {
    if (!DEMO) syncGeoSubscriptions();
    else planDemoView();
    rememberView();
  });

  // only gestures carry an originalEvent (a camera move of the app's doesn't)
  map.on("movestart", (e) => {
    if (e.originalEvent) movedByYou = true;
    // (a ◎ tap still waiting for its reading: your own drag or pinch cancels
    // it — the app's own moves, a resize, don't)
    if (e.originalEvent && !DEMO) loc.cancelCentre();
    // any move but find-the-nearest's own ends it (and its "nobody nearby
    // yet": what's on screen no longer says who's near you)
    if (!e.nearSearch) movedByHand();
  });
  // a finger put down on the bare map while the search is STEPPING ends it
  // at once — before any move: the press stops the step's move, and the
  // search, seeing a still map, took its next step straight away, its own
  // move then overriding the finger's drag before it began (owner,
  // 2026-11-10). (The canvas only: a tap on a car or ✋ — a marker — isn't
  // this; nor is a tap while it only watches someone found.)
  map.getCanvas().addEventListener("pointerdown", () => {
    if (nearLooking) movedByHand();
  });

  if (DEMO) {
    // the demo comes back as what you last picked too (offline, like the
    // real app) — under its own key, apart from any real account's
    const savedMode = HoodModeStore.read(storageOrNull(), "demo");
    if (savedMode) state.mode = savedMode;
    refreshControls();
    // never the browser's location (owner, 2026-11-02): no prompt in a
    // demo — its pretend world is built around a fixed spot (DEFAULT_POS)
    spawnWorld("demo");
  } else {
    // no location prompt on open (web.dev: ask on a user gesture): the map
    // works without it. A returning user who already allowed it is
    // centred quietly — no prompt can appear for an allowed permission.
    spawnWorld("start");
    loc.start();
  }
  setInterval(tick, 1500);
  refreshControls();
  return true;
}

function makeMap(start) {
  return new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: start.center,
    zoom: start.zoom,
    attributionControl: { compact: true },
    // the map library's own words (screen-reader names) in the reader's
    // language — the ones this map uses (languages journey, 2026-11-04)
    locale: {
      "Map.Title": t("Map"),
      "Marker.Title": t("Map marker"),
      "AttributionControl.ToggleAttribution": t("Show or hide the map's credits"),
      "AttributionControl.MapFeedback": t("Map feedback"),
    },
    // flat, north-up, always: no tilt, no rotation
    maxPitch: 0,
    pitchWithRotate: false,
    dragRotate: false,
  });
}

// this browser can't draw the map (initMap): said plainly, over everything
function showMapUnavailable() {
  if (document.getElementById("map-unavailable")) return;
  const el = document.createElement("div");
  el.id = "map-unavailable";
  el.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;" +
    "background:rgba(17,17,17,.94);color:#fff;font:16px system-ui,sans-serif";
  el.textContent = t("This browser can't show the map — turn on hardware acceleration in its settings, or try another browser");
  document.body.appendChild(el);
}

// ===== Location (the logic: locator.js; the rules: sendfilter.js) =====
// which browser, so a "blocked" message names ITS switch (navigator.brave:
// Brave's own check — its name can be missing from the user agent)
const BROWSER = HoodSendFilter.browserOf(navigator.userAgent, !!navigator.brave);
const PLATFORM = BROWSER.platform;

const loc = HoodLocator.create({
  geolocation: "geolocation" in navigator ? navigator.geolocation : null,
  queryPermission: async () =>
    navigator.permissions ? (await navigator.permissions.query({ name: "geolocation" })).state : "unknown",
  now: () => Date.now(),
  h3,
  rules: HoodSendFilter,
  platform: PLATFORM,
  browser: BROWSER.app,
  // an installed app has no web address bar (the steps differ)
  standalone: window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
  app: {
    state: () => state,
    onReading(pos, { first, centre }) {
      meMarker.setLngLat([pos.lng, pos.lat]);
      if (first) showMe();
      if (centre) centreOnYou(pos);
      // the first reading (allowed already at load, a resumed shift, a tap):
      // the map comes to you — unless you've moved it yourself (online or
      // ✋ up: the nearest found too)
      if (first && !centre && !movedByYou) {
        if (HoodNearby.lookingFor(state)) findNearest(pos);
        else {
          map.easeTo({ center: [pos.lng, pos.lat], zoom: usualZoom(pos) });
          // before the server has said what you're doing (the map is made
          // before the connection, 2026-11-14): a ✋ up or a shift online
          // isn't known yet — asked again once it is (hydrate)
          if (!hydrated) firstBeforeHydrate = pos;
        }
      }
    },
    onGood(pos) {
      state.me = pos;
      state.haveFix = true;
      goodSeen = true;
      nearbyMoved(pos);
      pushDriverUpdate();
      pushRidePos();
    },
    onTrustLost: () => (state.haveFix = false),
    setOnline: (on) => setOnline(on),
    setHand: (up) => setHand(up),
    // after whatever is running now (e.g. a ride starting: it redraws the
    // banner right after the refresh that found location blocked) — so
    // nothing in the same step draws over it
    message: (text) => queueMicrotask(() => transientBanner(text, 12000, true)),
    // every location reading redraws: another message on screen is left
    // alone (it wiped "Couldn't refresh…" at once; the A2 journey,
    // 2026-11-12) — the normal banner comes back when it ends
    // (transientBanner). Location's own message is replaced, as before. A ✋
    // / GO ONLINE tap ends any message first (locTap): the person acting
    redrawBanner: () => {
      if (bannerTimer && !bannerIsLoc) return;
      clearTimeout(bannerTimer);
      bannerTimer = null;
      bannerIsLoc = false;
      setBanner(contextBanner());
    },
    refresh: () => refreshControls(),
    showShare: (text) => showSharePrompt(text),
    hideShare: () => hideSharePrompt(),
    // back from Settings after "blocked": the open page keeps the browser's
    // "no" — a quiet reload (this tab's session kept, everything restored)
    reload: () => {
      if (steppedAside()) return; // "Use here" is the person's own choice
      HoodSession.noteQuietReload(tabStorage(), sessionStamp);
      location.reload();
    },
    // (the car form open too: the reload wiped what was typed in it — U2's
    // second route, review 2026-11-11; test_browser/carformupdate.mjs)
    typing: () => (($("chat-input") && $("chat-input").value) || "").trim() !== "" || carSheetOpen(),
  },
});

// the tap that starts location when the app needs it without a tap (a ride
// started by the server, a shift or ride resumed after a reload)
function showSharePrompt(text) {
  if (document.getElementById("share-location")) return;
  const btn = document.createElement("button");
  btn.id = "share-location";
  btn.textContent = text;
  btn.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);" +
    "bottom:calc(150px + env(safe-area-inset-bottom));z-index:9997;padding:12px 22px;border:0;" +
    "border-radius:999px;background:#1a73e8;color:#fff;font:700 15px system-ui,sans-serif;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer;max-width:calc(100% - 32px)";
  btn.addEventListener("click", () => loc.shareTapped());
  document.body.appendChild(btn);
}
function hideSharePrompt() {
  const b = document.getElementById("share-location");
  if (b) b.remove();
}

function spawnWorld(reason) {
  if (state.worldSpawned) return;

  if (!DEMO) {
    // the real map works without location (it's asked for only on a tap)
    if (!state.worldSpawned) {
      state.worldSpawned = true;
      syncGeoSubscriptions();
    }
    return;
  }

  state.worldSpawned = true;
  DRIVER_SEEDS.forEach((seed, i) => {
    const angle = (i / DRIVER_SEEDS.length) * Math.PI * 2 + Math.random();
    const dist = 300 + Math.random() * 700;
    const pos = offsetPos(state.me, Math.cos(angle) * dist, Math.sin(angle) * dist);
    const driver = {
      ...seed,
      kind: "driver",
      pos,
      photo: HoodAvatar.url(seed.name),
      marker: null,
      visible: false,
    };
    driver.marker = makeBubbleMarker(CAR, () => openPeerCard(driver));
    drivers.push(driver);
  });
  refreshWorldMarkers();
}

function makeBubbleMarker(emoji, onClick, extraClass) {
  const el = document.createElement("div");
  el.className = "marker-bubble" + (extraClass ? " " + extraClass : "");
  const src = HoodIcons.ICONS[emoji.trim()];
  if (emoji === CAR) el.append(carIcon("marker-car"));
  else if (src) el.append(Object.assign(iconImg({ emoji: emoji.trim(), src }), { className: "marker-icon" }));
  else el.textContent = emoji;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return new maplibregl.Marker({ element: el });
}

// The demo, zooming out (owner, 2026-11-02): the real app's ladder decides
// — markers → counted hexagons → "Zoom in to see who's around" — by the
// same rule (HoodViewport.planWatch, as syncGeoSubscriptions), with the
// pretend people counted (HoodBrowse.demoCounts). null: the floor.
let demoPlan = { res: H3_RES, cells: new Set() };
let demoAggShown = false;

function planDemoView() {
  if (!DEMO || !map) return;
  const plan = HoodViewport.planWatch(h3, screenRect(), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS);
  demoPlan = plan ? { res: plan.res, cells: new Set(plan.cells) } : null;
  if (plan) zoomedOutWarned = false;
  else if (!zoomedOutWarned) {
    zoomedOutWarned = true;
    transientBanner(t("Zoom in to see who's around"));
  }
  refreshWorldMarkers();
}

// the demo's hexagons: counted afresh on every redraw (the pretend cars
// move each tick); none mid-ride, at the markers' level or at the floor
function renderDemoAgg(inRide) {
  aggData.clear();
  if (!inRide && demoPlan && demoPlan.res !== H3_RES) {
    const people = drivers.map((d) => ({ kind: "driver", pos: d.pos }));
    if (mockHand) people.push({ kind: "hand", pos: mockHand.pos });
    HoodBrowse.demoCounts(h3, people, demoPlan.res, demoPlan.cells).forEach((c) => aggData.set(c.cell, c));
  }
  if (aggData.size > 0 || demoAggShown) renderAggLayer();
  demoAggShown = aggData.size > 0;
}

function refreshWorldMarkers() {
  if (!DEMO) {
    renderRealMarkers();
    renderAggLayer(); // role/online changes re-filter the hex counts too
    return;
  }
  const inRide = state.ride && ["connected", "arrived"].includes(state.ride.status);
  // markers only at the markers' level (mid-ride: the partner, always)
  const markersLevel = inRide || (!!demoPlan && demoPlan.res === H3_RES);
  renderDemoAgg(inRide);
  drivers.forEach((d) => {
    const shouldShow =
      state.mode === "rider" && (inRide ? state.ride.peer === d : markersLevel);
    if (shouldShow && !d.visible) {
      d.marker.setLngLat([d.pos.lng, d.pos.lat]).addTo(map);
      d.visible = true;
    } else if (!shouldShow && d.visible) {
      d.marker.remove();
      d.visible = false;
    } else if (d.visible) {
      d.marker.setLngLat([d.pos.lng, d.pos.lat]);
    }
  });
  // the ✋ you're now picking up is your ride partner, shown as 🙋 at their
  // exact spot (materializeRiderMarker): this browse rule must leave them
  // alone — it removed the 🙋 just placed (owner, 2026-11-02)
  if (mockHand && !(inRide && state.ride.peer === mockHand)) {
    // same rule as real hands: tunnel vision mid-ride
    const shouldShow = state.mode === "driver" && state.online && !inRide && markersLevel;
    if (shouldShow && !mockHand.visible) {
      mockHand.marker.setLngLat([mockHand.pos.lng, mockHand.pos.lat]).addTo(map);
      mockHand.visible = true;
    } else if (!shouldShow && mockHand.visible) {
      mockHand.marker.remove();
      mockHand.visible = false;
    }
  }
  nearbyArrived();
}

// ===== World tick =====
function tick() {
  if (!state.worldSpawned) return;

  if (!DEMO) {
    loc.tick();
    pushDriverUpdate(); // keep presence fresh
    pushRidePos();
    // a partner position going stale: keep "last seen N min" current
    if (state.ride && state.ride.status === "connected" && !bannerTimer && !HoodRidePos.fresh(partnerAgeMs()) && partnerAgeMs() !== null)
      setBanner(contextBanner());
    return;
  }

  const inRide = state.ride && ["connected", "arrived"].includes(state.ride.status);

  drivers.forEach((d) => {
    if (inRide && state.mode === "rider" && state.ride.peer === d) {
      if (state.ride.status === "connected") {
        const target = state.pinPos || state.me;
        d.pos = stepToward(d.pos, target, 45);
        if (metersBetween(d.pos, target) < 35) {
          markArrived();
          receiveMsg(d, t("here! {car}", { car: d.car }));
        } else if (!state.pinArmed) {
          // (placing the pin: its hint stays — contextBanner)
          setBanner(CAR + t("{name} is on the way", { name: d.name }) + HoodCar.inLine(d.car) + " · " + away(metersBetween(d.pos, target)));
        }
      }
    } else if (!inRide) {
      d.pos = offsetPos(d.pos, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40);
    }
  });

  refreshWorldMarkers();
}

// ===== How far away (HoodDistance; ARCHITECTURE.md "Distances") =====
// Someone not driving shares their ~170 m block with whoever they message or
// ask for a ride — this is ours, when we're riding (a good reading only:
// currentSpot); drivers are public as cars already, so they share nothing.
function sharedSpot() {
  return state.mode === "rider" ? currentSpot() : null;
}

// a block someone shared with us: its centre, and its age (the server's age
// when it arrived, counted on from there on this device's steady clock)
function rememberShared(peer, { spot, age_ms }) {
  try {
    const [lat, lng] = h3.cellToLatLng(spot);
    peer.shared = { lat, lng, ageAtRx: age_ms || 0, rxAt: performance.now() };
  } catch (_) {} // not a block: ignore it
}

// "0.6 mi away · 20 min ago", or "" — the ride partner's exact
// position, else the block they show on my map, else the one they shared
function distanceTo(peer) {
  const here = DEMO ? state.me : loc.best;
  const partner = state.ride && state.ride.peer === peer;
  // demo people aren't real map entries: their position IS what the demo
  // map shows (as the profile card uses it)
  const entry = realEntries.get(peer.id);
  const onMap = DEMO ? !partner && !!peer.pos : !partner && entry && entry.type !== "ridepeer" && browseVisible(entry.type);
  const target = HoodDistance.target({
    ridePos: partner && (DEMO || peer.posExact) ? peer.pos : null,
    mapPos: onMap ? peer.pos : null,
    shared: peer.shared,
    now: performance.now(),
  });
  return HoodDistance.label(here, target, metersBetween, UNIT);
}

// the open chat's header (also on a timer: the age moves on)
function refreshChatDistance() {
  if (state.chatView === "msgs" && state.chatPeer && !$("chat").classList.contains("hidden"))
    $("chat-dist").textContent = distanceTo(state.chatPeer);
}
setInterval(refreshChatDistance, 30_000);

// ===== Peer card =====
function openPeerCard(peer) {
  state.cardPeer = peer;
  $("peer-photo").dataset.name = peer.name || "";
  $("peer-photo").src = peer.photo || HoodAvatar.url(peer.name);
  $("peer-name").textContent = peer.name;
  // no chat with a name we don't have yet (see openMarkerCard)
  $("btn-msg").disabled = !DEMO && HoodBrowse.needsReveal(peer);
  // away() is coarse (one decimal, "nearby" under 0.1 mi) — right
  // for a browse position, which is a block centre
  const here = DEMO ? state.me : loc.best;
  const dist = peer.pos && here ? away(metersBetween(here, peer.pos)) : "";
  const partner = state.ride && state.ride.peer === peer;
  const seen = partner ? HoodRidePos.lastSeen(partnerAgeMs()) : null;
  // a ride partner is whatever YOU aren't: peer.kind comes from the browse
  // map, which a reloaded app never saw them on (the driver read "Your rider")
  const kind = partner ? (state.ride.role === "rider" ? "driver" : "rider") : peer.kind;
  // two short lines (one long "·" line wrapped unevenly on a phone): who
  // they are, then where — "White Nissan Altima" / "0.7 mi away"
  setIconText(
    $("peer-what"),
    kind === "driver"
      ? partner
        ? t("{car} · your driver", { car: peer.car || t("Driver") })
        : peer.car || t("Driver")
      : partner
        ? CAR + t("Your rider")
        : t("✋ needs a ride")
  );
  $("peer-where").textContent = [seen, dist].filter(Boolean).join(" · ");
  $("peer-card").classList.remove("hidden");
}

function closePeerCard() {
  state.cardPeer = null;
  $("peer-card").classList.add("hidden");
}
$("peer-close").addEventListener("click", closePeerCard);
$("btn-msg").addEventListener("click", () => {
  $("peer-card").classList.add("hidden");
  openChat(state.cardPeer);
});

// ===== Chat =====
function pruneEmptyChats() {
  chats.forEach((c, p) => {
    if (HoodBrowse.chatPrunable(c, !!state.ride && state.ride.peer === p)) {
      chats.delete(p);
      if (state.chatPeer === p) state.chatPeer = null;
    }
  });
}

function openChatList() {
  pruneEmptyChats();
  if (chats.size === 0) {
    closeChat();
    return;
  }
  if (chats.size === 1) {
    openChat([...chats.keys()][0]);
    return;
  }
  state.chatView = "list";
  renderChat();
  $("chat").classList.remove("hidden");
  // at the top, once it shows: while hidden it can't be scrolled, and it
  // came back where it was left (owner, 2026-11-07)
  chatScrollTo(0);
  refreshControls();
}

function closeChat() {
  $("chat").classList.add("hidden");
  // an armed End chat goes with the panel: reopened, it asks again (review,
  // 2026-11-12: armed, closed, reopened in 3 s — one tap ended it)
  disarmEndChat();
  // the keyboard goes with it: its text box no longer focused (find the
  // nearest counts the keyboard's area only while you type — nearCovers)
  if (document.activeElement === $("chat-input")) $("chat-input").blur();
  pruneEmptyChats();
  refreshControls();
}
$("chat-close").addEventListener("click", closeChat);

// ===== End chat (owner, 2026-11-12) =====
// Either person ends a chat: gone for both, the other told "{name} ended
// the chat" (chat_closed's ended_by). Only a chat the server has (a message
// went or came, a reload's, a ride's) — and never your ride partner's while
// the ride lasts (it ends with the ride). Tap twice: the first tap turns it
// into "Tap again to end" for 3 s (no box to dismiss; owner's pick)
let endArmed = null;
let endTimer = null;
function canEndChat(peer) {
  const c = peer && chats.get(peer);
  if (DEMO || !c) return false;
  const onServer = c.server || c.msgs.some((m) => m.id != null);
  const rideWithThem = !!state.ride && !!state.ride.peer && state.ride.peer.id === peer.id;
  return onServer && !rideWithThem;
}
function disarmEndChat() {
  clearTimeout(endTimer);
  endTimer = null;
  endArmed = null;
  const b = $("chat-end");
  b.textContent = t("End chat");
  b.classList.remove("armed");
}
function showEndChat(peer) {
  if (endArmed && endArmed !== peer) disarmEndChat();
  $("chat-end").classList.toggle("hidden", !canEndChat(peer));
}
$("chat-end").addEventListener("click", () => {
  const peer = state.chatPeer;
  if (!canEndChat(peer)) return showEndChat(peer);
  if (endArmed !== peer) {
    endArmed = peer;
    $("chat-end").textContent = t("Tap again to end");
    $("chat-end").classList.add("armed");
    clearTimeout(endTimer);
    endTimer = setTimeout(disarmEndChat, 3000);
    return;
  }
  disarmEndChat();
  if (!liveNow()) return transientBanner(CANT_REACH());
  userChannel
    .push("end_chat", { peer: peer.id })
    // gone: here at once (the server tells both — ours says "me": no message)
    .receive("ok", () => closeChatWith(peer, "me"))
    .receive("error", (e) =>
      // already gone (the other ended it first, or the sweeper did)
      e && e.reason === "none" ? closeChatWith(peer, "me") : transientBanner(t("Couldn't end the chat — try again"))
    )
    .receive("timeout", () => transientBanner(t("Couldn't end the chat — try again")));
});

// ‹: the list — always, even with one other chat left (it jumped straight
// into that one: owner, 2026-11-07). Nothing is dropped while the window is
// open: a chat you opened and haven't written in yet stays in the list, to
// go back to without finding them on the map again; ✕ drops it
function backToList() {
  state.chatView = "list";
  renderChat();
  refreshControls();
}
$("chat-back").addEventListener("click", backToList);

function renderChat() {
  const box = $("chat-messages");
  msgCopy.close(); // its bubble is about to go
  // the list, newest on top: opened at the top; redrawn while it's on
  // screen (news, a reload), where you were (owner, 2026-11-07 — with more
  // than a screen of chats it opened at the bottom: the oldest)
  const listShown = !!box.querySelector(".chat-item");
  const listTop = listShown ? box.scrollTop : 0;
  box.innerHTML = "";
  if (state.chatView === "list") {
    $("chat-name").textContent = t("Chats");
    $("chat-dist").textContent = "";
    $("chat-photo").classList.add("hidden"); // the list's rows have their own
    showEndChat(null);
    // (the "about a block" note is off — index.html #chat-note)
    // $("chat-note").classList.add("hidden");
    $("chat-form").classList.add("hidden");
    // newest last message first; unread bold; how long ago (HoodChatList)
    const rows = HoodChatList.newestFirst([...chats].map(([peer, c]) => ({ peer, c, lastAt: c.lastAt, lastId: c.lastId })));
    rows.forEach(({ peer, c }) => {
      const item = document.createElement("div");
      item.className = "chat-item" + (c.unread ? " unread" : "");
      const img = document.createElement("img");
      img.className = "avatar avatar-mini";
      img.dataset.name = peer.name || "";
      img.src = peer.photo || HoodAvatar.url(peer.name);
      const info = document.createElement("div");
      info.className = "chat-item-info";
      const strong = document.createElement("strong");
      strong.textContent = peer.name;
      const last = document.createElement("span");
      last.className = "muted";
      // each in its own direction (an Arabic name, a Hebrew message)
      strong.dir = "auto";
      last.dir = "auto";
      // typed, not sent: "Draft" and that text (HoodChatList.preview)
      const line = HoodChatList.preview(c);
      if (line.draft) {
        const label = document.createElement("span");
        label.className = "chat-draft";
        label.textContent = t("Draft");
        last.append(label, " ", line.text);
      } else {
        last.textContent = line.text;
      }
      info.append(strong, last);
      const when = document.createElement("span");
      when.className = "chat-time muted";
      when.dataset.at = String(c.lastAt);
      when.textContent = HoodChatList.ago(Date.now() - c.lastAt);
      const side = document.createElement("div");
      side.className = "chat-item-side";
      side.appendChild(when);
      item.append(img, info, side);
      if (c.unread) {
        const dot = document.createElement("span");
        dot.className = "unread-dot";
        dot.textContent = c.unread;
        side.appendChild(dot);
      }
      item.addEventListener("click", () => openChat(peer));
      box.appendChild(item);
    });
    chatScrollTo(listTop);
    hideChatJump();
    return;
  } else if (state.chatPeer) {
    $("chat-name").textContent = state.chatPeer.name;
    $("chat-dist").textContent = distanceTo(state.chatPeer);
    // who you're talking to: the same photo as the chat list (their initial
    // without one)
    $("chat-photo").dataset.name = state.chatPeer.name || "";
    $("chat-photo").src = state.chatPeer.photo || HoodAvatar.url(state.chatPeer.name);
    $("chat-photo").classList.remove("hidden");
    showEndChat(state.chatPeer);
    // a rider's messages share their rough area with the person they write
    // to — the note saying so is off (index.html #chat-note; the privacy
    // page still says it)
    // $("chat-note").classList.toggle("hidden", state.mode !== "rider");
    $("chat-form").classList.remove("hidden");
    // not loaded yet: the header and the box, and "Loading…" (or Try again)
    // where the messages go — what's arrived meanwhile isn't drawn until
    // they come (loadChat). The test is "failed", never "loading": a failure
    // is drawn while the load is still finishing up
    if (chatFor(state.chatPeer).loaded === false) {
      box.appendChild(chatLoadingNote(chatFor(state.chatPeer)));
      chatStick.stuck = true;
      hideChatJump();
      return;
    }
    // drawing: every bubble follows (none is "new below you")
    chatStick.stuck = true;
    chatFor(state.chatPeer).msgs.forEach((m) => {
      if (m === chatLineMsg) box.appendChild(newMessagesLine());
      bubbleOf.set(m, appendBubble(m.text, m.mine));
    });
  }
  // (re)drawn: the newest at the bottom, nothing waiting below
  chatScrollTo(box.scrollHeight);
  chatStick.stuck = true;
  hideChatJump();
}

// "stuck to the bottom", remembered (HoodChatScroll.createStick): your own
// scrolling sets it, the app's scrolls and resizes don't
const chatStick = HoodChatScroll.createStick();

// the "New messages" line: above the first message that was unread when
// this chat was opened, if they didn't fit on screen — it stays put while
// you read (as Slack and Discord), gone the next time the chat is opened
let chatLineMsg = null;

// where you're reading the open chat, for a reload (softReload) to put you
// back: by MESSAGE, not by pixels — a reload brings the server's last 50
// (this phone may have had more) and drops this app's own notes ("📩
// requested a ride"), so what's above you changes (owner, 2026-11-08). The
// first message the server knows (its id) from the top of the screen down
// (on screen, or just below it), and how far from the top; the newest id
// you had, so only what's newer counts on ↓
function readingPlace() {
  const box = $("chat-messages");
  const boxTop = box.getBoundingClientRect().top;
  const msgs = chats.has(state.chatPeer) ? chats.get(state.chatPeer).msgs : [];
  let anchor = null;
  for (const m of msgs) {
    const el = bubbleOf.get(m);
    if (m.id == null || !el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > boxTop) {
      anchor = { id: m.id, offset: r.top - boxTop };
      break;
    }
  }
  const lastId = msgs.reduce((top, m) => (m.id != null && m.id > top ? m.id : top), -Infinity);
  // ↓'s count, the server's messages only — this app's notes among them are
  // dropped by the reload (they're the newest: what came in below you)
  const below = msgs.slice(Math.max(0, msgs.length - chatBelow)).filter((m) => m.id != null).length;
  // the "New messages" line, above the first message from it on that the
  // server knows (a note there is dropped by the reload)
  const from = chatLineMsg ? msgs.indexOf(chatLineMsg) : -1;
  const lineMsg = from > -1 ? msgs.slice(from).find((m) => m.id != null) : null;
  return { stuck: chatStick.stuck, below, lineId: lineMsg ? lineMsg.id : null, anchor, lastId };
}

// …and back there, the chat drawn again: that message where it was. Gone
// (older than the server's last 50): the top — the oldest there is, the
// nearest to where you were (the old pixel position, in a shorter list,
// landed far newer — owner, 2026-11-08). ↓ counts their messages newer
// than any you had.
// Ending up at the newest (the notes below you gone): at the bottom, as if
// you'd scrolled there — no ↓, new ones follow
function backToReadingPlace(place, msgs) {
  const box = $("chat-messages");
  const m = place.anchor && msgs.find((x) => x.id === place.anchor.id);
  const el = m && bubbleOf.get(m);
  if (el) chatScrollTo(box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - place.anchor.offset);
  else if (place.anchor) chatScrollTo(0);
  // (none at all: only this app's notes from the top of the screen down —
  // gone with the reload, so the newest, where renderChat left it)
  // (the scroll event after the redraw would say so too, a frame later —
  // ↓ flashed up for that frame)
  chatStick.stuck = HoodChatScroll.atBottom(box);
  chatBelow = chatStick.stuck ? 0 : place.below + msgs.filter((x) => !x.mine && x.id != null && x.id > place.lastId).length;
  updateChatJump();
}

function newMessagesLine() {
  const line = document.createElement("div");
  line.className = "chat-line";
  line.textContent = t("New messages");
  return line;
}

function removeNewMessagesLine() {
  chatLineMsg = null;
  const line = $("chat-messages").querySelector(".chat-line");
  if (!line) return;
  line.remove();
  // the list is a line shorter: the browser moves it up to fit, and that
  // move would read as YOU scrolling up (↓ at the bottom — the gate caught
  // it on a busy machine, owner 2026-11-05). At the bottom: put back there
  // by the app itself, so the move is the app's own
  if (chatStick.stuck) chatScrollTo($("chat-messages").scrollHeight);
}

// opened with unread messages: more than a screen of them → at the line,
// near the top, reading down from there; else (or none) at the newest,
// as renderChat left it (HoodChatScroll.openAt)
function openAtLine() {
  const box = $("chat-messages");
  const line = box.querySelector(".chat-line");
  const lineTop = line ? line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop : null;
  const at = HoodChatScroll.openAt({ lineTop, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight });
  if (at === "bottom") {
    removeNewMessagesLine();
    return;
  }
  chatScrollTo(at);
  chatStick.stuck = false;
  updateChatJump();
}

// ↓: shown whenever you're scrolled up; its badge counts the messages that
// came in below you (HoodChatScroll.jump). A tap takes you to the newest;
// reaching the bottom yourself clears it
let chatBelow = 0;

function updateChatJump() {
  const j = HoodChatScroll.jump({ stuck: chatStick.stuck, below: chatBelow });
  // clear of the list's scrollbar: its width as measured — a computer's
  // takes ~15px, a phone's floats over the text and takes none (owner,
  // 2026-11-06: the badge sat on the scrollbar). Full width minus the
  // inside minus borders (MDN clientWidth)
  if (j.show) {
    const box = $("chat-messages");
    const cs = getComputedStyle(box);
    const bar = box.offsetWidth - box.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    $("chat").style.setProperty("--chat-scrollbar", `${Math.max(0, Math.round(bar))}px`);
  }
  $("chat-jump").classList.toggle("hidden", !j.show);
  $("chat-jump-count").textContent = j.badge || "";
  $("chat-jump-count").classList.toggle("hidden", !j.badge);
}

function hideChatJump() {
  chatBelow = 0;
  $("chat-jump").classList.add("hidden");
  $("chat-jump-count").classList.add("hidden");
}

$("chat-jump").addEventListener("click", () => {
  const box = $("chat-messages");
  chatScrollTo(box.scrollHeight);
  chatStick.stuck = true;
  hideChatJump();
});

// your own scrolling decides "stuck to the bottom" (HoodChatScroll)
$("chat-messages").addEventListener("scroll", () => {
  // the list: no "stuck to the bottom", no ↓ (its newest are on top)
  if (state.chatView === "list") return;
  chatStick.onScroll($("chat-messages"));
  if (chatStick.stuck) hideChatJump();
  else updateChatJump();
});

// the list or the visible area changed size (the keyboard opening or
// closing, a rotation): a reader at the bottom stays there. Both, because
// phones differ — iPhone and current Chrome/Firefox shrink only the visible
// area (visualViewport), some browsers shrink the page (ResizeObserver)
// The decision is made now and done a frame later — and only if the reader
// is STILL stuck then: a chat opened in between at its "New messages" line
// isn't (openAtLine), and was sent to the bottom past its unread messages
// (the gate caught it on a busy machine, owner 2026-11-07)
function onChatResize() {
  const keep = chatStick.resizeStarted();
  requestAnimationFrame(() => {
    // (never the list: its newest are on top — it stays where it is)
    if (keep && chatStick.stuck && state.chatView !== "list") chatScrollTo($("chat-messages").scrollHeight);
    setTimeout(() => chatStick.resizeDone(), 1);
  });
}
if ("ResizeObserver" in window) new ResizeObserver(onChatResize).observe($("chat-messages"));
if (window.visualViewport) window.visualViewport.addEventListener("resize", onChatResize);

// the list's times age on screen ("now" → "1m" → …): redrawn every 30 s
// while it's open — the times only, the rows stay put
setInterval(() => {
  if (state.chatView !== "list" || $("chat").classList.contains("hidden")) return;
  for (const el of $("chat-messages").querySelectorAll(".chat-time"))
    el.textContent = HoodChatList.ago(Date.now() - Number(el.dataset.at));
}, 30_000);

// ===== Read up to (HoodReadStore) =====
// their messages from the server (not your own, not local notes like
// "📩 requested a ride"): what unread counts
function theirMsgs(peer) {
  const c = chatFor(peer);
  const here = c.msgs.filter((m) => !m.mine && m.id != null).map((m) => ({ ts: m.ts, id: m.id }));
  // not opened since a reload: the summary's (and what's come since)
  const s = (c.summary && c.summary.theirs) || [];
  if (!s.length) return here;
  const ids = new Set(s.map((m) => m.id));
  return [...s.map((m) => ({ ts: m.ts, id: m.id })), ...here.filter((m) => !ids.has(m.id))];
}

// after a rebuild (opening the app, a reconnect): unread = their messages
// after each chat's bookmark — what came while you were away
function applyReadState() {
  if (DEMO) return;
  const s = storageOrNull();
  const convs = [...chats].filter(([, c]) => c.server).map(([p]) => ({ peerId: p.id, theirs: theirMsgs(p) }));
  const r = HoodReadStore.reconcile(HoodReadStore.read(s, state.realUser.id), convs, null);
  chats.forEach((c, p) => {
    if (c.server) c.unread = r.unread[p.id] || 0;
  });
  HoodReadStore.save(s, state.realUser.id, r.note);
}

// this chat was seen: its bookmark moves to its newest message
function markSeen(peer) {
  if (DEMO) return;
  const s = storageOrNull();
  HoodReadStore.save(s, state.realUser.id, HoodReadStore.seen(HoodReadStore.read(s, state.realUser.id) || {}, peer.id, theirMsgs(peer)));
}

function openChat(peer) {
  const c = chatFor(peer);
  // the box holds THIS chat's draft (another's stays with them)
  $("chat-input").value = c.draft;
  updateChatCount();
  state.chatPeer = peer;
  state.chatView = "msgs";
  // not loaded since a reload: "Loading…" while its messages come
  // (loadChat) — nothing read, no line, until they're drawn
  if (c.loaded === false) {
    chatLineMsg = null;
    c.failed = false;
    $("chat").classList.remove("hidden");
    renderChat();
    refreshControls();
    if (!c.loading) loadChat(peer, c);
    return;
  }
  // the line goes above the first of what's unread now (opening reads all)
  const first = HoodChatScroll.firstUnread(c.msgs, c.unread);
  chatLineMsg = first >= 0 ? c.msgs[first] : null;
  c.unread = 0;
  markSeen(peer);
  // the panel shown FIRST, then drawn: a hidden box can't scroll, so drawn
  // while hidden the chat appeared at its oldest message and jumped to the
  // newest a frame later (owner, 2026-11-05 — measured: the top painted)
  $("chat").classList.remove("hidden");
  renderChat();
  openAtLine();
  refreshControls();
}

// ===== Light reload: a chat's messages when it's opened (owner, 2026-11-08) =====
// A reload brings each chat as a summary; opening one asks for its messages
// (GET /api/chat). What arrives meanwhile is held in it (receiveMsg) and put
// together with the answer (HoodChatMerge). The marks are on the chat
// object itself: a reload or a closed chat makes a new one, and an answer
// for the old one is dropped. Given up after CHAT_LOAD_MS — the reading of
// the answer included (a stalled download): "Couldn't load messages — try
// again".
const CHAT_LOAD_MS = 20000;
// its chat on screen (not the list)
const chatOnScreen = (peer) => !$("chat").classList.contains("hidden") && state.chatView === "msgs" && state.chatPeer === peer;
const chatListShown = () => !$("chat").classList.contains("hidden") && state.chatView === "list";

async function loadChat(peer, c) {
  c.loading = true;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), CHAT_LOAD_MS);
  let outcome = "failed";
  let body = null;
  try {
    const res = await apiFetch(`/api/chat?peer=${encodeURIComponent(peer.id)}`, { signal: stop.signal });
    // signed out, or new Terms: the reload shows the sign-in or asks
    if (chats.get(peer) === c && refusedReload(await ownRefusal(res))) return;
    if (res.ok) {
      body = await res.json();
      outcome = "ok";
    } else if (res.status === 404) {
      // the chat's gone — only Hood Ride's own "none" says so (a 404 from
      // anything else, e.g. an older server, is a failure: try again)
      const b = await res.json().catch(() => null);
      if (b && b.error === "none") outcome = "none";
    }
  } catch (_) {
    // the network, or given up (CHAT_LOAD_MS): a failure
  } finally {
    clearTimeout(timer);
    c.loading = false;
  }
  // a reload or a closed chat since: this answer is for a chat that's gone
  if (chats.get(peer) !== c) return;
  if (outcome === "none") return closeChatWith(peer);
  if (outcome !== "ok" || !body || !Array.isArray(body.messages)) {
    c.failed = true;
    if (chatOnScreen(peer)) renderChat();
    return;
  }
  c.msgs = HoodChatMerge.merge(body.messages.map(fromServer), c.msgs);
  c.loaded = true;
  c.summary = null;
  c.failed = false;
  // its last item's time and id (today's rule)
  settleLast(c);
  if (chatOnScreen(peer)) {
    // drawn as opening a chat does: the line above the first unread, read,
    // drawn, then placed at the line (openAtLine looks for it on screen)
    const first = HoodChatScroll.firstUnread(c.msgs, c.unread);
    chatLineMsg = first >= 0 ? c.msgs[first] : null;
    c.unread = 0;
    markSeen(peer);
    renderChat();
    openAtLine();
    refreshControls();
  } else if (chatListShown()) {
    renderChat();
  }
}

// a chat that's loading (or couldn't load): its header as always, and in
// place of the messages "Loading…" — or why not, with Try again (which
// opens it again: one load at a time)
function chatLoadingNote(c) {
  const note = document.createElement("div");
  note.className = "chat-loading muted";
  if (!c.failed) {
    note.textContent = t("Loading…");
    return note;
  }
  const why = document.createElement("div");
  why.textContent = t("Couldn't load messages — try again");
  const again = document.createElement("button");
  again.id = "chatRetry";
  again.type = "button";
  again.className = "btn btn-primary";
  again.textContent = t("Try again");
  again.addEventListener("click", () => state.chatPeer && openChat(state.chatPeer));
  note.append(why, again);
  return note;
}

// each message's bubble as drawn now (renderChat draws them all again): a
// refused message takes back the one on screen — the one drawn when it was
// sent was gone after leaving the chat and coming back, and the refused
// message stayed, looking sent (owner, 2026-11-08)
const bubbleOf = new WeakMap();

function appendBubble(text, mine) {
  // were you following the chat? REMEMBERED (chatStick), not measured now:
  // the keyboard opening moves the list without you scrolling
  const wasAtBottom = chatStick.stuck;
  const div = document.createElement("div");
  div.className = "msg " + (mine ? "me" : "them");
  // right-to-left languages read right; hidden direction characters stay
  // inside this bubble (dir isolates it)
  div.dir = "auto";
  div.textContent = text;
  // tap (or Enter) → "Copy" under it (HoodMsgCopy)
  div.tabIndex = 0;
  div.addEventListener("click", () => msgCopy.tap(div, text));
  div.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      msgCopy.tap(div, text);
    }
  });
  $("chat-messages").appendChild(div);
  // following (or your own): to the new bubble; scrolled up to reread:
  // stay put, the button says there's more below
  if (HoodChatScroll.onNew({ mine, wasAtBottom }) === "follow") {
    chatScrollTo($("chat-messages").scrollHeight);
    chatStick.stuck = true;
  } else {
    // (only theirs ever waits: yours always follows)
    chatBelow++;
    updateChatJump();
  }
  return div;
}

// where the APP last put the chat. The copy chip closes when the person
// scrolls — wheel, finger, scrollbar or keys alike — but the app scrolls
// too (a new message, opening the chat, bringing the chip into view): a
// scroll that lands where the app put it is the app's own. "Stuck to the
// bottom" is told too, so the app's scrolls never count as yours.
let appScrollTop = null;
function chatScrollTo(top) {
  const box = $("chat-messages");
  box.scrollTop = top;
  appScrollTop = box.scrollTop; // as the browser clamped it
  chatStick.ownScroll(appScrollTop);
}

// THE COPY CHIP: one reusable button, placed under the tapped bubble; it
// closes on a tap anywhere else and on the person's own scrolling.
const copyChip = document.createElement("button");
copyChip.type = "button";
copyChip.className = "msg-copy";
const COPY_LABELS = { copy: () => t("Copy"), copied: () => t("Copied ✓"), failed: () => t("Couldn't copy") };
const msgCopy = HoodMsgCopy.create({
  // the async clipboard needs a secure page (https, or localhost)
  clipboard: window.isSecureContext && navigator.clipboard ? navigator.clipboard : null,
  // the older copy (plain http, e.g. a phone on the PC's Wi-Fi address)
  legacyCopy: (text) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  },
  // the chip FLOATS over the chat (position: absolute in the scrolling
  // message area, so it moves with its message) — never in the flow, where
  // it pushed every later message down. HoodMsgCopy.place picks the spot.
  render: (open) => {
    if (!open) return copyChip.remove();
    const box = $("chat-messages");
    const bubble = open.key;
    copyChip.textContent = COPY_LABELS[open.label]();
    copyChip.setAttribute("aria-label", open.label === "copy" ? t("Copy message") : COPY_LABELS[open.label]());
    box.appendChild(copyChip);
    const spot = HoodMsgCopy.place(
      { left: bubble.offsetLeft, top: bubble.offsetTop, width: bubble.offsetWidth, height: bubble.offsetHeight },
      { width: copyChip.offsetWidth, height: copyChip.offsetHeight },
      box.clientWidth,
      bubble.classList.contains("me") ? "me" : "them"
    );
    copyChip.style.left = spot.left + "px";
    copyChip.style.top = spot.top + "px";
    copyChip.scrollIntoView({ block: "nearest" });
    appScrollTop = box.scrollTop;
    chatStick.ownScroll(appScrollTop);
  },
  hasSelection: () => {
    const s = window.getSelection();
    return !!s && !s.isCollapsed && String(s).length > 0;
  },
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (timer) => clearTimeout(timer),
});
copyChip.addEventListener("click", (e) => {
  e.stopPropagation();
  msgCopy.copy();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".msg, .msg-copy")) msgCopy.close();
});
// Escape closes it, and focus goes back to the message it was for
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const was = msgCopy.close();
  if (was) was.focus();
});
$("chat-messages").addEventListener(
  "scroll",
  () => {
    if ($("chat-messages").scrollTop !== appScrollTop) msgCopy.close();
  },
  { passive: true }
);

// meta: the server's {ts, id} for a real message (none for the demo's or a
// local note like "📩 requested a ride")
function receiveMsg(peer, text, meta) {
  const c = chatFor(peer);
  const id = meta ? meta.id : null;
  // already here — a message a reload or a chat's opening brought, heard
  // live too: once (counted once, no banner). Local notes have no id: never
  if (id != null && (c.msgs.some((m) => m.id === id) || ((c.summary && c.summary.theirs) || []).some((m) => m.id === id))) return;
  const at = meta ? HoodChatList.localAt(meta.ts, chatSkew) : Date.now();
  c.lastAt = at;
  c.lastId = id;
  const msg = { text, mine: false, at, ts: meta ? meta.ts : null, id };
  // not loaded yet: a note remembers what it came after, to go there when
  // the messages come (HoodChatMerge)
  if (c.loaded === false && id == null) msg.after = newestKnownId(c);
  c.msgs.push(msg);
  const chatOpen = !$("chat").classList.contains("hidden");
  const onScreen = chatOpen && state.chatView === "msgs" && state.chatPeer === peer;
  // a chat still loading isn't drawn or read here: what came is drawn with
  // its messages (and no banner — it's the chat you're on)
  const viewingThis = onScreen && c.loaded !== false;
  if (viewingThis) {
    bubbleOf.set(msg, appendBubble(text, false));
    markSeen(peer);
  } else {
    c.unread++;
    // mid-ride, only the ride partner may interrupt the ride banner —
    // everyone else ticks the unread badge quietly
    const inRide = state.ride && ["connected", "arrived"].includes(state.ride.status);
    if (!onScreen && (!inRide || state.ride.peer === peer)) {
      transientBanner(["\u{1F4AC} ", { raw: `${peer.name}: ${text}` }]);
    }
    if (chatOpen && state.chatView === "list") renderChat();
  }
  refreshControls();
}

// the newest message id this chat knows: its last with one, else (not
// opened since a reload) the summary's last, else none
function newestKnownId(c) {
  for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].id != null) return c.msgs[i].id;
  return (c.summary && c.summary.last && c.summary.last.id) ?? null;
}

// the 500-character warning (HoodChatList.limit): from 400 what's left,
// over 500 how many too many — a warning, never a cut (the text is yours).
// Screen readers hear it politely once typing pauses; the region only goes
// live once typing starts (VoiceOver read it at page load — USWDS 3.14)
let chatCountTimer = null;
function updateChatCount() {
  const s = HoodChatList.limit(HoodChatList.count($("chat-input").value));
  const el = $("chat-count");
  el.textContent = s.text;
  el.classList.toggle("hidden", !s.show);
  el.classList.toggle("over", s.over);
  $("chat-count-alert").textContent = ""; // a refused Send's alert: you're editing now
  const sr = $("chat-count-sr");
  sr.setAttribute("aria-live", "polite");
  clearTimeout(chatCountTimer);
  chatCountTimer = setTimeout(() => (sr.textContent = s.show ? s.text : ""), 500);
}
$("chat-input").addEventListener("input", () => {
  // what's typed is the open chat's draft
  if (state.chatPeer && chats.has(state.chatPeer)) chats.get(state.chatPeer).draft = $("chat-input").value;
  updateChatCount();
});

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  const peer = state.chatPeer;
  if (!text || !peer) return;
  // a chat still loading (or that couldn't load): Send does nothing yet and
  // the text stays — it looks as always (owner, 2026-11-08: no greyed Send)
  if (chats.get(peer)?.loaded === false) return;
  // over the limit: Send stays tappable (no greyed-out button), sends
  // nothing, keeps the text, and says why — announced at once
  if (HoodChatList.count(text) > HoodChatList.MAX_CHARS) {
    // one message (not "{count} characters too many" + a tail): the
    // language decides how the two halves join
    const over = HoodChatList.count(text) - HoodChatList.MAX_CHARS;
    const why = tn(
      "{count} character too many — shorten your message to send",
      "{count} characters too many — shorten your message to send",
      over
    );
    $("chat-count").textContent = why;
    $("chat-count").classList.remove("hidden");
    $("chat-count").classList.add("over");
    $("chat-count-alert").textContent = why;
    return;
  }
  // never shown as sent unless it can go; the text stays in the box
  if (!DEMO && !liveNow()) return transientBanner(CANT_REACH());
  $("chat-count-alert").textContent = "";
  const sentMsg = { text, mine: true, at: Date.now() };
  chatFor(peer).msgs.push(sentMsg);
  chatFor(peer).lastAt = sentMsg.at;
  // you replied: caught up — the "New messages" line goes (as Discord)
  removeNewMessagesLine();
  bubbleOf.set(sentMsg, appendBubble(text, true));
  input.value = "";
  chatFor(peer).draft = "";
  updateChatCount();

  if (!DEMO) {
    // optimistic echo rolled back: the server refused, or never answered —
    // un-say it, and the text goes back in the box (if nothing new is
    // typed there): nothing typed is lost
    const unsay = (why) => {
      bubbleOf.get(sentMsg)?.remove(); // the one on screen now (bubbleOf)
      let c = chats.get(peer);
      if (!c) {
        // the server closed it meanwhile (they left): nobody to keep it
        // for, as "not available" drops the text — it isn't brought back as
        // a draft (owner, 2026-11-07). (A chat you opened with them again
        // meanwhile is a new one: the text goes back there)
        if (peer.chatClosed) return transientBanner(why);
        // else only a reload rebuilt the chats (a first message still on
        // its way isn't one the server has yet): back, with your text as
        // its draft — nothing typed is lost (owner, 2026-11-08)
        c = chatFor(peer);
      }
      const arr = c.msgs;
      const i = arr.indexOf(sentMsg);
      if (i > -1) arr.splice(i, 1);
      // back as their draft, if nothing new was typed for them meanwhile —
      // in the box too if their chat is the one open
      if (!c.draft) {
        c.draft = text;
        if (state.chatPeer === peer) {
          input.value = text;
          updateChatCount();
        }
      }
      // the chat's time and id are its last message's again — a refused
      // message put the chat on top of the list, "now" (owner, 2026-11-07);
      // an earlier one's "sent" may have come meanwhile, unrecorded (this
      // one was the last then) — or, with none left, when it was started
      // (two refused in a row left the first's). The list, if it's
      // showing: drawn again (its order, and the draft)
      settleLast(c);
      if (!$("chat").classList.contains("hidden") && state.chatView === "list") renderChat();
      transientBanner(why);
    };
    // its own id (cid): a reply lost (the connection dropped just after it
    // went) — the app sends it AGAIN with the same id, once: the server
    // recognizes it (Hoodride.Chat.sent_receipt), gives the same receipt and
    // never delivers it twice. Only if that fails too: "didn't send" (owner,
    // 2026-11-10: it said so when it HAD gone — sent again: a duplicate).
    // (Phoenix holds a push made while reconnecting and sends it on rejoin.)
    const payload = { to: peer.id, text, spot: sharedSpot(), cid: newMessageId() };
    const attempt = (last) =>
    userChannel
      .push("send_msg", payload)
      // sent: its time and id are the server's from now on, like everyone
      // else's (whole seconds, then the id) — this phone's exact time put it
      // ahead of a message that came in later the same second (owner,
      // 2026-11-07)
      .receive("ok", (r) => {
        if (!r || typeof r.ts !== "number") return;
        sentMsg.ts = r.ts;
        sentMsg.id = r.id;
        sentMsg.at = HoodChatList.localAt(r.ts, chatSkew);
        const c = chats.get(peer);
        if (!c || c.msgs[c.msgs.length - 1] !== sentMsg) return; // something newer since
        c.lastAt = sentMsg.at;
        c.lastId = r.id;
        // delivered: the chat is on the server now — it can be ended
        if (state.chatPeer === peer) showEndChat(peer);
        // the list, if it's showing (‹ tapped before the answer): its order
        // may change — a message that came in the same second goes on top
        if (!$("chat").classList.contains("hidden") && state.chatView === "list") renderChat();
      })
      .receive("error", (e) => {
        const msgs = {
          too_long: t("Message too long — keep it under {max} characters", { max: HoodChatList.MAX_CHARS }),
          stacked_marks: t("Message has too many marks stacked on one letter"),
          unavailable: t("{name} isn't available right now", { name: peer.name }),
          out_of_view: t("{name} isn't in view — zoom in and find their car again", { name: peer.name }),
          rate_limited: t("⏳ You're sending too fast — slow down a sec"),
          too_many_new_chats: t("You've started a lot of new chats — try again later"),
          too_many_chats: t("You've started too many chats — end one of them first"),
          // (the server busy: your text stays — try again)
          busy: t("Message didn't send — try again"),
        };
        unsay(msgs[e.reason] || t("Message didn't send — connection?"));
        // can't message them now (a first message): nothing to keep their
        // chat open for — it closes (the list, if that's what shows, stays).
        // Not in view keeps your text (find the car, tap Message); not
        // available drops it
        if (e.reason === "out_of_view" || e.reason === "unavailable") {
          if (e.reason === "unavailable") {
            if (chats.has(peer)) chats.get(peer).draft = "";
            if (state.chatPeer === peer) {
              $("chat-input").value = "";
              updateChatCount();
            }
          }
          const listShowing = !$("chat").classList.contains("hidden") && state.chatView === "list";
          const theirsOnScreen = !$("chat").classList.contains("hidden") && !listShowing && state.chatPeer === peer;
          // their chat, if nothing's left in it (no message, no draft): removed
          // — even with the panel closed (a reload can bring it back empty:
          // unsay — owner, 2026-11-08). Only theirs: other people's chats you
          // opened and haven't written in yet stay in the list (backToList)
          const own = chats.get(peer);
          if (own && HoodBrowse.chatPrunable(own, !!state.ride && state.ride.peer === peer)) chats.delete(peer);
          // their chat on screen: closed. The list (‹ before the answer):
          // stays, drawn again — or closed with nothing left in it (owner,
          // 2026-11-07: the whole list closed)
          if (listShowing) {
            if (chats.size) renderChat();
            else closeChat();
          } else if (theirsOnScreen) closeChat();
          refreshControls(); // the 💬 button: one chat fewer
        }
      })
      .receive("timeout", () => (last ? unsay(t("Message didn't send — try again")) : attempt(true)));
    attempt(false);
    return;
  }

  const c = chatFor(peer);
  const replies = peer.kind === "driver" ? DRIVER_REPLIES() : RIDER_REPLIES();
  const line = replies[Math.min(c.replyIdx++, replies.length - 1)];
  setTimeout(() => {
    receiveMsg(peer, line);
    // a pretend rider asks for a ride only while you're online — the server
    // refuses requests to offline drivers (else: "Decline" with no Accept)
    if (peer.kind === "rider" && !peer.pending && !state.ride && state.mode === "driver" && state.online) {
      peer.pending = true;
      refreshControls();
    }
  }, 1100);
});

// ===== Ride flow =====
// A request or accept on its way (race audit, 2026-10-29): a quick second
// tap used to send a second push, whose answer showed a FALSE message ("You
// already have an open request" right after succeeding; "Too late — the
// request was withdrawn" while the ride was starting). Set synchronously on
// the tap; taps are ignored until the answer — any answer, or Phoenix's 10 s
// timeout. The button says what's happening and is aria-disabled (it keeps
// focus — not `disabled`; `aria-busy` is unreliable on buttons), and a
// polite status says it too (VoiceOver may not read a changed label). The
// server's own repeat handling stays the real safeguard.
function startRideAction(label, status) {
  rideActionInFlight = label;
  $("ride-action-status").textContent = status;
  refreshControls();
}
function endRideAction() {
  rideActionInFlight = null;
  $("ride-action-status").textContent = "";
  refreshControls();
}

$("btn-ride-action").addEventListener("click", () => {
  if (rideActionInFlight) return;
  const peer = state.chatPeer;
  if (!peer || state.ride) return;

  if (!DEMO) {
    if (state.mode === "rider") {
      startRideAction(t("Requesting…"), t("Requesting your ride…"));
      loc.requestCheck();
      userChannel
        .push("request_ride", { to: peer.id, spot: sharedSpot() })
        .receive("ok", () => {
          state.ride = { peer, status: "requested" };
          setBanner(contextBanner());
          endRideAction();
        })
        .receive("timeout", () => {
          // slow, not necessarily failed: the server may have it — ask it
          endRideAction();
          softReload();
        })
        .receive("error", (e) => {
          endRideAction();
          // a repeat (e.g. after a timeout that DID go through): the server
          // knows best — re-sync rather than a puzzling message
          if (e.reason === "already_requested") return softReload();
          const msgs = {
            already_requested: t("You already have an open request"),
            in_ride: t("Finish your current ride first"),
            driver_busy: t("{name} is on a ride right now", { name: peer.name }),
            driver_offline: t("{name}'s gone offline — try another driver", { name: peer.name }),
            unavailable: t("{name} isn't available right now — try another driver", { name: peer.name }),
            out_of_view: t("{name} isn't in view — zoom in and find their car again", { name: peer.name }),
            request_cooldown: t("Give this driver a minute before asking again"),
            rate_limited: t("⏳ Slow down a sec"),
            too_many_new_chats: t("You've contacted a lot of new people — try again later"),
            busy: t("Couldn't reach the server — try again"),
          };
          transientBanner(msgs[e.reason] || t("Couldn't send the request"));
        });
    } else {
      startRideAction(t("Accepting…"), t("Accepting the ride…"));
      userChannel
        .push("accept_request", { rider_id: peer.id })
        .receive("ok", () => endRideAction())
        // slow: if it went through, "ride_started" still arrives
        .receive("timeout", () => endRideAction())
        .receive("error", (e) => {
          endRideAction();
          peer.pending = false;
          const msgs = {
            gone: t("Too late — the request was withdrawn"),
            busy: t("Finish your current ride first"),
          };
          transientBanner(msgs[e.reason] || t("Couldn't accept"));
          refreshControls();
        });
      // success arrives as "ride_started"
    }
    return;
  }

  if (state.mode === "rider") {
    state.ride = { peer, status: "requested" };
    setBanner(contextBanner());
    setTimeout(() => {
      if (!state.ride || state.ride.peer !== peer || state.ride.status !== "requested") return;
      state.ride.status = "connected";
      state.handRaised = false;
      // as in the real app (startRealRide): to the MAP — the chat one tap
      // away, the driver's message as a banner
      closeChat();
      receiveMsg(peer, t("accepted! omw 🚗"));
      setBanner(contextBanner());
      refreshControls();
      refreshWorldMarkers();
    }, 1800);
  } else {
    state.ride = { peer, status: "connected" };
    peer.pending = false;
    closePeerCard();
    // unavailable now — everyone else waiting is declined, same as the server rule
    chats.forEach((_c, p) => {
      if (p !== peer && p.kind === "rider" && p.pending) p.pending = false;
    });
    // acceptance unlocks the exact position — the fuzz snaps to truth
    if (peer.exactPos) peer.pos = peer.exactPos;
    // known at once here (no GPS to wait for): Navigate may go there
    peer.posExact = true;
    materializeRiderMarker(peer);
    // as in the real app (startRealRide): to the MAP — the chat one tap
    // away, the rider's message as a banner
    closeChat();
    receiveMsg(peer, t("sweet, see you soon!"));
    setBanner(contextBanner());
  }
  refreshControls();
  refreshWorldMarkers();
});

function materializeRiderMarker(peer) {
  if (peer.marker) {
    peer.marker.remove();
    peer.visible = false;
  }
  // 🙋 for whoever you pick up, as the real app (ensureRidePeerEntry) —
  // not the pretend rider's own emoji (owner, 2026-11-02)
  peer.marker = makeBubbleMarker("🙋", () => openPeerCard(peer));
  peer.marker.setLngLat([peer.pos.lng, peer.pos.lat]).addTo(map);
  peer.visible = true;
}

$("btn-decline").addEventListener("click", () => {
  const peer = state.chatPeer;
  if (!peer) return;
  peer.pending = false;
  if (!DEMO) {
    userChannel.push("decline_request", { rider_id: peer.id });
  }
  transientBanner(t("Request declined"));
  if (DEMO) scheduleIncomingRequest();
  refreshControls();
});

$("btn-endride").addEventListener("click", endRide);

// a Cancel answered "accepted": how long the ride's news gets before the
// app asks the server (endRide)
const ACCEPTED_WAIT_MS = 5000;

function endRide() {
  if (!state.ride) return;
  if (!DEMO && !liveNow()) return transientBanner(CANT_REACH());

  if (!DEMO) {
    if (state.ride.status === "requested") {
      // cancelled once the server says so: a Cancel just after the driver's
      // Accept finds the ride already starting — "accepted": the ride comes
      // (ride_started), never a "Request cancelled" before it
      // (test_browser/cancelrace.mjs)
      const asked = state.ride;
      userChannel
        .push("cancel_request", {})
        .receive("ok", () => {
          if (state.ride === asked) state.ride = null;
          transientBanner(t("Request cancelled"));
          refreshControls();
        })
        .receive("error", (e) => {
          // the ride comes (ride_started). If it doesn't within a few
          // seconds — its start failed after all, or the news was lost —
          // the server says what's true (crash review 2026-11-14: the
          // Cancel otherwise did nothing; test_browser/cancelrace.mjs)
          if (e && e.reason === "accepted") {
            setTimeout(() => {
              if (state.ride === asked) softReload();
            }, ACCEPTED_WAIT_MS);
            return;
          }
          if (e && e.reason === "rate_limited") return transientBanner(t("⏳ Slow down a sec"));
          // (anything else: the server knows best — as for a request)
          softReload();
        })
        // slow, not necessarily failed: the server may have it — ask it
        .receive("timeout", () => softReload());
    } else {
      // right after a reload the ride is known before its channel is set up
      // (that waits for the socket): join it now — the push waits for the
      // join. It was skipped there, silently: the tap did nothing and the
      // ride went on (a journey's flaky "Rob's ride ended", 2026-11-05)
      if (!rideChannel) joinRideChannel();
      if (!rideChannel) return transientBanner(CANT_REACH());
      transientBanner(t("Ride ended"));
      rideChannel.push("end_ride", {});
      // cleanup happens on the "ended" broadcast (both sides)
    }
    return;
  }

  const peer = state.ride.peer;
  const wasRequested = state.ride.status === "requested";
  state.ride = null;
  if (wasRequested) {
    transientBanner(t("Request cancelled"));
    refreshControls();
    return;
  }
  state.pinArmed = false;
  state.pinPos = null;
  if (pinMarker) {
    pinMarker.remove();
    pinMarker = null;
  }
  if (peer) {
    chats.delete(peer);
    if (peer.kind === "rider" && peer.marker) {
      peer.marker.remove();
      peer.visible = false;
    }
    if (mockHand === peer) mockHand = null;
  }
  state.chatPeer = null;
  closeChat();
  state.online = false; // same rule in demo mode: ride over → driver offline
  setBanner(contextBanner());
  refreshControls();
  refreshWorldMarkers();
}

// ===== Pin =====
// Meet here / Move pin: street level (owner, 2026-10-29) — side streets
// named, a fingertip about one corner (~80 m; at 14 it was ~300 m)
const PIN_ZOOM = 16;

$("btn-pin").addEventListener("click", () => {
  state.pinArmed = !state.pinArmed;
  refreshControls();
  if (state.pinArmed) {
    // on the pin to move it, else on you — and only ever zoomed IN
    const at = state.pinPos || state.me;
    map.easeTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), PIN_ZOOM) });
  }
  // the hint while armed, the ride's line once not (contextBanner)
  setBanner(contextBanner());
});

function placePin(pos) {
  state.pinArmed = false;

  if (!DEMO) {
    if (rideChannel) {
      rideChannel.push("set_pin", { lat: pos.lat, lng: pos.lng });
      // rendering happens on the "pin" broadcast (both sides, consistent)
      transientBanner(t("📍 Meetup spot set — your driver sees it"));
    }
    refreshControls();
    return;
  }

  state.pinPos = pos;
  if (!pinMarker) {
    pinMarker = new maplibregl.Marker({ element: makePinEl(), anchor: "bottom" });
  }
  pinMarker.setLngLat([pos.lng, pos.lat]).addTo(map);
  transientBanner(t("📍 Meetup spot set — your driver sees it"));
  if (state.ride) receiveMsg(state.ride.peer, t("got it, heading to your pin 📍"));
  refreshControls();
}

// ===== ✋ Need a ride =====
$("btn-hand").addEventListener("click", () => {
  // the tap is the intent: now with a good live reading, otherwise on the
  // first good one (a second tap cancels the wait; lowering never waits)
  if (DEMO) setHand(!state.handRaised);
  // up or down, refused at once while not live (no GPS wait for something
  // that can't go through); cancelling a GPS wait is this phone's own
  else if (!liveNow() && !loc.pending.hand) transientBanner(CANT_REACH());
  else locTap("hand");
});

// Go online and Need a ride: the camera centres on you at this zoom — the
// same for both (owner, 2026-10-29), about 3 km across on a phone, so
// drivers see the hands around them and riders the cars around them
const INTENT_ZOOM = 14;

// ===== Find the nearest (nearby.js; owner, 2026-11-07, step by step and the box rule 2026-11-09) =====
// Go online, ✋ up, or the locate button while either is on: centred on
// you at the usual view (INTENT_ZOOM — closer in on a screen so big it
// shows counts there: markerStartZoom; no search at all on one that shows
// counts at every zoom), then out half a level at a time — waiting at each
// step for the server's answer for that view, drawn, however long it takes
// (a reconnect too), and while a drawer or form hides the map — until
// anyone you're looking for is in sight: their whole marker on the screen,
// under nothing drawn over the map (the box rule, HoodNearby.inSight). No
// zooming back in, so the others around show too. Nobody even at the widest
// view that still shows people one by one: the banner adds "nobody nearby
// yet" until someone comes into sight. What it said stays true over time:
// someone it found gone a while (the back-off: 5, 10, 20… s, ±20%), or
// you moved 500 m — it looks again, outward from the zoom the map is at:
// the map never zooms in by itself, only your tap gives a fresh close-up
// (owner, 2026-11-10; coming back to the app searches nothing). Only what the map already shows is used (no "nearest"
// question to the server). Any other move of the map — yours, or the app's
// — ends it; so does a view the server refuses for good, or the screen
// changing size mid-search.
// What covers the map (owner, 2026-11-09: "if you can see it on the map, it
// counts" — the box rule, HoodNearby.inSight): everything that can sit over
// the map while you look — a code test checks this list against the page
// and against what the app adds itself. Only what's showing counts; each is
// its box, measured where it is now. Each entry is what you SEE: the bottom
// bar is a see-through row across the screen — its buttons are the covers,
// one by one, not the row. The map's own controls (its credits) cover too.
// Your own blue dot doesn't: it's drawn under everyone (showMe — an 18 px
// dot under a 44 px car: the car is in plain sight). A solid ring drawn
// round a cover (the raised ✋'s yellow ring, a focus outline) is part of
// it: its box grows by the ring (HoodNearby.ringReach).
const NEAR_COVERS = [
  "#btn-account",
  ".topbar-title",
  "#btn-mode",
  "#banner",
  "#update-available",
  "#btn-locate",
  "#bottom-controls > *",
  "#share-location",
  "#peer-card",
  "#pile-sheet",
  "#chat",
  ".maplibregl-ctrl",
];
// a single marker's half-size (a group's is measured: it's wider)
const NEAR_HALF = { x: 22, y: 22 };
// the phone's safe-area insets (px): the padding of #safe-probe, which is
// env(safe-area-inset-*) (styles.css) — made at start (initMap)
function safeInsets() {
  const el = document.getElementById("safe-probe");
  if (!el) return { top: 0, bottom: 0, left: 0, right: 0 };
  const cs = getComputedStyle(el);
  return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
}
function nearCovers() {
  const m = $("map").getBoundingClientRect();
  const covers = [];
  for (const sel of NEAR_COVERS)
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest(".hidden")) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const g = HoodNearby.ringReach(getComputedStyle(el));
      covers.push({ top: b.top - m.top - g, bottom: b.bottom - m.top + g, left: b.left - m.left - g, right: b.right - m.left + g });
    }
  // the phone's own edges the page is drawn under (viewport-fit=cover: the
  // notch, the status bar, the home bar — #safe-probe's padding is them)
  const inset = safeInsets();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const strip = (top, bottom, left, right) => covers.push({ top: top - m.top, bottom: bottom - m.top, left: left - m.left, right: right - m.left });
  if (inset.top) strip(0, inset.top, 0, W);
  if (inset.bottom) strip(H - inset.bottom, H, 0, W);
  if (inset.left) strip(0, H, 0, inset.left);
  if (inset.right) strip(0, H, W - inset.right, W);
  // what the visible area leaves out (the on-screen keyboard over the
  // bottom, on a phone that doesn't shrink the page for it) — only while
  // you type (the keyboard is up only then: iOS 26 can report a leftover
  // keyboard area after it closes), or the page pinched in
  const vv = window.visualViewport;
  const field = document.activeElement;
  // (a text box in something closed doesn't count — a browser can leave
  // the focus there)
  const typing = !!field && !field.closest(".hidden") && field.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  if (vv && (typing || vv.scale > 1.01)) {
    if (vv.offsetTop > 0.5) strip(0, vv.offsetTop, 0, W);
    if (vv.offsetTop + vv.height < H - 0.5) strip(vv.offsetTop + vv.height, H, 0, W);
    // (the page pinched sideways on a desktop trackpad: its sides too)
    if (vv.offsetLeft > 0.5) strip(0, H, 0, vv.offsetLeft);
    if (vv.offsetLeft + vv.width < W - 0.5) strip(0, H, vv.offsetLeft + vv.width, W);
  }
  return covers;
}
// the map out of sight: a drawer or a form over all of it, or the "Use
// here" cover — nobody can be seen on it then
function mapOutOfSight() {
  // (one that's gone from the page is simply not open — never an error)
  const shown = (id, open) => {
    const el = document.getElementById(id);
    return !!el && (open ? el.classList.contains("open") : !el.classList.contains("hidden"));
  };
  const onScreen = (id) => {
    const el = document.getElementById(id);
    if (!el || getComputedStyle(el).visibility === "hidden") return false;
    const b = el.getBoundingClientRect();
    return b.right > 0.5 && b.left < window.innerWidth - 0.5 && b.width > 0;
  };
  // Settings: open, or still sliding away over the map (0.2 s) — the map
  // isn't back until it's gone
  if (shown("settings-sheet", true) || onScreen("settings-sheet") || document.getElementById("session-moved")) return true;
  return ["car-sheet", "nav-sheet", "lang-sheet"].some((id) => shown(id, false));
}
const NEAR_STEP = 0.5; // each step: half a zoom level wider (twice the ground)
const NEAR_STEP_MS = 300; // each step's zoom: quick, the steps read as one move
// what the search said stays true over time (owner, 2026-11-09): about where
// you are now, not where it once looked —
// you've moved this far from where it looked ("nobody nearby yet", or it
// found someone): looked again from here
const NEAR_MOVED_M = 500;
// a search waiting behind a drawer or a form: how often it looks (ms)
const NEAR_HIDDEN_MS = 250;
// the widest step worked out for a screen this much bigger on each side
// (px): the map's real view may be a pixel wider than measured
const NEAR_EDGE_PX = 2;
// (everyone it found gone from sight a while, the map as it left it: looked
// again — 5 s the first time, longer each time it keeps happening, with
// jitter: HoodNearby.researchWait, stillSeen)
// …and someone found in sight this long without a break: the back-off
// starts over (owner, 2026-11-09)
const NEAR_SETTLED_MS = 60000;
// …"without a break": the watch looks once a second — longer than this
// between two looks (a phone locked: its timers frozen; a laptop asleep),
// nobody was watching: the minute starts over
const NEAR_LOOK_GAP_MS = 3000;
let nearSeq = 0; // the search under way; a newer number ends an older one
let nearLooking = false; // looking (stepping out, waiting for answers) — what the tests watch (test_browser/findnearest*.mjs)
let nearOutward = false; // …and the search under way only steps OUT from where the map was (a look-again)
let nobodyNear = false; // looked: nobody — the banner says so

function mapSize() {
  const c = map.getContainer();
  return { w: c.clientWidth, h: c.clientHeight };
}

// the markers the map has DRAWN now, of the kind you're looking for (only
// what's drawn can be seen): where each is drawn, and how far it reaches
// each side — a group is wider, its "+N" badge pokes out of one corner
function peopleOnMap(type) {
  const drawn = (marker) => {
    const el = marker.getElement();
    if (!el.isConnected) return [];
    const at = marker.getLngLat();
    return [{ pos: { lat: at.lat, lng: at.lng }, half: lazyReach(el) }];
  };
  if (DEMO) {
    if (type === "driver") return drivers.filter((d) => d.visible).flatMap((d) => drawn(d.marker));
    return mockHand && mockHand.visible ? drawn(mockHand.marker) : [];
  }
  const out = [];
  pileMarkers.forEach((pm) => {
    if (pm.type === type) out.push(...drawn(pm.marker));
  });
  return out;
}
// its reach, measured only when asked for (once): the rule asks only for a
// marker whose middle is on the screen — a crowd far off costs nothing
function lazyReach(el) {
  let m = null;
  const get = (k, xy) => {
    m = m || markerReach(el);
    return m[k] ?? m[xy];
  };
  // (["t"]: written so, a plain t() reads as the translation helper)
  return {
    get l() { return get("l", "x"); },
    get r() { return get("r", "x"); },
    get ["t"]() { return get("t", "y"); },
    get b() { return get("b", "y"); },
  };
}
// a drawn marker's reach from its middle, each side, everything it draws
// included (HoodNearby.markerReach); not laid out: a single marker's
function markerReach(el) {
  const b = el.getBoundingClientRect();
  // (not laid out: nothing of it can be seen — never counts as in sight)
  if (!b.width || !b.height) return { x: NaN, y: NaN };
  return HoodNearby.markerReach(b, [...el.querySelectorAll("*")].map((k) => k.getBoundingClientRect()));
}

// while "nobody nearby yet" shows, looked at again once a second (nearbyArrived):
// a card or the chat closing, the banner shrinking, a drawer closing, can
// show someone who was there all along
let nobodyCheck = null;
let nearAt = null; // where the search looked from
let nobodyAt = null; // …when it said "nobody nearby yet"
// now, on both clocks: the steady one (stops while a phone sleeps) and the
// wall one (can be set back) — time passed is whichever says more
const clocks = () => ({ p: performance.now(), d: Date.now() });
let foundWatch = null; // { type, goneAt, seenAt, lookedAt, wait }: it found someone; watched while the map stays as it left it
let foundCheck = null;
let goodSeen = false; // a good reading came at least once (state.me is real)
let researches = 0; // looked again (everyone found gone) this many times running
// [0, 1): the jitter's random (a test can pin it)
let nearRand = () => Math.random();
// what "nobody nearby yet" is about: cars or ✋ (a reload can change what
// you look for without ending the search's line — then it clears)
let nobodyType = null;
function setNobodyNear(on) {
  if (nobodyNear === on) return;
  nobodyNear = on;
  nobodyType = on ? HoodNearby.lookingFor(state) : null;
  nobodyAt = on ? nearAt : null;
  clearInterval(nobodyCheck);
  nobodyCheck = on ? setInterval(nearbyArrived, 1000) : null;
  if (!bannerTimer) setBanner(contextBanner());
}

// over: a newer search, a move of the map's, ✋ down, offline
function stopFindNearest() {
  nearSeq++;
  nearLooking = false;
  foundWatch = null;
  clearInterval(foundCheck);
  foundCheck = null;
  setNobodyNear(false);
}

// where to look again from: where you are, if a good reading says so —
// else where the search last looked (never the placeholder the app starts
// with before any good reading: that's nowhere near you)
const nearFrom = () => (goodSeen ? state.me : nearAt);

// you've moved on (a driver driving) since the search answered — "nobody
// nearby yet", or it found someone — or while it's still looking (its
// first, rough reading far off a good one): looked again from where you
// are now (it was about the place it looked from). After an answer, from
// the zoom the map is at, outward — never zooming in by itself (owner,
// 2026-11-10: a driver's map doesn't jump in and out every 500 m); a new
// place: the back-off afresh. Still looking: it starts again as it was
// asked — a fresh search (your tap) from the start, a look-again outward.
function nearbyMoved(pos) {
  const from = nobodyNear ? nobodyAt : foundWatch || nearLooking ? nearAt : null;
  if (!from) return;
  if (HoodNearby.metersBetween(from, pos) <= NEAR_MOVED_M) return;
  if (nearLooking && !nearOutward) return findNearest(pos);
  researches = 0;
  findNearest(pos, { outFrom: map.getZoom() });
}

// a part of the map under a panel you opened (the chat, a card, a group's
// list): what's under it isn't "gone" — the watch's count starts over
function panelOpen() {
  return ["chat", "peer-card", "pile-sheet"].some((id) => { const el = document.getElementById(id); return !!el && !el.classList.contains("hidden"); });
}

// the search found someone: while the map stays as it left it, everyone it
// could find gone from sight a while (researchWait — they went offline, drove
// off) — it looks again. Any move of yours ends the watch (stopFindNearest).
// Someone found in sight a whole minute without a break: the back-off
// starts over (NEAR_SETTLED_MS).
function stillSeen() {
  if (!foundWatch || nearLooking) return;
  // the rule itself: HoodNearby.watchLook (pure; test_js/foundwatch). Here:
  // what the page says, each asked only when needed — in the background
  // nothing of the page is measured (battery)
  const role = foundWatch.type === "driver" ? "viewer" : "driver";
  const r = HoodNearby.watchLook(
    foundWatch,
    researches,
    clocks(),
    {
      gapMs: NEAR_LOOK_GAP_MS,
      settledMs: NEAR_SETTLED_MS,
      stop: () => HoodNearby.lookingFor(state) !== foundWatch.type,
      hidden: () => document.hidden,
      covered: () => mapOutOfSight() || panelOpen(),
      // a view the server refused for good: never answered — the watch ends
      refused: () => !DEMO && worldSync.refused(),
      // the server answered (its regular resync, a reconnect), as the role
      // you look as, and its answer drawn: else this look is skipped
      ready: () => DEMO || (worldSync.settled() && serverRole === role && !renderMarkersSoon.pending()),
      // a message up over the top of the map: what's under it isn't "gone"
      message: () => !!bannerTimer,
      inSight: () => {
        const size = mapSize();
        const covers = nearCovers();
        return peopleOnMap(foundWatch.type).some((p) => HoodNearby.inSight(map.project([p.pos.lng, p.pos.lat]), p.half || NEAR_HALF, size, covers));
      },
    },
    nearRand
  );
  foundWatch = r.w;
  if (r.act === "stop") return stopFindNearest();
  if (r.act === "relook") {
    // from the zoom the map is at, outward: never zooming back in
    findNearest(nearFrom(), { outFrom: map.getZoom() });
  }
  researches = r.researches;
}

// the page hidden (another app, the screen off): noted AT ONCE — the watch's
// timer may not run at all in the background, so it can't notice by itself;
// back, someone already gone has their wait start over (HoodNearby.watchLook)
document.addEventListener("visibilitychange", () => {
  if (document.hidden && foundWatch) foundWatch.away = true;
});

// watched from now: everyone of `type` gone from sight a while — looked again
function watchFound(type) {
  foundWatch = { type, goneAt: null, seenAt: null, lookedAt: null, wait: HoodNearby.researchWait(researches, nearRand()) };
  clearInterval(foundCheck);
  foundCheck = setInterval(watchLook, 1000);
}

// the watch's once-a-second look: anything thrown ends it cleanly (never
// the same failure once a second for ever)
function watchLook() {
  try {
    stillSeen();
  } catch (e) {
    stopFindNearest();
    console.error("find the nearest (watch):", e);
    reportError(e, "search");
  }
}

// any move of the map but the search's own (a drag, a pinch, a zoom of
// yours — or the app's own moves, a resize): the search and its watch end,
// and the next time starts afresh (no back-off carried over)
function movedByHand() {
  researches = 0;
  stopFindNearest();
}

// `outFrom`: looking again from the zoom the map is at — only its steps
// that wide or wider (a found watch's look again: never zooming back in);
// any other search starts the back-off afresh
function findNearest(at, { outFrom = null } = {}) {
  stopFindNearest();
  if (outFrom === null) researches = 0;
  nearOutward = outFrom !== null;
  const type = HoodNearby.lookingFor(state);
  if (!type || !map) return;
  const seq = nearSeq;
  nearAt = at;
  const size = mapSize();
  // (the zooms are worked out for a screen NEAR_EDGE_PX bigger each side:
  // the map's real view can be a pixel wider than the whole-pixel size —
  // at the first and the widest step it must still show people one by
  // one, never tip over into counts)
  const ladder = { viewport: HoodViewport, h3, center: at, size: { w: size.w + 2 * NEAR_EDGE_PX, h: size.h + 2 * NEAR_EDGE_PX }, rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS };
  // the usual view — or, on a screen so big it shows counts there (a
  // 2560×1440 monitor), the first zoom closer in that shows people one by one
  const startZoom = HoodNearby.markerStartZoom({ ...ladder, maxZoom: INTENT_ZOOM });
  // a screen that can't show people one by one at any zoom (counts even
  // fully in — an 8K monitor at 100%): no search, nothing said — the map
  // still comes to you (as closer in as it goes)
  // (a look-again — not a tap — never closer in than the map is: owner,
  // 2026-11-10, only a tap gives a close-up)
  if (!HoodNearby.showsMarkers(HoodViewport, h3, HoodNearby.screenAt(at, startZoom, ladder.size), ladder.rungs, ladder.budget)) {
    map.easeTo({ center: [at.lng, at.lat], zoom: outFrom === null ? startZoom : Math.min(startZoom, map.getZoom()) });
    return;
  }
  const widestZoom = HoodNearby.widestMarkerZoom({ ...ladder, maxZoom: startZoom });
  const all = HoodNearby.zoomSteps(startZoom, widestZoom, NEAR_STEP);
  const steps = outFrom === null ? all : HoodNearby.stepsFrom(all, outFrom);
  // a look-again from wider than the widest step: nowhere further out to
  // go — it ends quietly where the map is (never zooming in to look)
  if (!steps.length) return;
  // the screen and what covers it, measured now (a banner may have grown,
  // the phone turned, the address bar slid)
  const anyone = (zoom) => HoodNearby.anyoneAt({ me: at, people: peopleOnMap(type), size: mapSize(), covers: nearCovers(), zoom, half: NEAR_HALF });
  // the camera's own moves carry the search's number (the movestart
  // listener: any other move ends the search)
  const camera = (zoom) => map.easeTo({ center: [at.lng, at.lat], zoom, duration: NEAR_STEP_MS }, { nearSearch: seq });
  // the server has answered for the view the map watches once it stopped
  // moving, as the role you're looking as (an online driver: ✋)
  const role = type === "driver" ? "viewer" : "driver";
  // — and its answer DRAWN (the markers are drawn on the next frame: only
  // what's drawn counts)
  const answered = () => DEMO || (worldSync.settled() && serverRole === role && !renderMarkersSoon.pending());
  let i = 0;
  nearLooking = true;
  // (its first move too: anything thrown — the search ends cleanly)
  try {
    camera(steps[0]);
  } catch (e) {
    stopFindNearest();
    console.error("find the nearest:", e);
    reportError(e, "search");
    return;
  }
  // anything thrown in a look (a marker gone mid-measure…): the search ends
  // cleanly — never left "looking" for ever
  const check = () => {
    try {
      look();
    } catch (e) {
      if (seq === nearSeq) stopFindNearest();
      console.error("find the nearest:", e);
      reportError(e, "search");
    }
  };
  const look = () => {
    if (seq !== nearSeq) return;
    // the screen changed size (turned, a window resized) mid-search: its
    // steps were worked out for the old size — it ends, as the map's own
    // resize ends it when the map is still (a "move" not its own)
    const now = mapSize();
    if (now.w !== size.w || now.h !== size.h) return stopFindNearest();
    // stopped looking meanwhile: ✋ down and going offline end the search
    // themselves (a newer nearSeq) — a ride starting or ending, a request,
    // switching between rider and driver don't: this does
    if (HoodNearby.lookingFor(state) !== type) return stopFindNearest();
    // a view the server refused for good is never answered
    if (!DEMO && worldSync.refused()) return stopFindNearest();
    // a drawer or a form over the whole map (Settings, the car form…): the
    // search waits, where it is, until the map is back in sight — nobody
    // behind it can be seen (owner, 2026-11-09)
    // (behind a drawer or a form: looked at 4 times a second, not 10 —
    // battery; it carries on within a quarter second of the map's return)
    if (mapOutOfSight()) return setTimeout(check, NEAR_HIDDEN_MS);
    if (map.isMoving() || !answered()) return setTimeout(check, 100);
    if (anyone(steps[i])) {
      nearLooking = false;
      return watchFound(type);
    }
    // the map showing counts here, not people one by one (it tipped over
    // anyway): nobody can be told from counts — it ends there, saying
    // nothing (never "nobody nearby yet" over counts that show people)
    if (!DEMO && worldSync.wantedAggSize() > 0 && worldSync.wantedGeoSize() === 0) {
      nearLooking = false;
      return;
    }
    if (i === steps.length - 1) {
      nearLooking = false;
      return setNobodyNear(true);
    }
    camera(steps[++i]);
    setTimeout(check, 100);
  };
  setTimeout(check, 100);
}

// "nobody nearby yet" holds until someone comes into sight (the map stays
// where it is) — then they're watched as a find is; coming back to the app
// after a while is no different (owner, 2026-11-10: the map never zooms in
// by itself — only your tap gives a fresh close-up). (It looks again by
// itself when you've moved 500 m — nearbyMoved.)
// It checks less than the watch does (no waiting for the server, the
// drawing, the background or a message): it only ever CLEARS the line, and
// only for someone drawn in sight — were that marker stale, the watch that
// starts then corrects it.
function nearbyArrived() {
  if (!nobodyNear) return;
  // (what you look for changed — a ride, offline, the other mode: the line
  // is over, cleared even in the background: nothing stale kept)
  const type = HoodNearby.lookingFor(state);
  if (!type || type !== nobodyType) return setNobodyNear(false);
  // (the app in the background: nobody's looking — battery; once shown,
  // looked at again within a second)
  if (document.hidden) return;
  // (the map out of sight — a drawer, a form: nobody's seen; once a second
  // it's looked at again)
  if (mapOutOfSight()) return;
  // in sight as the search itself counts (HoodNearby.inSight, the same
  // boxes): someone under the banner never cleared the line (owner,
  // 2026-11-08)
  const size = mapSize();
  const covers = nearCovers();
  const clear = (p) => HoodNearby.inSight(map.project([p.pos.lng, p.pos.lat]), p.half || NEAR_HALF, size, covers);
  if (!peopleOnMap(type).some(clear)) return;
  setNobodyNear(false);
  // someone came into sight: watched as a find is (gone again a while —
  // looked again)
  watchFound(type);
}

function setHand(up) {
  // not live: refused — the message after the step that called this (a GPS
  // reading completes a waiting tap, then redraws the banner: locator.js)
  if (up && !DEMO && !liveNow()) {
    refreshControls();
    queueMicrotask(() => transientBanner(CANT_REACH()));
    return;
  }
  state.handRaised = up;

  if (!DEMO) pushHand(state.handRaised);

  if (state.handRaised) {
    // the hand goes up at YOUR location, wherever the map was panned — the
    // camera comes to you there and finds the nearest car (findNearest)
    findNearest(state.me);
    setBanner(contextBanner());
    if (DEMO) {
      handPingTimer = setTimeout(() => {
        if (!state.handRaised || state.ride) return;
        let nearest = drivers[0];
        drivers.forEach((d) => {
          if (metersBetween(state.me, d.pos) < metersBetween(state.me, nearest.pos)) nearest = d;
        });
        // a message, like the real app: a banner and the unread count — no
        // card popping open (only a tap on a marker opens one)
        receiveMsg(nearest, t("yo, saw your hand ✋ need a pickup?"));
      }, 6000);
    }
  } else {
    clearTimeout(handPingTimer);
    stopFindNearest();
    if (DEMO && !state.ride) {
      // chats stay, as in the real app (lowering a hand deletes none) — this
      // once deleted the last chat opened, closed or not (2026-11-01)
      state.chatPeer = null;
      $("peer-card").classList.add("hidden");
      closeChat();
    }
    setBanner(contextBanner());
  }
  refreshControls();
}

// ===== Driver online/offline =====
$("btn-online").addEventListener("click", () => {
  // the tap is the intent: online now with a good live reading, otherwise
  // on the first good one — a car must be in its block (a second tap
  // cancels the wait; going off never waits)
  if (DEMO) setOnline(!state.online);
  else if (!liveNow() && !loc.pending.online) transientBanner(CANT_REACH());
  else if (state.online || loc.pending.online) locTap("online"); // off, or cancel the wait
  else goOnlineWithCar();
});

// going online needs a car riders can look for (ARCHITECTURE.md "Your
// car"). Usually already known (read when you became a driver), so the tap
// goes straight on; otherwise asked once.
async function goOnlineWithCar() {
  if (state.myCar === undefined && !(await loadMyCar()))
    return transientBanner(t("Couldn't reach Hood Ride — try again"));
  if (!state.myCar) return openCarSheet({ goOnline: true });
  locTap("online");
}

function setOnline(on) {
  // not live: refused — the message after the step that called this (a GPS
  // reading completes a waiting tap, then redraws the banner: locator.js)
  if (on && !DEMO && !liveNow()) {
    refreshControls();
    queueMicrotask(() => transientBanner(CANT_REACH()));
    return;
  }
  state.online = on;
  if (state.online) {
    setBanner(contextBanner());
    requestWakeLock();
    // going on duty: centred on you, and the nearest ✋ found (findNearest
    // — the same as Need a ride's)
    findNearest(state.me);
    if (DEMO) {
      scheduleDemand();
      scheduleIncomingRequest();
    } else {
      lastGeoSent = null; // going online always announces immediately
      tapNews();
      pushDriverUpdate();
    }
  } else {
    stopFindNearest();
    setBanner(null);
    // offline = unavailable: no dangling card to message/accept ghosts through
    closeMapOverlays();
    if (DEMO) {
      clearTimeout(demandTimer);
      clearTimeout(requestTimer);
      if (mockHand) {
        chats.delete(mockHand);
        mockHand.marker.remove();
        mockHand = null;
      }
      chats.forEach((_c, p) => {
        if (p.kind === "rider" && p.pending) chats.delete(p);
      });
      if (state.chatPeer && !chats.has(state.chatPeer)) {
        state.chatPeer = null;
        closeChat();
      }
    } else {
      pushDriverOffline();
    }
  }
  // an offline driver watches nothing; on duty, the area comes back
  syncGeoSubscriptions();
  refreshControls();
  refreshWorldMarkers();
}

// MOCK: a ✋ appears on the map near you
// The demo's ✋ when you go online (owner, 2026-11-02): at once, as the real
// app shows hands already waiting the moment you're online — and without
// the "Someone nearby needs a ride" banner, which the real app doesn't have.
// Kept as settings, to bring either back: 5000 was the old wait.
const DEMO_HAND_DELAY_MS = 0;
const DEMO_HAND_BANNER = false;

function scheduleDemand() {
  clearTimeout(demandTimer);
  demandTimer = setTimeout(() => {
    if (!state.online || state.mode !== "driver" || state.ride || mockHand) return;
    const angle = Math.random() * Math.PI * 2;
    const dist = 400 + Math.random() * 600;
    const exactPos = offsetPos(state.me, Math.cos(angle) * dist, Math.sin(angle) * dist);
    // the REAL fuzzing pipeline, same as production: exact spot → display cell →
    // the hand is shown at the cell centroid; exact reveals only on accept
    const [cLat, cLng] = h3.cellToLatLng(
      h3.latLngToCell(exactPos.lat, exactPos.lng, H3_DISPLAY_RES)
    );
    mockHand = {
      ...HAND_RIDER,
      kind: "rider",
      pos: { lat: cLat, lng: cLng },
      exactPos,
      photo: HoodAvatar.url(HAND_RIDER.name),
      visible: false,
    };
    mockHand.marker = makeBubbleMarker("✋", () => openPeerCard(mockHand), "hand");
    refreshWorldMarkers();
    if (DEMO_HAND_BANNER) transientBanner(t("✋ Someone nearby needs a ride"));
  }, DEMO_HAND_DELAY_MS);
}

// MOCK: a rider messages you directly with a request
function scheduleIncomingRequest() {
  clearTimeout(requestTimer);
  requestTimer = setTimeout(() => {
    if (!state.online || state.mode !== "driver" || state.ride) return;
    if ([...chats.keys()].some((p) => p.kind === "rider" && p.pending)) return;
    const existing = [...chats.keys()].find(
      (p) => p.kind === "rider" && p.name === REQUEST_RIDER.name
    );
    if (existing) {
      existing.pending = true;
      receiveMsg(existing, t("you sure? still stuck out here 🙏"));
      return;
    }
    const angle = Math.random() * Math.PI * 2;
    const dist = 500 + Math.random() * 800;
    const rider = {
      ...REQUEST_RIDER,
      kind: "rider",
      pending: true,
      pos: offsetPos(state.me, Math.cos(angle) * dist, Math.sin(angle) * dist),
      photo: HoodAvatar.url(REQUEST_RIDER.name),
      visible: false,
    };
    receiveMsg(rider, t("hey! I'm at the laundromat on 3rd, can you grab me? 🙏"));
  }, 14000);
}

// ===== Navigate (driver) =====
// a real link: this fills in where and how, then the browser follows it as
// the driver's own tap — on a phone the Google Maps app takes it, with no
// blank tab left behind (HoodNavLink)
$("btn-navigate").addEventListener("click", (e) => {
  const link = e.currentTarget;
  // the pin or the rider's EXACT position — never their block centre
  // (owner, 2026-11-02: it went there when tapped too early)
  const target = state.ride && HoodRidePos.navTarget(state.ride.peer);
  if (!target) {
    e.preventDefault();
    if (state.ride)
      transientBanner(
        t("🧭 Waiting for {name}'s exact location — or ask them to set a 📍 meeting spot", { name: state.ride.peer.name })
      );
    return;
  }
  const app = HoodNavLink.chosen(storageOrNull(), PLATFORM);
  // no map app chosen yet on this phone: ask (each choice is the link)
  if (!app) {
    e.preventDefault();
    if (HoodNavLink.href(target)) openNavSheet(target);
    return;
  }
  const url = HoodNavLink.href(target, app, navigator.userAgent);
  if (!url) return e.preventDefault();
  // heading to a position the partner's phone stopped updating: say so
  const seen = !state.ride.peer.pin && HoodRidePos.lastSeenThere(partnerAgeMs(), state.ride.peer.name);
  if (seen) transientBanner(seen);
  link.href = url;
  link.target = HoodNavLink.target(PLATFORM);
});

// ----- which map app (owner, 2026-11-02): asked at the first Navigate,
// changed from Settings. `target`: where Navigate goes — the choices are real
// links there (the phone's app takes the tap); none: just choosing -----
let navSheetOpener = null;
// From Settings it opens OVER the drawer, which stays (owner, 2026-11-13: as
// the language list does); from Navigate (a ride) Settings isn't open
function openNavSheet(target = null) {
  const offered = HoodNavLink.choices(PLATFORM);
  document.querySelectorAll(".nav-choice").forEach((a) => {
    const app = a.dataset.app;
    a.classList.toggle("hidden", !offered.includes(app));
    a.href = (target && HoodNavLink.href(target, app, navigator.userAgent)) || "#";
    a.target = target ? HoodNavLink.target(PLATFORM) : "_self";
  });
  $("nav-sheet").dataset.going = target ? "1" : "";
  navSheetOpener = target ? $("btn-navigate") : $("btn-navapp");
  $("nav-backdrop").classList.remove("hidden");
  $("nav-sheet").classList.remove("hidden");
  $("nav-title").focus();
}

function closeNavSheet(e) {
  $("nav-sheet").classList.add("hidden");
  $("nav-backdrop").classList.add("hidden");
  returnFocus(navSheetOpener, e);
}

document.querySelectorAll(".nav-choice").forEach((a) =>
  a.addEventListener("click", (e) => {
    HoodNavLink.choose(storageOrNull(), a.dataset.app);
    // from Settings: only the choice; from Navigate: the link goes on
    if (!$("nav-sheet").dataset.going) e.preventDefault();
    closeNavSheet(e);
    renderNavAppNote();
  })
);
$("nav-cancel").addEventListener("click", closeNavSheet);
$("nav-backdrop").addEventListener("click", closeNavSheet);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("nav-sheet").classList.contains("hidden")) closeNavSheet(e);
});
$("btn-navapp").addEventListener("click", () => openNavSheet());

function renderNavAppNote() {
  const app = HoodNavLink.chosen(storageOrNull(), PLATFORM);
  $("navapp-note").textContent = app ? HoodNavLink.label(app) : t("Asked the first time you navigate");
}

// ===== The language (owner, 2026-11-05) =====
// the languages switched on, from the server's page (HoodrideWeb.Lang):
// one alone — no switch at all
const LANGS = (document.querySelector('meta[name="hoodride-languages"]')?.content || "en").split(",").filter(Boolean);
const LANG_NOW = HoodI18n.lang();
let langOpener = null;

function renderLangSwitch() {
  const many = LANGS.length > 1;
  const own = HoodLang.name(LANG_NOW);
  $("btn-lang-login").classList.toggle("hidden", !many);
  $("btn-lang").classList.toggle("hidden", !many);
  $("btn-lang-login").querySelector(".lang-current").textContent = own;
  $("lang-note").textContent = own;
}

// the list for what's typed in the search (nothing: every language): the
// closest matches first — own, English, this page's and other names
function renderLangList() {
  const list = $("lang-list");
  const found = HoodLang.search(LANGS, $("lang-search").value, LANG_NOW);
  $("lang-none").classList.toggle("hidden", found.length > 0);
  $("lang-clear").classList.toggle("hidden", $("lang-search").value === "");
  list.classList.toggle("hidden", found.length === 0);
  list.scrollTop = 0;
  list.replaceChildren(
    ...found.map(({ tag, name }) => {
      const b = document.createElement("button");
      b.type = "button";
      // each name in its own language and direction (a screen reader says
      // it right; Arabic reads right to left in an English list) — on the
      // name, not the row: the rows line up with the page (on an Arabic
      // page, English on the right too, as Arabic phones list them)
      const n = document.createElement("span");
      n.textContent = name;
      n.lang = tag;
      n.dir = "auto";
      b.append(n);
      b.lang = tag;
      if (tag === LANG_NOW) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => pickLang(tag));
      return b;
    })
  );
}

function openLangSheet(from) {
  langOpener = from;
  $("lang-search").value = "";
  renderLangList();
  $("lang-backdrop").classList.remove("hidden");
  $("lang-sheet").classList.remove("hidden");
  // the title, not the search: a phone's keyboard stays down, the list in
  // full view (tap the search to type)
  $("lang-title").focus({ focusVisible: false });
  // the current language in view, in the middle, languages either side
  // (W3C: the selected option shown on opening; centred, as pickers do) —
  // the list alone scrolls (scrollIntoView would move the sheet too)
  const list = $("lang-list");
  const now = list.querySelector('[aria-current="true"]');
  if (now) list.scrollTop = now.offsetTop - list.offsetTop - (list.clientHeight - now.offsetHeight) / 2;
}

function closeLangSheet() {
  $("lang-backdrop").classList.add("hidden");
  $("lang-sheet").classList.add("hidden");
  if (langOpener) langOpener.focus({ focusVisible: false });
  langOpener = null;
}

// kept (a cookie the server reads) only once someone picks; the page comes
// back in it — every word, the direction, the legal pages
function pickLang(tag) {
  if (tag === LANG_NOW) return closeLangSheet();
  document.cookie = HoodLang.cookie(tag, location.protocol === "https:");
  // each language has its own address (English /, Japanese /ja — the
  // server's PageController.address): go to it, the query kept (?demo=1);
  // the cookie makes / remember the choice
  location.assign(HoodLang.home(tag) + location.search);
}

$("btn-lang-login").addEventListener("click", () => openLangSheet($("btn-lang-login")));
$("btn-lang").addEventListener("click", () => openLangSheet($("btn-lang")));
$("lang-cancel").addEventListener("click", closeLangSheet);
$("lang-search").addEventListener("input", renderLangList);
// × : the field empty, every language back, the cursor still in the field
// (type again straight away — Equinor's search)
$("lang-clear").addEventListener("click", () => {
  $("lang-search").value = "";
  renderLangList();
  $("lang-search").focus();
});
// the keyboard's Search key: the keyboard goes down, the matches stay
$("lang-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.target.blur();
  }
});
$("lang-backdrop").addEventListener("click", closeLangSheet);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("lang-sheet").classList.contains("hidden")) closeLangSheet();
});
renderLangSwitch();

// ===== I'm here (driver) =====
$("btn-arrived").addEventListener("click", declareArrived);

// ===== Locate =====
$("btn-locate").addEventListener("click", () => {
  if (DEMO) return centreOnYou(state.me);
  // centre on where you are now (with none yet, the reading centres the map
  // when it arrives). Looking for someone: from your last GOOD reading if
  // there was one — never a rough one after it (indoors: the search would
  // look from kilometres off). Looking for nobody: where your blue dot is
  // (the latest reading) — the map always shows the dot
  if (loc.tapLocate()) centreOnYou(HoodNearby.lookingFor(state) && goodSeen ? state.me : loc.best);
});

// online or ✋ up: the nearest found too (findNearest); else up close
function centreOnYou(at) {
  if (HoodNearby.lookingFor(state)) findNearest(at);
  else map.easeTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), 15, usualZoom(at)) });
}

// the usual view here (INTENT_ZOOM) — closer in on a screen so big it shows
// counts there (a 2560×1440 monitor): the first zoom that shows people one
// by one (owner, 2026-11-09)
function usualZoom(at) {
  return HoodNearby.markerStartZoom({ viewport: HoodViewport, h3, center: at, size: mapSize(), rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS, maxZoom: INTENT_ZOOM });
}

// ===== Chat button =====
$("btn-chat").addEventListener("click", () => {
  // in a ride, your partner IS the chat — the list stays one ← behind
  if (state.ride) openChat(state.ride.peer);
  else if (chats.size > 1) openChatList();
  else if (chats.size === 1) openChat([...chats.keys()][0]);
});

// ===== Mode toggle =====
$("btn-mode").addEventListener("click", () => {
  if (state.ride) return;
  // ✋ up or online: switching takes you off the map, which needs the server
  if (!DEMO && (state.handRaised || state.online) && !liveNow()) return transientBanner(CANT_REACH());
  state.mode = state.mode === "rider" ? "driver" : "rider";
  HoodModeStore.save(storageOrNull(), DEMO ? "demo" : state.realUser.id, state.mode);
  // a driver now: know the car before Go online is tapped
  if (!DEMO && state.mode === "driver" && state.myCar === undefined) loadMyCar();
  state.handRaised = false;
  loc.cancelPending(); // a waiting tap belonged to the old mode
  clearTimeout(handPingTimer);
  if (!DEMO) {
    pushHand(false);
    if (state.online) pushDriverOffline();
    state.online = false;
    // conversations persist across mode flips in real mode — they're real people
  } else {
    state.online = false;
    clearTimeout(demandTimer);
    clearTimeout(requestTimer);
    if (mockHand) {
      mockHand.marker.remove();
      mockHand = null;
    }
    chats.clear();
    state.chatPeer = null;
    closeChat();
  }
  closeMapOverlays();
  setBanner(null);
  // a fresh rider watches cars; a fresh (offline) driver watches nothing
  syncGeoSubscriptions();
  refreshControls();
  refreshWorldMarkers();
});

// ===== Control visibility =====
function refreshControls() {
  // GPS runs exactly while something needs it (HoodSendFilter.gpsNeeded)
  if (!DEMO) loc.reconcile();
  // an open Settings sheet follows the ride (its sign-out row blocks in one)
  if (settingsOpen()) renderSettings();
  // End chat follows too: a message delivered (the chat now on the server),
  // a ride starting or ending with them
  if (!$("chat").classList.contains("hidden")) showEndChat(state.chatView === "list" ? null : state.chatPeer);
  // a ride or shift just finished: the next safe moment for a refresh
  tryGoogleRefresh();
  const rider = state.mode === "rider";
  const inRide = state.ride && ["connected", "arrived"].includes(state.ride.status);
  const requested = state.ride && state.ride.status === "requested";
  const chatOpen = !$("chat").classList.contains("hidden");

  setIconText($("btn-mode"), rider ? CAR + t("Drive") : t("🚶 Ride"));
  $("btn-mode").disabled = !!state.ride;

  toggle("btn-hand", rider && !inRide && !requested);
  $("btn-hand").classList.toggle("on", state.handRaised);
  // finding your location: the 📍 pulses (styles.css .searching)
  $("btn-hand").classList.toggle("searching", !!loc.pending.hand);
  setIconText($("btn-hand"), loc.pending.hand
    ? t("📍 Finding your location…") + "  ✕"
    : state.handRaised
      ? t("✋ Looking for a ride…") + "  ✕"
      : t("✋ Need a ride"));
  toggle("btn-pin", rider && inRide);
  $("btn-pin").classList.toggle("on", state.pinArmed);
  setIconText($("btn-pin"), state.pinPos ? t("📍 Move pin") : t("📍 Meet here"));

  toggle("btn-online", !rider && !inRide);
  setIconText($("btn-online"), loc.pending.online
    ? t("📍 Finding your location…") + "  ✕"
    : state.online
      ? t("GO OFFLINE")
      : t("GO ONLINE"));
  $("btn-online").classList.toggle("on", state.online);
  $("btn-online").classList.toggle("searching", !!loc.pending.online);
  // to the rider (or the pin) — gone once arrived: after "I'm here" it read
  // as "to the destination", which Hood Ride doesn't know
  toggle("btn-navigate", !rider && inRide && state.ride.status === "connected");
  toggle("btn-arrived", !rider && inRide && state.ride.status === "connected");

  const unread = [...chats.values()].reduce((s, c) => s + c.unread, 0);
  toggle("btn-chat", chats.size > 0 && !chatOpen);
  setIconText($("btn-chat"), unread ? t("💬 Chat ({count})", { count: unread }) : t("💬 Chat"));
  toggle("btn-endride", !!inRide || !!requested);
  $("btn-endride").textContent = requested ? t("Cancel request") : t("End ride");

  const msgView = chatOpen && state.chatView === "msgs" && state.chatPeer;
  toggle("chat-back", !!msgView && chats.size > 1);
  // in one chat: the unread messages in the OTHERS beside ‹ (owner,
  // 2026-11-05: iPhone Messages, Telegram) — mid-ride too, where others'
  // messages pop no banner; messages, like "💬 Chat (n)"; 99+ past 99
  const others = msgView
    ? [...chats.entries()].reduce((s, [p, c]) => (p === state.chatPeer ? s : s + c.unread), 0)
    : 0;
  $("chat-back-count").textContent = HoodChatList.unreadLabel(others);
  toggle("chat-back-count", others > 0);
  toggle("btn-decline", !!msgView && !rider && state.chatPeer.pending === true && !state.ride);
  const action = $("btn-ride-action");
  if (!msgView || inRide || (state.ride && !requested)) {
    action.classList.add("hidden");
  } else if (requested && state.ride.peer === state.chatPeer) {
    action.classList.remove("hidden");
    action.textContent = t("Requested…");
    action.disabled = true;
  } else if (!state.ride && (rider || (state.chatPeer.pending && state.online))) {
    action.classList.remove("hidden");
    action.textContent = rider ? t("Request ride") : t("Accept ride");
    action.disabled = false;
  } else {
    action.classList.add("hidden");
  }
  // a request/accept on its way: say so, unavailable but still focusable
  if (rideActionInFlight) {
    action.textContent = rideActionInFlight;
    action.setAttribute("aria-disabled", "true");
  } else {
    action.removeAttribute("aria-disabled");
  }
}

function toggle(id, on) {
  $(id).classList.toggle("hidden", !on);
}

// ===== Wake lock =====
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {}
}
document.addEventListener("visibilitychange", async () => {
  checkForUpdate(); // hidden now: maybe a silent reload; shown: maybe the offer
  if (document.visibilityState === "visible" && $("screen-map").classList.contains("active"))
    requestWakeLock();
  if (DEMO) return;
  if (document.visibilityState !== "visible") return loc.onHidden();
  await loc.onVisible(); // the reconcile then restarts what's needed
});

// back from the back/forward cache: the page didn't reload, so it may be old
window.addEventListener("pageshow", (e) => {
  if (e.persisted) checkForUpdate();
});

// ===== Boot =====
// Only a real "signed out" answer shows the sign-in buttons; a server that
// can't be reached (a deploy, a database hiccup, the rate limit, no signal)
// gets "retrying…" and the app's reconnect backoff (HoodBoot).
const booting = HoodBoot.create({
  fetchState: async () => {
    const res = await apiFetch("/api/state?chats=list");
    let body = null;
    try {
      body = await res.json();
    } catch (_) {}
    return { status: res.status, body, retryAfter: res.headers.get("Retry-After") };
  },
  onSignedIn: async (data) => {
    await startSignedIn(data);
    // a page load mid-shift or mid-ride: GPS starts at once (locator.js)
    if (!DEMO) loc.resumeAtLoad();
    // back from a refresh the server couldn't do (or refused): say so once
    // (the button is in the Change box), and take the answer out of the address
    const refreshNote = HoodGoogleRefresh.outcome(location.search);
    if (refreshNote) {
      transientBanner(refreshNote, 6000);
      history.replaceState(null, "", location.pathname + HoodGoogleRefresh.withoutOutcome(location.search));
    }
    // opening the app counts as being back (an iPhone home-screen app may
    // never report the return from Google's page)
    awayFromApp = true;
    tryGoogleRefresh();
  },
  onSignedOut: async () => {
    // signed out (here or from another device): no remembered map area left
    HoodViewStore.forgetAll(storageOrNull());
    HoodReadStore.forgetAll(storageOrNull());
    // …and the rest the Sign out button clears: the block, a refresh due
    forgetAllSpots(storageOrNull());
    HoodGoogleRefresh.forget(storageOrNull());
    // the sign-in really over (expired, signed out elsewhere): the page
    // started neutral for a signed-in visitor — now the sign-in screen, whole
    document.documentElement.classList.remove("resuming");
    $("boot-status").classList.add("hidden");
    $("auth-buttons").classList.remove("hidden");
    auth.signOut(); // signed out: clear any leftover of the old fake sign-in
    // (?demo=1 never gets here: it starts the pretend world without asking
    // the server — see the end of this file)
  },
  onWaiting: () => ($("boot-status").textContent = t("Can't reach Hood Ride — retrying…")),
  backoff: (attempt) => HoodSync.reconnectBackoff(attempt),
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (timer) => clearTimeout(timer),
  onError: (e) => {
    console.error("couldn't open the app", e);
    reportError(e, "start");
  },
});
// ?demo=1: the pretend world, whoever opens it — never the account, never
// the server (owner, 2026-11-07: signed in, the demo ALSO connected as you,
// and the server's first answer closed a card tapped right after load).
// "Leave demo" goes to the normal page, signed in as before.
if (DEMO) {
  enterApp();
} else {
  booting.start();
  // back online, or the app shown again: try at once instead of waiting
  window.addEventListener("online", () => booting.poke());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") booting.poke();
  });
}

if ("serviceWorker" in navigator) {
  // (a failed install — a flaky first visit, a private window — is let go:
  // nothing to do, and no "unhandled" error report: crash review 2026-11-14)
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
