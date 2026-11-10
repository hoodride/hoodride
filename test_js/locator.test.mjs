// Node tests for priv/static/locator.js — when location is asked for, when
// GPS runs, and what each reading and error does — against a fake GPS, a
// fake permission and a fake clock. These are the Chrome checks of the
// location build, made permanent.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const rules = require("../priv/static/sendfilter.js");
const { create, WATCH_OPTIONS } = require("../priv/static/locator.js");

const HERE = { lat: 40.7154, lng: -74.0086 };
const flush = () => new Promise((r) => setImmediate(r));

// a phone: GPS you can feed, a permission you can set, a clock you can move,
// and an app that records what it was told
function phone({ perm = "prompt", mode = "rider" } = {}) {
  const t = { now: 1_000_000, perm };
  const watches = new Map();
  const lookups = [];
  let nextId = 0;
  const geolocation = {
    watchPosition(ok, err, opts) {
      watches.set(++nextId, { ok, err, opts });
      return nextId;
    },
    clearWatch: (id) => watches.delete(id),
    getCurrentPosition: (ok, err, opts) => lookups.push({ ok, err, opts }),
  };
  const st = { mode, online: false, ride: null, handRaised: false, typing: false };
  const log = [];
  const app = {
    state: () => st,
    onReading: (pos, how) => log.push(["reading", pos, how]),
    onGood: (pos) => log.push(["good", pos]),
    onTrustLost: () => log.push(["trustLost"]),
    setOnline: (on) => {
      st.online = on;
      log.push(["setOnline", on]);
    },
    setHand: (up) => {
      st.handRaised = up;
      log.push(["setHand", up]);
    },
    message: (text) => log.push(["message", text]),
    redrawBanner: () => log.push(["redraw"]),
    refresh: () => log.push(["refresh"]),
    showShare: (text) => log.push(["share", text]),
    hideShare: () => log.push(["hideShare"]),
    reload: () => log.push(["reload"]),
    typing: () => st.typing,
  };
  const loc = create({
    geolocation,
    // "throws": a browser whose permission check fails
    queryPermission: async () => {
      if (t.perm === "throws") throw new TypeError("permissions.query is not supported");
      return t.perm;
    },
    now: () => t.now,
    h3,
    rules,
    platform: "android",
    standalone: false,
    app,
  });
  const reading = (accuracy, at = HERE) => ({ coords: { latitude: at.lat, longitude: at.lng, accuracy } });
  return {
    t,
    st,
    log,
    loc,
    watches,
    lookups,
    // feed every live watch a reading / an error
    fix: (accuracy, at) => [...watches.values()].forEach((w) => w.ok(reading(accuracy, at))),
    fail: (code) => [...watches.values()].forEach((w) => w.err({ code })),
    reading,
    did: (kind) => log.filter((e) => e[0] === kind),
    last: () => log.at(-1),
  };
}

test("opening the app asks nothing; a returning user who allowed it is centred quietly", async () => {
  const p = phone({ perm: "prompt" });
  await p.loc.start();
  assert.equal(p.watches.size + p.lookups.length, 0, "no prompt on open");
  const q = phone({ perm: "granted" });
  await q.loc.start();
  assert.equal(q.lookups.length, 1, "one quiet lookup");
  q.lookups[0].err({ code: 1 }); // e.g. blocked since: nobody tapped anything
  assert.equal(q.did("message").length, 0, "a quiet lookup never complains");
});

test("GO ONLINE waits for a GOOD reading: coarse ones only move the dot", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  assert.equal(p.loc.pending.online, true);
  assert.equal(p.watches.size, 1);
  assert.deepEqual([...p.watches.values()][0].opts, WATCH_OPTIONS);
  assert.equal(WATCH_OPTIONS.enableHighAccuracy, true);
  p.fix(5000);
  p.fix(600);
  assert.equal(p.did("reading").length, 2, "the dot moves");
  assert.equal(p.did("good").length, 0, "nothing trusted");
  assert.equal(p.st.online, false);
  p.fix(12);
  assert.equal(p.did("good").length, 1);
  assert.deepEqual(p.did("setOnline"), [["setOnline", true]], "online once");
  assert.equal(p.loc.pending.online, false);
});

