// Node tests for priv/static/sendfilter.js — when the app sends its own
// position. A silent break here (e.g. no heartbeat) would make a parked
// driver vanish from everyone's map after the server's 3-minute reap.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../priv/static/sendfilter.js");

const HOME = { lat: 40.7154, lng: -74.0086 };
const KEYS = "882a1072c7fffff|872a1072cffffff,852a1073fffffff";
// a distance threshold to exercise the rule with (the ride path uses
// F.RIDE_MIN_METERS; a browsing car sends on a new spot only)
const DRIVER = 15;
const SERVER_REAP_MS = 3 * 60 * 1000; // lib/hoodride/sweeper.ex @position_stale

// a point `m` metres north / east of `p`
const north = (p, m) => ({ lat: p.lat + m / 111195, lng: p.lng });
const east = (p, m) => ({ lat: p.lat, lng: p.lng + m / (111195 * Math.cos((p.lat * Math.PI) / 180)) });

test("distance is real metres (haversine), and symmetric", () => {
  assert.ok(Math.abs(F.metersBetween(HOME, north(HOME, 100)) - 100) < 0.5);
  // Times Square ↔ Empire State Building ≈ 1.1 km
  const ts = { lat: 40.758, lng: -73.9855 };
  const esb = { lat: 40.7484, lng: -73.9857 };
  const d = F.metersBetween(ts, esb);
  assert.ok(d > 1000 && d < 1150, `${d} m`);
  assert.equal(F.metersBetween(ts, esb), F.metersBetween(esb, ts));
  assert.equal(F.metersBetween(HOME, HOME), 0);
  // east–west counts too: due east 100 m, and Hudson ↔ East River across
  // Manhattan at ~W 34th St (≈ 3 km)
  assert.ok(Math.abs(F.metersBetween(HOME, east(HOME, 100)) - 100) < 0.5);
  const hudson = { lat: 40.757, lng: -74.004 };
  const eastRiver = { lat: 40.757, lng: -73.9665 };
  const across = F.metersBetween(hudson, eastRiver);
  assert.ok(across > 3000 && across < 3300, `${across} m`);
});

test("driving due east or west 15 m is sent too, not only north–south", () => {
  const last = F.stamp(HOME, KEYS, 0, () => 0.5);
  assert.equal(F.shouldSend(last, 1000, east(HOME, 16), KEYS, DRIVER), true);
  assert.equal(F.shouldSend(last, 1000, east(HOME, -16), KEYS, DRIVER), true);
  assert.equal(F.shouldSend(last, 1000, east(HOME, 10), KEYS, DRIVER), false);
});

test("the first fix is always sent", () => {
  assert.equal(F.shouldSend(null, 0, HOME, KEYS, DRIVER), true);
});

test("parked GPS wobble (< 15 m, same cell) is swallowed", () => {
  const last = F.stamp(HOME, KEYS, 0, () => 0.5);
  for (const m of [0, 3, 8, 14]) {
    assert.equal(F.shouldSend(last, 5000, north(HOME, m), KEYS, DRIVER), false, `${m} m sent`);
  }
});

test("moving 15 m or more is sent", () => {
  const last = F.stamp(HOME, KEYS, 0, () => 0.5);
  assert.equal(F.shouldSend(last, 1000, north(HOME, 15.5), KEYS, DRIVER), true);
  assert.equal(F.shouldSend(last, 1000, north(HOME, 200), KEYS, DRIVER), true);
});

test("crossing into another cell is sent even for a tiny move", () => {
  const last = F.stamp(HOME, KEYS, 0, () => 0.5);
  assert.equal(F.shouldSend(last, 1000, north(HOME, 2), "other-cell|" + KEYS.split("|")[1], DRIVER), true);
  // a parent change alone (same res-8 cell) counts too
  assert.equal(F.shouldSend(last, 1000, north(HOME, 2), KEYS.split("|")[0] + "|other-parents", DRIVER), true);
});

test("a parked phone heartbeats: due at its drawn 16–24 s, not before", () => {
  for (const [random, hb] of [
    [() => 0, 16000],
    [() => 0.5, 20000],
    [() => 1, 24000],
  ]) {
    const last = F.stamp(HOME, KEYS, 0, random);
    assert.equal(last.heartbeatMs, hb);
    assert.equal(F.shouldSend(last, hb - 1, HOME, KEYS, DRIVER), false, `sent before ${hb} ms`);
    assert.equal(F.shouldSend(last, hb, HOME, KEYS, DRIVER), true, `not sent at ${hb} ms`);
  }
});

test("heartbeats are spread out — and always far inside the server's 3-minute reap", () => {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const draws = Array.from({ length: 5000 }, () => F.stamp(HOME, KEYS, 0, rnd).heartbeatMs);
  assert.ok(draws.every((d) => d >= 16000 && d <= 24000));
  assert.ok(Math.min(...draws) < 16500 && Math.max(...draws) > 23500, "not spread across the range");
  // even with the 1.5 s tick that checks it, a parked driver is re-sent
  // many times before the server would reap it
  assert.ok(24000 + 1500 < SERVER_REAP_MS / 5);
});

test("simulated parked driver over 10 minutes: never silent long enough to be reaped", () => {
  let s = 777;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let last = null;
  let lastSentAt = 0;
  let longestSilence = 0;
  for (let now = 0; now <= 10 * 60000; now += 1500) {
    // the app's 1.5 s tick, GPS wobbling a few metres around the spot
    const pos = north(HOME, (rnd() - 0.5) * 8);
    if (F.shouldSend(last, now, pos, KEYS, DRIVER)) {
      longestSilence = Math.max(longestSilence, now - lastSentAt);
      last = F.stamp(pos, KEYS, now, rnd);
      lastSentAt = now;
    }
  }
  assert.ok(longestSilence <= 24000 + 1500, `silent for ${longestSilence} ms`);
  assert.ok(longestSilence < SERVER_REAP_MS);
});

test("after a reload the seed sends nothing until a real move or the plain 20 s heartbeat", () => {
  const seeded = F.seed(HOME, KEYS, 0);
  assert.equal(seeded.heartbeatMs, undefined);
  assert.equal(F.shouldSend(seeded, 19999, north(HOME, 5), KEYS, DRIVER), false);
  assert.equal(F.shouldSend(seeded, 20000, HOME, KEYS, DRIVER), true);
  assert.equal(F.shouldSend(seeded, 1000, north(HOME, 50), KEYS, DRIVER), true);
});

test("ride positions use the tighter 10 m threshold (two people meeting up)", () => {
  assert.equal(F.RIDE_MIN_METERS, 10);
  const last = F.stamp(HOME, "", 0, () => 0.5);
  assert.equal(F.shouldSend(last, 1000, north(HOME, 9), "", F.RIDE_MIN_METERS), false);
  assert.equal(F.shouldSend(last, 1000, north(HOME, 10.5), "", F.RIDE_MIN_METERS), true);
  assert.equal(F.shouldSend(last, 20000, HOME, "", F.RIDE_MIN_METERS), true);
});
