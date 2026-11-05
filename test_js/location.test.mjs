// Node tests for the location rules in priv/static/sendfilter.js — the
// web.dev "User Location" checklist plus one rule of ours: only a reading
// good enough to place you in a block (its error ≤ one block's edge) may
// place your car or ✋ or go to your ride partner.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const F = require("../priv/static/sendfilter.js");

const EDGE = h3.getHexagonEdgeLengthAvg(9, "m"); // ~201 m

test("a reading is good only if its error fits in one block", () => {
  assert.equal(F.readingQuality(0, h3), "good");
  assert.equal(F.readingQuality(8, h3), "good"); // GPS outdoors
  assert.equal(F.readingQuality(EDGE, h3), "good"); // exactly one block
  assert.equal(F.readingQuality(EDGE + 1, h3), "poor"); // warming up / indoors
  assert.equal(F.readingQuality(999, h3), "poor");
  // Android "approximate" ≈ 3 km² (≈ 1 km radius); iPhone 3–9 km
  assert.equal(F.readingQuality(1000, h3), "approximate");
  assert.equal(F.readingQuality(5000, h3), "approximate");
});

test("a reading with no usable accuracy is never trusted", () => {
  for (const a of [undefined, null, NaN, -5, "12"]) assert.equal(F.readingQuality(a, h3), "poor", String(a));
});

test("GPS runs only while something needs your position (web.dev: clearWatch otherwise)", () => {
  const base = { mode: "rider", online: false, ride: null, pending: { online: false, hand: false } };
  assert.equal(F.gpsNeeded(base), false, "just browsing");
  assert.equal(F.gpsNeeded({ ...base, mode: "driver", online: true }), true, "online driver");
  assert.equal(F.gpsNeeded({ ...base, mode: "driver", online: false }), false, "offline driver");
  assert.equal(F.gpsNeeded({ ...base, pending: { online: true, hand: false } }), true, "GO ONLINE waiting");
  assert.equal(F.gpsNeeded({ ...base, pending: { online: false, hand: true } }), true, "✋ waiting to be placed");
  assert.equal(F.gpsNeeded({ ...base, ride: { status: "requested" } }), false, "request pending: nothing is sent");
  assert.equal(F.gpsNeeded({ ...base, ride: { status: "connected" } }), true, "in a ride");
  assert.equal(F.gpsNeeded({ ...base, ride: { status: "arrived" } }), true, "arrived");
  // a placed ✋ is sent once: no GPS while it's up
  assert.equal(F.gpsNeeded({ ...base, handRaised: true }), false, "✋ already placed");
});

