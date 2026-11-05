// Node tests for priv/static/ridepos.js — your ride partner's position.
// A position is FRESH while younger than two of the longest heartbeats
// (2 × 24 s): presence systems call someone gone only after ~two missed
// beats (PubNub: heartbeat = timeout/2 − 1), so one late heartbeat never
// flashes "last seen". A stale position is still shown — it's the best we
// have (a driver in Google Maps: a backgrounded web app gets no GPS) — but
// as "last seen …", and auto-arrival never fires on it.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HoodSendFilter = require("../priv/static/sendfilter.js");
const R = require("../priv/static/ridepos.js");

test("fresh = younger than two of the longest heartbeats (from the send filter, no new number)", () => {
  const longest = HoodSendFilter.HEARTBEAT_MS * (1 + HoodSendFilter.HEARTBEAT_JITTER);
  assert.equal(R.FRESH_MS, 2 * longest);
  assert.equal(R.FRESH_MS, 48_000);
  assert.ok(R.fresh(0));
  assert.ok(R.fresh(47_999));
  assert.ok(!R.fresh(48_000));
  assert.ok(!R.fresh(null), "no position at all is not fresh");
});

test("age: the server's age on arrival, plus the time since (a steady clock)", () => {
  const p = R.received({ lat: 1, lng: 2, age_ms: 5_000 }, 100_000);
  assert.equal(R.ageMs(p, 100_000), 5_000);
  assert.equal(R.ageMs(p, 130_000), 35_000);
  // a live one has no age_ms: brand new
  assert.equal(R.ageMs(R.received({ lat: 1, lng: 2 }, 7), 7), 0);
  // a clock can't run backwards here, but never a negative age
  assert.equal(R.ageMs(p, 90_000), 5_000);
});

test("auto-arrival aims at the pin, or a FRESH exact position — never a stale one", () => {
  const pos = { lat: 1, lng: 2 };
  const pin = { lat: 3, lng: 4 };
  assert.deepEqual(R.arrivalTarget({ pin, pos, posExact: true }, 999_999), pin);
  assert.deepEqual(R.arrivalTarget({ pos, posExact: true }, 10_000), pos);
  assert.equal(R.arrivalTarget({ pos, posExact: true }, 48_000), null, "stale: the driver taps Arrived");
  assert.equal(R.arrivalTarget({ pos, posExact: false }, 0), null, "a block centre is never a target");
  assert.equal(R.arrivalTarget({}, 0), null);
});

test("\"last seen\" only once stale, in plain minutes", () => {
  assert.equal(R.lastSeen(0), null);
  assert.equal(R.lastSeen(47_999), null);
  assert.equal(R.lastSeen(48_000), "last seen 1 min ago");
  assert.equal(R.lastSeen(150_000), "last seen 3 min ago");
  assert.equal(R.lastSeen(2 * 3_600_000), "last seen over an hour ago");
  assert.equal(R.lastSeen(null), null, "no position: nothing to say");
});

// Navigate toward a stale position: the same times, as one sentence of its
// own (it was lastSeen's English with "there" spliced in — 2026-11-04)
test("\"was last seen there\": the same thresholds, one message", () => {
  assert.equal(R.lastSeenThere(47_999, "Dan"), null);
  assert.equal(R.lastSeenThere(48_000, "Dan"), "🧭 Dan was last seen there 1 min ago");
  assert.equal(R.lastSeenThere(150_000, "Dan"), "🧭 Dan was last seen there 3 min ago");
  assert.equal(R.lastSeenThere(2 * 3_600_000, "Dan"), "🧭 Dan was last seen there over an hour ago");
  assert.equal(R.lastSeenThere(null, "Dan"), null);
});

test("you announce only in a live ride, with a reading from the current watch", () => {
  assert.ok(R.mayAnnounce({ status: "connected" }, true));
  assert.ok(R.mayAnnounce({ status: "arrived" }, true));
  assert.ok(!R.mayAnnounce({ status: "connected" }, false), "no live fix: never a placeholder or old reading");
  assert.ok(!R.mayAnnounce({ status: "requested" }, true));
  assert.ok(!R.mayAnnounce(null, true));
});

test("every ride (re)join resets the send rule: the partner hears you at once", () => {
  // the send filter sends immediately when there's no last send
  assert.equal(R.afterJoin(), null);
  assert.ok(HoodSendFilter.shouldSend(R.afterJoin(), 0, { lat: 0, lng: 0 }, "", HoodSendFilter.RIDE_MIN_METERS));
});

// "You've arrived" for a minute after "I'm here", then "Ride with X · tap End
// ride when you're done" (owner, 2026-10-29: Hood Ride has no trip-start step,
// so "arrived" stayed up the whole drive). No arrival time known (the page
// reloaded mid-ride) → straight to "riding".
test("arrived for a minute, then riding", () => {
  assert.equal(R.ARRIVED_SHOW_MS, 60_000);
  assert.equal(R.arrivedPhase(0), "arrived");
  assert.equal(R.arrivedPhase(R.ARRIVED_SHOW_MS - 1), "arrived");
  assert.equal(R.arrivedPhase(R.ARRIVED_SHOW_MS), "riding");
  assert.equal(R.arrivedPhase(null), "riding", "reloaded mid-ride: arrival long past");
  assert.equal(R.arrivedPhase(undefined), "riding");
});

// Navigate (owner, 2026-11-02): it went to the BLOCK CENTRE when tapped
// before the rider's exact position came in. Its destination: the pin, or
// the exact ride position (a stale one too — "last seen there" says so);
// never a block centre, even one that's known
test("Navigate's destination: the pin, else the exact position, else none — never a block centre", () => {
  const pin = { lat: 1, lng: 2 };
  const pos = { lat: 3, lng: 4 };
  assert.deepEqual(R.navTarget({ pin, pos, posExact: false }), pin, "the pin, even before the exact position");
  assert.deepEqual(R.navTarget({ pin, pos, posExact: true }), pin);
  assert.deepEqual(R.navTarget({ pos, posExact: true }), pos, "the exact position (stale too)");
  assert.equal(R.navTarget({ pos, posExact: false }), null, "a block centre: none");
  assert.equal(R.navTarget({ pos }), null, "no word on exactness: none");
  assert.equal(R.navTarget({}), null);
  assert.equal(R.navTarget(null), null);
});