test("the first reading shows the dot; ◎ before any reading centres when it arrives", () => {
  const p = phone();
  assert.equal(p.loc.tapLocate(), false, "nothing to centre on yet");
  assert.equal(p.lookups.length, 1);
  assert.equal(p.lookups[0].opts.enableHighAccuracy, false, "◎ needs no high accuracy");
  p.lookups[0].ok(p.reading(30));
  assert.deepEqual(p.did("reading")[0][2], { first: true, centre: true });
  assert.equal(p.loc.tapLocate(), true, "now it centres at once");
  p.lookups[1].ok(p.reading(30));
  assert.deepEqual(p.did("reading")[1][2], { first: false, centre: false });
});

test("a second tap cancels the wait, and GPS stops", async () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.loc.tapOnline();
  assert.equal(p.loc.pending.online, false);
  assert.equal(p.st.online, false);
  await p.loc.reconcile();
  assert.equal(p.watches.size, 0);
});

test("with a good LIVE reading the tap acts at once; a leftover reading doesn't count", async () => {
  const p = phone({ mode: "rider" });
  p.loc.tapHand();
  p.fix(10); // ✋ placed
  assert.equal(p.st.handRaised, true);
  await p.loc.reconcile(); // a placed ✋ needs no GPS
  assert.equal(p.watches.size, 0);
  assert.equal(p.loc.liveFix(), false, "that reading is from a stopped watch");
  p.st.mode = "driver";
  p.loc.tapOnline();
  assert.equal(p.st.online, false, "waits for a fresh reading");
  p.fix(10);
  assert.equal(p.st.online, true);
  assert.equal(p.loc.liveFix(), true);
  p.st.online = false;
  p.loc.tapOnline();
  assert.equal(p.st.online, true, "live reading: no wait");
  assert.equal(p.watches.size, 1, "and no second watch");
});

test("blocked while waiting: the wait is cancelled, GPS stops, the steps STAY on screen", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fail(1);
  assert.equal(p.loc.pending.online, false);
  assert.equal(p.watches.size, 0);
  assert.equal(p.loc.status, "denied");
  const i = p.log.findIndex((e) => e[0] === "message");
  assert.match(p.log[i][1], /blocked.*to drive/);
  assert.equal(p.log.slice(i).filter((e) => e[0] === "redraw").length, 0, "nothing drawn over it");
});

test("blocked mid-shift: trust revoked, GPS stops, and it doesn't restart by itself", async () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fix(10);
  p.fail(1);
  assert.equal(p.did("trustLost").length, 1);
  assert.equal(p.loc.liveFix(), false);
  assert.match(p.did("message")[0][1], /to drive/);
  p.t.perm = "denied";
  await p.loc.reconcile();
  assert.equal(p.watches.size, 0);
  assert.equal(p.did("message").length, 1, "said once");
  assert.match(p.loc.noFixBanner({ haveFix: false, mode: "driver", online: true }), /can't see you.*blocked/);
});

test("location off (2) while waiting: says so and keeps waiting; a signal later completes it", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fail(2);
  assert.match(p.did("message")[0][1], /Location is off/);
  assert.equal(p.loc.pending.online, true);
  assert.equal(p.watches.size, 1);
  p.fix(9);
  assert.equal(p.st.online, true);
  assert.equal(p.loc.status, "watching");
});

test("a timeout (3) is just 'not yet': no message, the watch keeps going", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fail(3);
  assert.equal(p.did("message").length, 0);
  assert.equal(p.watches.size, 1);
  assert.equal(p.loc.pending.online, true);
});

test("the waiting banner: Finding… at 5 s; at 15 s Precise steps — or 'allow it' if never answered", async () => {
  const p = phone({ mode: "driver", perm: "prompt" });
  p.loc.tapOnline();
  assert.equal(p.loc.banner(), "📍 Finding your location…");
  p.t.now += 16000;
  p.loc.tick();
  await flush();
  assert.match(p.loc.banner(), /Allow location when your browser asks/);
  p.t.perm = "granted";
  p.loc.tick();
  await flush();
  assert.match(p.loc.banner(), /Precise Location/);
  p.fix(4000);
  assert.match(p.loc.banner(), /only approximate/);
});

test("a ride needs GPS: allowed → starts by itself; not asked yet → the Share button; blocked → said once", async () => {
  const g = phone({ perm: "granted" });
  g.st.ride = { status: "connected" };
  await g.loc.reconcile();
  assert.equal(g.watches.size, 1);
  assert.equal(g.did("share").length, 0);

  const p = phone({ perm: "prompt" });
  p.st.ride = { status: "connected" };
  await p.loc.reconcile();
  assert.equal(p.watches.size, 0, "never prompts without a tap");
  assert.match(p.did("share")[0][1], /ride partner/);
  p.loc.shareTapped();
  assert.equal(p.watches.size, 1);
  assert.equal(p.did("hideShare").length, 1);

  const d = phone({ perm: "denied" });
  d.st.ride = { status: "connected" };
  await d.loc.reconcile();
  await d.loc.reconcile();
  assert.equal(d.watches.size, 0);
  assert.equal(d.did("message").length, 1);
  assert.match(d.did("message")[0][1], /ride partner can find you/);
});