test("the platform decides which steps to show", () => {
  assert.equal(F.platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)"), "ios");
  assert.equal(F.platformOf("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)"), "ios");
  assert.equal(F.platformOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126"), "android");
  assert.equal(F.platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126"), "other");
});

test("searching: quiet at first, 'Finding…' after 5 s, Precise Location steps after 15 s", () => {
  const msg = (waitedMs, quality = null, platform = "ios") =>
    F.locationMessage({ status: "searching", quality, waitedMs, platform, context: "drive" });
  assert.equal(msg(2000), null);
  assert.match(msg(6000), /Finding your location/);
  assert.match(msg(6000, "poor"), /Finding your location/);
  assert.match(msg(16000), /Precise Location/);
  assert.match(msg(16000), /Safari Websites/);
});

test("an approximate reading asks for Precise Location at once — with the right steps", () => {
  const ios = F.locationMessage({ status: "searching", quality: "approximate", waitedMs: 500, platform: "ios", context: "hand" });
  assert.match(ios, /approximate/);
  // unknown iPhone browser: Safari's entry, or the browser's own name
  assert.match(ios, /Safari Websites \(or your browser's name, if you don't use Safari\) › Precise Location/);
  assert.match(ios, /ask for a ride/);
  const android = F.locationMessage({ status: "searching", quality: "approximate", waitedMs: 500, platform: "android", context: "drive" });
  assert.match(android, /Use precise location/);
  assert.match(android, /to drive/);
});

test("denied: never 'waiting' — the steps to allow it again", () => {
  const m = F.locationMessage({ status: "denied", quality: null, waitedMs: 0, platform: "android", context: "request" });
  assert.match(m, /blocked/);
  assert.match(m, /Permissions › Location/);
  assert.match(m, /driver can find you/);
  assert.doesNotMatch(m, /Finding/);
  assert.match(F.locationMessage({ status: "denied", quality: null, waitedMs: 0, platform: "ios", context: "locate" }), /While Using/);
});

test("a prompt left unanswered (Firefox 'Not now', or just ignored) is NOT called 'approximate'", () => {
  // no callback ever comes for an unanswered prompt, so after 15 s the
  // question is still open: say so, don't send them to Precise Location
  const m = F.locationMessage({ status: "searching", quality: null, waitedMs: 16000, platform: "android", context: "hand", permission: "prompt" });
  assert.match(m, /Allow/);
  assert.match(m, /ask for a ride/);
  assert.doesNotMatch(m, /approximate|Precise/);
  // once it's answered (granted) and still nothing good: it IS the setting
  assert.match(F.locationMessage({ status: "searching", quality: null, waitedMs: 16000, platform: "android", context: "hand", permission: "granted" }), /Precise/);
  // before 15 s it's just "Finding…" either way
  assert.match(F.locationMessage({ status: "searching", quality: null, waitedMs: 6000, platform: "android", context: "hand", permission: "prompt" }), /Finding/);
});

test("the steps name the WEB address bar — and an installed app (no address bar) gets its own path", () => {
  for (const platform of ["android", "other"]) {
    const browser = F.locationMessage({ status: "denied", platform, context: "drive" });
    assert.match(browser, /web address bar/, platform);
    const app = F.locationMessage({ status: "denied", platform, context: "drive", standalone: true });
    assert.doesNotMatch(app, /address bar/, platform);
    assert.match(app, /Site settings › Location/, platform);
  }
  // iPhone: the same Settings path either way
  assert.match(F.locationMessage({ status: "denied", platform: "ios", context: "drive", standalone: true }), /Safari Websites/);
});

test("unavailable (location off for the whole device): turn on Location Services", () => {
  const m = F.locationMessage({ status: "unavailable", quality: null, waitedMs: 0, platform: "ios", context: "drive" });
  assert.match(m, /Location Services/);
  assert.doesNotMatch(m, /blocked/);
});

test("online without a trusted reading: riders can't see you — and why, if it's blocked", () => {
  assert.match(F.noFixBanner({ haveFix: false, mode: "driver", online: true }), /can't see you/);
  const blocked = F.noFixBanner({ haveFix: false, mode: "driver", online: true, geoStatus: "denied", platform: "ios" });
  assert.match(blocked, /can't see you/);
  assert.match(blocked, /blocked/);
  assert.equal(F.noFixBanner({ haveFix: true, mode: "driver", online: true, geoStatus: "watching" }), null);
});

// ── which browser: the steps name ITS switch (owner's Brave on iPhone,
// 2026-10-29: the banner said "Safari Websites", a switch Brave ignores).
// Two layers on every phone: the phone lets the BROWSER APP use location
// (Apple: Settings › Privacy & Security › Location Services › the app), then
// the browser lets the SITE. A browser is named only when it says so —
// Brave can hide its mark and Firefox on iPhone can send Safari's exact
// identity, so a Safari-looking iPhone gets wording that's right either way.
const UA = {
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.7049.83 Mobile/15E148 Safari/604.1",
  firefoxIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/139.0 Mobile/15E148 Safari/605.1.15",
  edgeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/136.0.3240.91 Mobile/15E148 Safari/605.1.15",
  braveIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Brave",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 380.0.0.0",
  facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0]",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:139.0) Gecko/139.0 Firefox/139.0",
  edgeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36 EdgA/135.0.0.0",
};

const denied = (ua, extra = {}) =>
  F.locationMessage({ status: "denied", context: "hand", ...F.browserOf(ua, extra.brave), ...extra });

test("the browser is named only when it says so", () => {
  assert.deepEqual(F.browserOf(UA.safari), { platform: "ios", app: null });
  assert.deepEqual(F.browserOf(UA.chromeIos), { platform: "ios", app: "Chrome" });
  assert.deepEqual(F.browserOf(UA.firefoxIos), { platform: "ios", app: "Firefox" });
  assert.deepEqual(F.browserOf(UA.edgeIos), { platform: "ios", app: "Edge" });
  assert.deepEqual(F.browserOf(UA.braveIos), { platform: "ios", app: "Brave" });
  // Brave with its mark hidden, but its own API there (navigator.brave)
  assert.deepEqual(F.browserOf(UA.safari, true), { platform: "ios", app: "Brave" });
  assert.deepEqual(F.browserOf(UA.instagram), { platform: "ios", app: "Instagram" });
  assert.deepEqual(F.browserOf(UA.facebook), { platform: "ios", app: "Facebook" });
  assert.deepEqual(F.browserOf(UA.chromeAndroid), { platform: "android", app: "Chrome" });
  assert.deepEqual(F.browserOf(UA.samsung), { platform: "android", app: "Samsung Internet" });
  assert.deepEqual(F.browserOf(UA.firefoxAndroid), { platform: "android", app: "Firefox" });
  assert.deepEqual(F.browserOf(UA.edgeAndroid), { platform: "android", app: "Edge" });
  assert.deepEqual(F.browserOf(UA.chromeAndroid, true), { platform: "android", app: "Brave" });
  // the old name still answers
  assert.equal(F.platformOf(UA.braveIos), "ios");
});

test("iPhone, blocked: Apple's path to THIS browser's switch", () => {
  for (const [ua, app] of [
    [UA.braveIos, "Brave"],
    [UA.chromeIos, "Chrome"],
    [UA.firefoxIos, "Firefox"],
    [UA.edgeIos, "Edge"],
    [UA.instagram, "Instagram"],
    [UA.facebook, "Facebook"],
  ]) {
    const m = denied(ua);
    assert.match(m, new RegExp(`Settings › Privacy & Security › Location Services › ${app} › While Using the App`), app);
    assert.doesNotMatch(m, /Safari/, `${app}: never sent to Safari's switch`);
  }
});

test("iPhone that looks like Safari: right whether it IS Safari or a browser hiding its name", () => {
  const m = denied(UA.safari);
  assert.match(m, /Location Services › Safari Websites \(or your browser's name, if you don't use Safari\) › While Using the App/);
});

test("Android, blocked: the browser's own site path, and the phone's switch for that app", () => {
  const chrome = denied(UA.chromeAndroid);
  assert.match(chrome, /icon at the left of the web address bar .*› Permissions › Location › Allow/);
  assert.match(chrome, /Settings › Apps › Chrome › Permissions › Location/);

  const samsung = denied(UA.samsung);
  assert.match(samsung, /menu › Settings › Sites and downloads › Site permissions › Location/);
  assert.match(samsung, /Settings › Apps › Samsung Internet › Permissions › Location/);

  const firefox = denied(UA.firefoxAndroid);
  // (Firefox for Android: "Site settings" now — its own shipped strings, 2026-11-04)
  assert.match(firefox, /⋮ › Settings › Site settings › Location/);
  assert.match(firefox, /Settings › Apps › Firefox › Permissions › Location/);

  assert.match(denied(UA.edgeAndroid), /Settings › Apps › Edge ›/);
  assert.match(denied(UA.chromeAndroid, { brave: true }), /Settings › Apps › Brave ›/);
});

test("Precise Location steps name the browser too", () => {
  const precise = (ua) =>
    F.locationMessage({ status: "searching", quality: "approximate", waitedMs: 0, context: "drive", ...F.browserOf(ua) });
  assert.match(precise(UA.braveIos), /Location Services › Brave › Precise Location: on/);
  assert.match(precise(UA.safari), /Safari Websites \(or your browser's name, if you don't use Safari\) › Precise Location: on/);
  assert.match(precise(UA.samsung), /Settings › Apps › Samsung Internet › Permissions › Location › Use precise location/);
});

test("an installed app (no address bar) on Android: the browser's own menu, named", () => {
  const m = F.locationMessage({ status: "denied", context: "drive", standalone: true, ...F.browserOf(UA.chromeAndroid, true) });
  assert.doesNotMatch(m, /address bar/);
  assert.match(m, /open Brave › ⋮ › Settings › Site settings › Location/);
});

// ── precise, and the reload: Hood Ride places you within one block, which
// "approximate" can't (Apple: a per-app Precise Location switch, iOS 14+;
// Android 12+: "Use precise location"; Chrome on Android since May 2026
// asks "Precise / Approximate" per site). After "blocked", Hood Ride reloads
// when you come back (the browser keeps its "no" until then).

test("iPhone, blocked: While Using the App AND Precise Location, and the reload said", () => {
  const m = denied(UA.braveIos);
  assert.match(m, /› Brave › While Using the App, and turn on Precise Location\./);
  assert.match(m, /Hood Ride reloads when you come back\.$/);
});

test("Android, blocked: Precise in Chrome's question and in the phone's switch, and the reload said", () => {
  const m = denied(UA.chromeAndroid);
  assert.match(m, /› Permissions › Location › Allow \(choose Precise if asked\)/);
  assert.match(m, /Settings › Apps › Chrome › Permissions › Location › Allow, with Use precise location on/);
  assert.match(m, /Hood Ride reloads when you come back\.$/);
});

test("a computer: no trip out of the browser, so no reload promised", () => {
  const m = F.locationMessage({ status: "denied", platform: "other", context: "hand" });
  assert.doesNotMatch(m, /reloads/);
});

test("Android, only approximate: Chrome's per-site Approximate is undone with Reset permissions", () => {
  const m = F.locationMessage({ status: "searching", quality: "approximate", waitedMs: 0, context: "drive", ...F.browserOf(UA.chromeAndroid) });
  assert.match(m, /Use precise location/);
  assert.match(m, /if you chose Approximate for Hood Ride: tap the icon at the left of the web address › Permissions › Reset permissions, then try again and choose Precise/);
  // an installed app has no address bar: not offered there
  const app = F.locationMessage({ status: "searching", quality: "approximate", waitedMs: 0, context: "drive", standalone: true, ...F.browserOf(UA.chromeAndroid) });
  assert.doesNotMatch(app, /address/);
});
