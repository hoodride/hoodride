// Node tests for priv/static/distance.js — "how far away" (ARCHITECTURE.md
// "Distances"): the straight line × the detour index 1.3, shown plainly ("0.8 mi away");
// measured to the best position the app may have, best first — the ride
// partner's exact one, the block they show on your map, the block they last
// shared by messaging or requesting (with its age), else nothing.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../priv/static/distance.js");

// a flat-earth stand-in: 1 unit of lat = 1000 m
const flat = (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000;

test("the drive, estimated: straight line × 1.3, shown plainly; under 0.1 mi 'nearby'", () => {
  assert.equal(D.ROAD_FACTOR, 1.3);
  assert.equal(D.distance(1000, "mi"), "0.8 mi"); // 1 km straight → 1.3 km ≈ 0.81 mi
  assert.equal(D.away(1000, "mi"), "0.8 mi away");
  assert.equal(D.away(100, "mi"), "nearby"); // 130 m < 0.1 mi
  assert.equal(D.distance(100, "mi"), "nearby");
});

test("in km: the same estimate, and 'nearby' is the same real distance (~160 m by road)", () => {
  assert.equal(D.distance(1000, "km"), "1.3 km");
  assert.equal(D.away(1000, "km"), "1.3 km away");
  assert.equal(D.away(100, "km"), "nearby");
  // 123 m straight → 160 m by road: just under 0.1 mi → nearby in both units
  assert.equal(D.away(123, "km"), "nearby");
  assert.equal(D.away(123, "mi"), "nearby");
  // 125 m straight → 162.5 m by road: past it in both units
  assert.equal(D.away(125, "km"), "0.2 km away");
  assert.equal(D.away(125, "mi"), "0.1 mi away");
});

// CLDR unit preferences, length/road: mile for US and GB, kilometer for
// everyone else (the "001" world default)
test("the unit: from the first browser language that names a region — US, GB → mi, else km", () => {
  assert.equal(D.unitOf(["en-US"]), "mi");
  assert.equal(D.unitOf(["en-GB"]), "mi");
  assert.equal(D.unitOf(["en-CA"]), "km");
  assert.equal(D.unitOf(["fr-FR"]), "km");
  assert.equal(D.unitOf(["es-MX", "en-US"]), "km", "the first one wins");
  assert.equal(D.unitOf(["en", "fr-FR"]), "km", "the first that NAMES a region wins");
  assert.equal(D.unitOf(["zh-Hant-TW"]), "km", "a script in between");
  assert.equal(D.unitOf(["en-us"]), "mi", "any letter case");
  assert.equal(D.unitOf(["es-419"]), "km", "a numeric region (Latin America)");
});

test("no region named: the language's likeliest one (en → US, de → DE, ja → JP)", () => {
  assert.equal(D.unitOf(["en"]), "mi");
  assert.equal(D.unitOf(["de"]), "km");
  assert.equal(D.unitOf(["ja"]), "km");
});

test("nothing usable: miles (Hood Ride launches in the US)", () => {
  assert.equal(D.unitOf([]), "mi");
  assert.equal(D.unitOf(undefined), "mi");
  assert.equal(D.unitOf(["", "not a tag!"]), "mi");
  assert.equal(D.unitOf(["xx"]), "mi", "a language with no likely region");
});

test("the age reads once a minute has passed", () => {
  assert.equal(D.ago(null), "");
  assert.equal(D.ago(59_999), "");
  assert.equal(D.ago(60_000), "1 min ago");
  assert.equal(D.ago(20 * 60_000 + 5), "20 min ago");
  assert.equal(D.ago(3 * 3_600_000 + 1), "3 h ago");
});

test("best position first: ride → on the map → shared → none", () => {
  const ride = { lat: 1, lng: 0 };
  const map = { lat: 2, lng: 0 };
  const shared = { lat: 3, lng: 0, ageAtRx: 0, rxAt: 0 };
  assert.deepEqual(D.target({ ridePos: ride, mapPos: map, shared, now: 0 }), { lat: 1, lng: 0, ageMs: null });
  assert.deepEqual(D.target({ mapPos: map, shared, now: 0 }), { lat: 2, lng: 0, ageMs: null });
  assert.deepEqual(D.target({ shared, now: 0 }), { lat: 3, lng: 0, ageMs: 0 });
  assert.equal(D.target({ now: 0 }), null);
});

test("a shared block ages from when it was sent (the server's age) plus the time since", () => {
  const shared = { lat: 0, lng: 0, ageAtRx: 5 * 60_000, rxAt: 1000 };
  assert.equal(D.target({ shared, now: 1000 + 15 * 60_000 }).ageMs, 20 * 60_000);
});

test("the label: distance, and the age only for a shared block", () => {
  const here = { lat: 0, lng: 0 };
  assert.equal(D.label(here, { lat: 0.5, lng: 0, ageMs: null }, flat, "mi"), "0.4 mi away");
  assert.equal(D.label(here, { lat: 0.5, lng: 0, ageMs: 20 * 60_000 }, flat, "mi"), "0.4 mi away · 20 min ago");
  assert.equal(D.label(here, { lat: 0.5, lng: 0, ageMs: null }, flat, "km"), "0.7 km away");
  assert.equal(D.label(here, null, flat, "mi"), "");
  assert.equal(D.label(null, { lat: 0.5, lng: 0, ageMs: null }, flat, "mi"), "", "no position of my own: nothing");
});

// ----- gaps a mutation sweep found (Stryker, owner 2026-11-05) -----
const I18n = require("../priv/static/i18n.js");

test("'nearby' stops exactly at 0.1 mi by road: one millimetre under is nearby, the line itself isn't", () => {
  const line = (0.1 * 1609.34) / D.ROAD_FACTOR; // straight metres whose road distance is exactly 0.1 mi
  assert.equal(D.distance(line - 0.001, "mi"), "nearby");
  assert.equal(D.distance(line, "mi"), "0.1 mi");
  assert.equal(D.away(line - 0.001, "km"), "nearby");
  assert.equal(D.away(line, "km"), "0.2 km away");
});

test("the age: 59 minutes in minutes, 60 in hours", () => {
  assert.equal(D.ago(59 * 60_000), "59 min ago");
  assert.equal(D.ago(60 * 60_000), "1 h ago");
  assert.equal(D.ago(119 * 60_000), "1 h ago");
  assert.equal(D.ago(undefined), "");
});

test("long distances: no thousands separator (1234.5, not 1,234.5)", () => {
  assert.equal(D.distance((1234.5 * 1000) / D.ROAD_FACTOR, "km"), "1234.5 km");
});

test("the number in the reader's language: German writes 0,8; the made-up test language writes English's", () => {
  try {
    I18n.load({ lang: "de", messages: {} });
    assert.equal(D.distance(1000, "mi"), "0,8 mi");
    I18n.load({ lang: "en-XA", messages: {} });
    assert.equal(D.distance(1000, "mi"), "0.8 mi");
    // a language the browser can't format: the plain number, never a crash
    I18n.load({ lang: "not a tag!", messages: {} });
    assert.equal(D.distance(1000, "mi"), "0.8 mi");
  } finally {
    I18n.load(null);
  }
});

test("a browser without Intl.Locale: miles (never a crash)", () => {
  const saved = Intl.Locale;
  try {
    Intl.Locale = undefined;
    assert.equal(D.unitOf(["de-DE"]), "mi");
  } finally {
    Intl.Locale = saved;
  }
  assert.equal(D.unitOf(["de-DE"]), "km", "back: the real rule");
});