test("blocked earlier (a ◎ tap), then a ride starts: the rider is told — once per ride", async () => {
  const p = phone({ perm: "denied" });
  p.loc.tapLocate();
  p.lookups[0].err({ code: 1 });
  assert.equal(p.did("message").length, 1);
  p.st.ride = { status: "connected" };
  await p.loc.reconcile();
  await p.loc.reconcile();
  assert.equal(p.did("message").length, 2, "said for the ride, once");
  assert.match(p.did("message")[1][1], /ride partner can find you/);
  p.st.ride = null;
  await p.loc.reconcile();
  p.st.ride = { status: "connected" }; // the next ride
  await p.loc.reconcile();
  assert.equal(p.did("message").length, 3, "and again for the next ride");
});

test("the ride ends while the permission is being checked: no GPS left running", async () => {
  const p = phone({ perm: "granted" });
  p.st.ride = { status: "connected" };
  const r = p.loc.reconcile();
  p.st.ride = null;
  await r;
  assert.equal(p.watches.size, 0);
});

test("the ride ends: GPS stops and the Share button goes", async () => {
  const p = phone({ perm: "granted" });
  p.st.ride = { status: "connected" };
  await p.loc.reconcile();
  p.st.ride = null;
  await p.loc.reconcile();
  assert.equal(p.watches.size, 0);
  assert.ok(p.did("hideShare").length >= 1);
});

test("Request ride: checks on the tap (never blocks), warns if approximate or blocked", () => {
  const p = phone();
  p.loc.requestCheck();
  assert.equal(p.lookups.length, 1);
  assert.equal(p.lookups[0].opts.enableHighAccuracy, true);
  p.lookups[0].ok(p.reading(4000));
  assert.match(p.did("message")[0][1], /approximate.*driver can find you/);
  p.loc.requestCheck();
  p.lookups[1].err({ code: 1 });
  assert.match(p.did("message")[1][1], /blocked.*driver can find you/);
});

test("◎ with a live watch reuses it; ◎ when blocked says so", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fix(10);
  p.loc.tapLocate();
  assert.equal(p.lookups.length, 0, "the live watch already knows");
  const q = phone();
  q.loc.tapLocate();
  q.lookups[0].err({ code: 1 });
  assert.match(q.did("message")[0][1], /blocked.*show where you are/);
});

test("location off (2) on a plain ◎ lookup that's already centred: no nagging", () => {
  const p = phone();
  p.loc.tapLocate();
  p.lookups[0].ok(p.reading(30));
  p.loc.tapLocate();
  p.lookups[1].err({ code: 2 });
  assert.equal(p.did("message").length, 0);
});

test("a tap after 'blocked' retries (the browser decides), and coming back allowed restarts quietly", async () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fail(1);
  p.loc.tapOnline();
  assert.equal(p.watches.size, 1, "the tap tries again");
  p.fail(1);
  p.st.online = true; // a resumed shift
  p.t.perm = "denied";
  await p.loc.onVisible();
  assert.equal(p.loc.status, "denied", "still blocked: nothing");
  p.t.perm = "granted";
  await p.loc.onVisible();
  assert.equal(p.loc.status, "idle");
  await p.loc.reconcile();
  assert.equal(p.watches.size, 1, "GPS back, no prompt needed");
});

test("switching mode cancels a waiting tap; logout stops GPS", async () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.loc.cancelPending();
  assert.equal(p.loc.pending.online, false);
  p.fix(10);
  assert.equal(p.did("setOnline").length, 0, "the old tap doesn't complete later");
  p.loc.stop();
  assert.equal(p.watches.size, 0);
});

// ── after "blocked": the browser keeps its "no" for the page that's open —
// allowing location in Settings only takes effect after a reload (owner's
// iPhone, Brave, 2026-10-29; Apple Community: "refreshing Safari and now
// geolocation is working"). So coming BACK after a "blocked" message
// reloads once, quietly — never while a message is half-typed.

