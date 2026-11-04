// Navigate: a real link the driver taps, not window.open(…, "_blank").
// On iPhone the new tab handed the link to the Google Maps app and was
// left behind, blank (owner, 2026-10-29). A tapped link in the SAME tab
// opens the app (Google registers /maps/dir/* for com.google.Maps in its
// apple-app-site-association) and leaves Hood Ride where it was. Computers
// have no Maps app: a new tab there, so Hood Ride stays open.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("../priv/static/navlink.js");

test("the Google Maps directions address, as Google documents it (the default app)", () => {
  assert.equal(
    N.href({ lat: 40.71234, lng: -74.00567 }),
    "https://www.google.com/maps/dir/?api=1&destination=40.71234%2C-74.00567"
  );
  assert.equal(N.href({ lat: 40.71234, lng: -74.00567 }, "google"), N.href({ lat: 40.71234, lng: -74.00567 }));
});

// ---- the driver's own map app (owner, 2026-11-02; Uber's drivers pick
// theirs: Account > App Settings > Navigation). Each app's own web link,
// as it documents it: the app opens when installed, else its website ----

test("Waze: its documented link, navigation on", () => {
  assert.equal(
    N.href({ lat: 40.71234, lng: -74.00567 }, "waze"),
    "https://waze.com/ul?ll=40.71234%2C-74.00567&navigate=yes"
  );
});

test("Apple Maps: its unified directions link (iOS 18.4+; Apple: the old ?daddr= form no longer works), driving", () => {
  assert.equal(
    N.href({ lat: 40.71234, lng: -74.00567 }, "apple"),
    "https://maps.apple.com/directions?destination=40.71234,-74.00567&mode=driving"
  );
});

test("an app it doesn't know: no address", () => {
  assert.equal(N.href({ lat: 1, lng: 2 }, "bing"), null);
});

test("the choices: Apple Maps only on iPhone (elsewhere its link is just a web page)", () => {
  assert.deepEqual(N.choices("ios"), ["google", "apple", "waze"]);
  assert.deepEqual(N.choices("android"), ["google", "waze"]);
  assert.deepEqual(N.choices("other"), ["google", "waze"]);
});

test("each choice has its name, for the button (Google: name the app on it)", () => {
  assert.equal(N.label("google"), "Google Maps");
  assert.equal(N.label("apple"), "Apple Maps");
  assert.equal(N.label("waze"), "Waze");
});

// remembered on this phone only — never sent anywhere
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test("not chosen yet: null (the first Navigate asks)", () => {
  assert.equal(N.chosen(memory(), "ios"), null);
});

test("chosen: remembered, and read back", () => {
  const s = memory();
  N.choose(s, "waze");
  assert.equal(N.chosen(s, "android"), "waze");
});

test("a choice this phone can't use, or junk: as if not chosen (it asks again)", () => {
  const s = memory();
  N.choose(s, "apple");
  assert.equal(N.chosen(s, "ios"), "apple");
  assert.equal(N.chosen(s, "android"), null, "Apple Maps on Android: asked again");
  s.setItem("hoodride_navapp", "bing");
  assert.equal(N.chosen(s, "ios"), null);
});

test("an unknown app is never saved", () => {
  const s = memory();
  N.choose(s, "bing");
  assert.equal(s.m.size, 0);
});

test("storage blocked (private mode): nothing remembered, nothing breaks", () => {
  const blocked = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
  assert.equal(N.chosen(blocked, "ios"), null);
  assert.doesNotThrow(() => N.choose(blocked, "waze"));
  assert.equal(N.chosen(null, "ios"), null);
  assert.doesNotThrow(() => N.choose(null, "waze"));
});

test("phones: the same tab (the Maps app takes it — no blank tab left); computers: a new tab", () => {
  assert.equal(N.target("ios"), "_self");
  assert.equal(N.target("android"), "_self");
  assert.equal(N.target("other"), "_blank");
});

test("no destination: no address (the tap does nothing)", () => {
  assert.equal(N.href(null), null);
  assert.equal(N.href({ lat: NaN, lng: 1 }), null);
});

// Apple's new links came with iOS 18.4 (no source says older iOS reads
// them), and its old ?daddr= link stopped working after: each iPhone gets
// the link of its own iOS, read from the browser's identity text
const UA = (v) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1`;
const T = { lat: 40.71234, lng: -74.00567 };
const NEW = "https://maps.apple.com/directions?destination=40.71234,-74.00567&mode=driving";
const OLD = "https://maps.apple.com/?daddr=40.71234,-74.00567&dirflg=d";

test("Apple Maps on iOS 18.4 and later: the unified link", () => {
  for (const v of ["18_4", "18_4_1", "18_5", "19_0", "26_1"]) assert.equal(N.href(T, "apple", UA(v)), NEW, v);
});

test("Apple Maps before iOS 18.4: the old link, which worked there", () => {
  for (const v of ["18_3_2", "18_0", "17_5", "16_7_10"]) assert.equal(N.href(T, "apple", UA(v)), OLD, v);
});

test("Apple Maps, iOS version unreadable: the current (unified) link", () => {
  assert.equal(N.href(T, "apple", ""), NEW);
  assert.equal(N.href(T, "apple"), NEW);
});

test("the iOS version read from the identity text", () => {
  assert.deepEqual(N.iosVersion(UA("18_4_1")), [18, 4]);
  assert.deepEqual(N.iosVersion(UA("17_5")), [17, 5]);
  assert.equal(N.iosVersion("Mozilla/5.0 (Linux; Android 14)"), null);
});
