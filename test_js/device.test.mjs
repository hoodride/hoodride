// Node tests for priv/static/device.js — Hood Ride opens on phones and
// tablets only; a desktop gets "open it on your phone" (owner, 2026-11-14).
// The device's kind from Bowser (bowser.js, vendored: its platform type),
// plus the two documented gaps every user-agent library has: an iPad that
// says it's a Mac (iPadOS 13+: "Macintosh", told apart by its touchscreen —
// navigator.maxTouchPoints > 1, MDN / is-mobile), and a big Android tablet
// in Chrome's desktop mode ("Linux", told apart by touch being its main
// input — pointer: coarse). Real user agents, with each device's own
// touch values.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../priv/static/device.js");
const bowser = require("../priv/static/bowser.js");
const parse = (ua) => bowser.getParser(ua).getPlatformType(true);
const opens = (d) => D.allowed({ parse, mobileHint: null, maxTouchPoints: 0, coarse: false, ...d });

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  ipad: "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ Safari, as it is by default: a Mac's
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  androidTablet: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // a premium Android tablet in Chrome's desktop mode (developer.chrome.com/blog/desktop-mode)
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

test("phones open it", () => {
  for (const ua of [UA.iphone, UA.androidChrome, UA.samsung, UA.firefoxAndroid])
    assert.equal(opens({ userAgent: ua, maxTouchPoints: 5, coarse: true }), true, ua);
});

test("…by what they say alone (the touch values aside)", () => {
  for (const ua of [UA.iphone, UA.androidChrome, UA.samsung, UA.firefoxAndroid]) assert.equal(opens({ userAgent: ua }), true, ua);
});

test("tablets open it: an iPad, an Android tablet", () => {
  assert.equal(opens({ userAgent: UA.ipad }), true);
  assert.equal(opens({ userAgent: UA.androidTablet }), true);
});

test("an iPad that says it's a Mac: its touchscreen gives it away", () => {
  assert.equal(opens({ userAgent: UA.macSafari, maxTouchPoints: 5, coarse: true }), true);
  // (with a trackpad attached, touch may not be its main input: still an iPad)
  assert.equal(opens({ userAgent: UA.macSafari, maxTouchPoints: 5, coarse: false }), true);
});

test("a big Android tablet in desktop mode ('Linux'): touch is its main input", () => {
  assert.equal(opens({ userAgent: UA.linuxChrome, maxTouchPoints: 10, coarse: true }), true);
});

test("desktops get 'open it on your phone': Mac, Windows, Linux, a Chromebook", () => {
  for (const ua of [UA.macSafari, UA.macChrome, UA.winChrome, UA.winEdge, UA.linuxFirefox, UA.linuxChrome, UA.chromebook])
    assert.equal(opens({ userAgent: ua }), false, ua);
});

test("a touchscreen laptop with a mouse (touch there, but not its main input): a desktop", () => {
  assert.equal(opens({ userAgent: UA.winChrome, maxTouchPoints: 10, coarse: false }), false);
  // one touch point is no iPad (MDN: multi-touch is > 1)
  assert.equal(opens({ userAgent: UA.macSafari, maxTouchPoints: 1 }), false);
});

test("the browser's own word: mobile (User-Agent Client Hints)", () => {
  assert.equal(opens({ userAgent: UA.linuxChrome, mobileHint: true }), true);
  // "not mobile" is no verdict on its own: a tablet says that too
  assert.equal(opens({ userAgent: UA.androidTablet, mobileHint: false }), true);
});

test("nothing to go on (no user agent): a desktop, never an error", () => {
  assert.equal(opens({ userAgent: "" }), false);
  assert.equal(opens({ userAgent: undefined }), false);
});

test("here(): from the page's own values; the server's 'any device' (dev, tests) opens it", () => {
  const win = (ua, extra = {}) => ({
    navigator: { userAgent: ua, maxTouchPoints: 0, ...extra },
    matchMedia: (q) => ({ matches: q === "(pointer: coarse)" && !!extra.coarse }),
    bowser,
    document: { querySelector: (s) => (s === 'meta[name="hoodride-any-device"]' && extra.anyDevice ? {} : null) },
  });
  assert.equal(D.here(win(UA.iphone)), true);
  assert.equal(D.here(win(UA.winChrome)), false);
  assert.equal(D.here(win(UA.winChrome, { anyDevice: true })), true);
  assert.equal(D.here(win(UA.macSafari, { maxTouchPoints: 5 })), true);
  assert.equal(D.here(win(UA.linuxChrome, { maxTouchPoints: 10, coarse: true })), true);
  assert.equal(D.here(win(UA.linuxChrome, { userAgentData: { mobile: true } })), true);
  // no Bowser (it failed to load): the phone checks still decide — a phone is never turned away
  const noBowser = (ua, extra) => ({ ...win(ua, extra), bowser: undefined });
  assert.equal(D.here(noBowser(UA.iphone)), true);
  assert.equal(D.here(noBowser(UA.winChrome)), false);
});