async function blockedThenAway(p) {
  p.loc.tapHand();
  p.fail(1); // "blocked"
  assert.equal(p.loc.status, "denied");
  p.loc.onHidden(); // off to Settings
}

test("blocked → leave (to Settings) → come back: the page reloads once", async () => {
  const p = phone();
  await blockedThenAway(p);
  await p.loc.onVisible();
  assert.equal(p.did("reload").length, 1);
  await p.loc.onVisible(); // shown again without leaving: no second reload
  assert.equal(p.did("reload").length, 1);
});

test("never without leaving: a 'blocked' that's still on screen doesn't reload", async () => {
  const p = phone();
  p.loc.tapHand();
  p.fail(1);
  await p.loc.onVisible(); // e.g. a pageshow, no trip away
  assert.equal(p.did("reload").length, 0);
});

test("leaving and coming back when nothing was blocked: no reload", async () => {
  const p = phone({ perm: "granted" });
  p.loc.tapHand();
  p.fix(20);
  p.loc.onHidden();
  await p.loc.onVisible();
  assert.equal(p.did("reload").length, 0);
});

test("a half-typed message is never thrown away: no reload, the banner stays", async () => {
  const p = phone();
  await blockedThenAway(p);
  p.st.typing = true;
  await p.loc.onVisible();
  assert.equal(p.did("reload").length, 0);
  assert.equal(p.loc.status, "denied");
});

// ── a shift or ride ALREADY under way when the page loads (a refresh while
// online): GPS starts straight away — the browser's own question, if it
// has one, comes at once (owner, 2026-10-29: iPhones forget an "allow" on
// reload, and the driver had to find the Share button). Also the Share
// button, in case a browser holds the question for a tap. Anything that
// starts LATER (a ride the server starts) still asks only on a tap.

test("a shift under way at page load, not allowed yet: GPS starts AND the Share button shows", async () => {
  const p = phone({ perm: "prompt", mode: "driver" });
  p.st.online = true;
  await p.loc.resumeAtLoad();
  assert.equal(p.watches.size, 1, "started without a tap");
  assert.equal(p.did("share").length, 1, "the button too, in case the browser waits for a tap");
});

test("then a reading arrives: the button goes", async () => {
  const p = phone({ perm: "prompt", mode: "driver" });
  p.st.online = true;
  await p.loc.resumeAtLoad();
  p.fix(20);
  assert.ok(p.did("hideShare").length >= 1);
});

test("tapping the button asks again INSIDE the tap (a browser may have held the first ask)", async () => {
  const p = phone({ perm: "prompt", mode: "driver" });
  p.st.online = true;
  await p.loc.resumeAtLoad();
  const [first] = p.watches.keys();
  p.loc.shareTapped();
  assert.equal(p.watches.size, 1, "one watch");
  assert.notEqual([...p.watches.keys()][0], first, "a fresh one, from the tap");
});

test("a ride under way at page load: the same", async () => {
  const p = phone({ perm: "prompt" });
  p.st.ride = { status: "connected" };
  await p.loc.resumeAtLoad();
  assert.equal(p.watches.size, 1);
  assert.match(p.did("share")[0][1], /ride partner/);
});

test("nothing under way at page load: nothing starts, and a ride starting LATER still waits for a tap", async () => {
  const p = phone({ perm: "prompt" });
  await p.loc.resumeAtLoad();
  assert.equal(p.watches.size, 0);
  p.st.ride = { status: "connected" }; // the server starts it later
  await p.loc.reconcile();
  assert.equal(p.watches.size, 0, "never prompts without a tap");
  assert.equal(p.did("share").length, 1);
});

test("blocked at page load: no GPS, the steps said once", async () => {
  const p = phone({ perm: "denied", mode: "driver" });
  p.st.online = true;
  await p.loc.resumeAtLoad();
  assert.equal(p.watches.size, 0);
  assert.equal(p.did("message").length, 1);
});

test("the race at page load: a check already running when resumeAtLoad comes still resumes", async () => {
  const p = phone({ perm: "prompt", mode: "driver" });
  p.st.online = true;
  const running = p.loc.reconcile(); // hydrate's own check, waiting on the browser
  const resumed = p.loc.resumeAtLoad(); // finds it running: returns at once
  await Promise.all([running, resumed]);
  assert.equal(p.watches.size, 1, "the running check took the resume with it");
});

// owner, 2026-10-30: in a ride, the blocked banner AND the blue "Share your
// location" button showed together. A ride under way at page load asks at
// once and offers the button; the phone then said "blocked" — the banner
// came, the button stayed. Blocked: no tap can ask again, so the button
// goes; the banner's steps are the way out
test("blocked while the Share button is up: the button goes, the steps stay", async () => {
  const p = phone({ perm: "prompt" });
  p.st.ride = { status: "connected" };
  p.loc.resumeAtLoad();
  await flush();
  assert.equal(p.watches.size, 1, "a ride under way asks at once");
  assert.equal(p.did("share").length, 1, "…with the button, in case the phone wants a tap");
  p.fail(1);
  const shownAt = p.log.findIndex((e) => e[0] === "share");
  const hiddenAt = p.log.findIndex((e, i) => i > shownAt && e[0] === "hideShare");
  assert.ok(hiddenAt > shownAt, "the button hidden once blocked");
  assert.match(p.did("message").at(-1)[1], /blocked/i, "the blocked steps shown");
});

test("blocked from a tap (no button up): still no button", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  p.fail(1);
  const shares = p.did("share").length;
  assert.equal(shares, 0);
});

// the other way to the same screen: the button is up (location not decided,
// nothing asked yet), then location is blocked in Settings and the next
// re-check finds it — tellBlocked shows the steps; the button must go too
test("blocked found by a re-check while the Share button is up: the button goes", async () => {
  const p = phone({ perm: "prompt" });
  p.st.ride = { status: "connected" };
  await p.loc.reconcile();
  assert.equal(p.watches.size, 0, "nothing asked without a tap");
  assert.equal(p.did("share").length, 1, "the button is up");
  p.t.perm = "denied"; // set to Never in Settings
  await p.loc.reconcile();
  const shownAt = p.log.findIndex((e) => e[0] === "share");
  const hiddenAt = p.log.findIndex((e, i) => i > shownAt && e[0] === "hideShare");
  assert.ok(hiddenAt > shownAt, "the button hidden once blocked");
  assert.match(p.did("message").at(-1)[1], /blocked/i, "the blocked steps shown");
});


// ----- the gaps a mutation sweep found (Stryker, owner 2026-11-05): what
// happens after something goes wrong, and the banner's wording -----

test("a browser whose permission check fails: treated as 'unknown' — GPS still starts when needed", async () => {
  const p = phone({ perm: "throws" });
  await p.loc.start();
  assert.equal(p.lookups.length, 0, "not 'granted': no quiet lookup on open");
  p.st.mode = "driver";
  p.st.online = true;
  await p.loc.reconcile();
  assert.equal(p.watches.size, 1, "'unknown' → the watch starts (the browser decides)");
});

test("blocked, then a tap: the tap retries — GPS again, the banner says 'Finding…' (never 'blocked' again)", () => {
  const p = phone({ perm: "granted" });
  p.loc.tapHand();
  p.fail(1);
  assert.equal(p.loc.status, "denied");
  assert.equal(p.watches.size, 0);
  p.loc.tapHand();
  assert.equal(p.loc.status, "watching", "the tap retries");
  assert.equal(p.watches.size, 1);
  p.t.now += 6000;
  assert.match(p.loc.banner(), /Finding your location/);
});

test("location off, then a tap: retried the same way; while waiting, the banner says it's off", () => {
  const p = phone({ perm: "granted" });
  p.loc.tapOnline();
  p.fail(2);
  assert.equal(p.loc.status, "unavailable");
  const off = p.loc.banner();
  assert.match(off, /Location is off on this device/);
  assert.match(off, /to drive/);
  assert.doesNotMatch(off, /Finding/);
  p.loc.cancelPending();
  p.loc.tapOnline();
  assert.equal(p.loc.status, "watching", "the tap retries");
});

test("the waiting banner: none when nothing waits; GO ONLINE in driving words, ✋ in ride-request words", () => {
  const p = phone({ perm: "granted" });
  assert.equal(p.loc.banner(), null);
  p.loc.tapOnline();
  p.t.now += 16_000;
  assert.match(p.loc.banner(), /to drive/);
  p.loc.cancelPending();
  assert.equal(p.loc.banner(), null);
  p.loc.tapHand();
  p.t.now += 16_000;
  assert.match(p.loc.banner(), /to ask for a ride/);
});

test("turning off never waits for location: off at once, no GPS asked for", () => {
  const p = phone({ perm: "granted", mode: "driver" });
  p.st.online = true;
  p.loc.tapOnline();
  assert.deepEqual(p.did("setOnline"), [["setOnline", false]]);
  assert.equal(p.watches.size, 0);
  p.st.handRaised = true;
  p.loc.tapHand();
  assert.deepEqual(p.did("setHand"), [["setHand", false]]);
  assert.equal(p.watches.size, 0);
});

test("stopping: GPS released, back to idle, no live reading left", () => {
  const p = phone({ perm: "granted" });
  p.loc.tapOnline();
  p.fix(10);
  assert.ok(p.loc.liveFix());
  p.loc.stop();
  assert.equal(p.watches.size, 0, "clearWatch: the GPS is released");
  assert.equal(p.loc.status, "idle");
  assert.equal(p.loc.liveFix(), false, "an old reading isn't 'live' any more");
});

test("the app's tick redraws the banner only while a tap waits", () => {
  const p = phone({ perm: "granted" });
  p.loc.tick();
  assert.equal(p.did("redraw").length, 0);
  p.loc.tapHand();
  const before = p.did("redraw").length;
  p.loc.tick();
  assert.equal(p.did("redraw").length, before + 1);
});

test("back from Settings: allowed now → a quiet reset; still blocked → stays blocked", async () => {
  const p = phone({ perm: "granted" });
  p.loc.tapHand();
  p.fail(1);
  p.t.perm = "granted";
  await p.loc.onVisible();
  assert.equal(p.loc.status, "idle", "allowed: ready again, no prompt");
  assert.equal(p.last()[0], "refresh");
  const q = phone({ perm: "granted" });
  q.loc.tapHand();
  q.fail(1);
  q.t.perm = "denied";
  await q.loc.onVisible();
  assert.equal(q.loc.status, "denied", "still blocked: unchanged");
});

test("only approximate: Request ride warns at once; a plain ◎ doesn't nag", () => {
  const p = phone({ perm: "granted" });
  p.loc.requestCheck();
  p.lookups[0].ok(p.reading(3000));
  const warned = p.did("message").map((m) => m[1]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /approximate/);
  const q = phone({ perm: "granted" });
  q.loc.tapLocate();
  q.lookups[0].ok(q.reading(3000));
  assert.equal(q.did("message").length, 0);
});

test("every reading redraws the banner and refreshes the screen", () => {
  const p = phone({ perm: "granted" });
  p.loc.tapHand();
  p.log.length = 0;
  p.fix(500);
  assert.ok(p.did("redraw").length >= 1 && p.did("refresh").length >= 1, JSON.stringify(p.log.map((e) => e[0])));
});

// a ◎ tap that got no reading is over (owner, 2026-11-10): a reading coming
// later — ✋ up, going online, a watch — isn't its answer, and must never
// move the map back, maybe minutes on
test("◎ with no reading, then it times out or location is off: a later reading doesn't centre the map", () => {
  for (const code of [3, 2]) {
    const p = phone({ mode: "driver" });
    assert.equal(p.loc.tapLocate(), false);
    p.lookups[0].err({ code });
    p.loc.tapOnline();
    p.fix(12);
    assert.deepEqual(p.did("reading")[0][2], { first: true, centre: false }, `after error ${code}: not the tap's answer`);
  }
});

test("◎ with no reading, then you move the map yourself (cancelCentre): its reading doesn't move the map back", () => {
  const p = phone();
  assert.equal(p.loc.tapLocate(), false);
  p.loc.cancelCentre();
  p.lookups[0].ok(p.reading(30));
  assert.deepEqual(p.did("reading")[0][2], { first: true, centre: false });
  // …while untouched, it still does (the tap's own answer)
  const q = phone();
  q.loc.tapLocate();
  q.lookups[0].ok(q.reading(30));
  assert.deepEqual(q.did("reading")[0][2], { first: true, centre: true });
});

// only the ◎ tap's OWN request failing ends the tap: the live watch (on
// duty, indoors) timing out every 15 s meanwhile is not the tap failing —
// the tap's reading, when it comes, still centres the map
test("◎ waiting while the live watch times out: the tap still centres when its own reading comes", () => {
  const p = phone({ mode: "driver" });
  p.loc.tapOnline();
  assert.equal(p.watches.size, 1, "(the live watch on)");
  assert.equal(p.loc.tapLocate(), false, "(no reading yet: the tap waits)");
  [...p.watches.values()][0].err({ code: 3 });
  p.lookups[p.lookups.length - 1].ok(p.reading(30));
  assert.deepEqual(p.did("reading")[0][2], { first: true, centre: true }, "the watch's timeout didn't end the tap");
});
