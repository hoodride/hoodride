// Node tests for the fuzzed-position rules in priv/static/sendfilter.js —
// what a driver's car and a rider's ✋ say about where they are.
//
// On the browse map a car is a SPOT (a res-9 hex, ~block-sized), never a
// point. A plain "the hex I'm in" leaks at the edges: a phone parked on a
// border wobbles between two hexes, and the flip-flop pins it to that line
// (to a corner, between three). So the spot is STICKY: it changes only when
// the fix is clearly inside another hex — clearer than its own accuracy
// says it could be by noise. The same rule, against a spot remembered on
// the device, keeps a home on an edge from showing up in A one day and B
// the next.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const F = require("../priv/static/sendfilter.js");

const RES = 9; // app.js H3_DISPLAY_RES
const A = h3.latLngToCell(40.7154, -74.0086, RES);
// B and C: two neighbours of A that also touch each other — A, B and C meet
// at one corner
const B = h3.gridDisk(A, 1).find((c) => c !== A);
const C = h3.gridDisk(A, 1).find((c) => c !== A && c !== B && h3.gridDistance(B, c) === 1);
const centre = (cell) => {
  const [lat, lng] = h3.cellToLatLng(cell);
  return { lat, lng };
};
// the point `t` of the way from p to q (straight enough at block scale)
const lerp = (p, q, t) => ({ lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t });
const fix = (p, accuracy) => ({ ...p, accuracy });
const spotOf = (prev, f) => F.stickySpot(prev, f, h3, RES);

test("first fix: the hex you're in", () => {
  assert.equal(spotOf(null, fix(centre(A), 10)), A);
});

test("THE EDGE LEAK: a phone parked on a border never flips — not once in 50 wobbles", () => {
  let spot = A;
  for (let i = 0; i < 50; i++) {
    // GPS wobble across the line: ±15 m either side, reported accuracy 20 m
    const t = 0.5 + ((i % 2 ? 1 : -1) * 15) / F.metersBetween(centre(A), centre(B));
    spot = spotOf(spot, fix(lerp(centre(A), centre(B), t), 20));
    assert.equal(spot, A, `flipped on wobble ${i}`);
  }
  // sanity: the wobble really crossed the line (else this test proves nothing)
  const across = lerp(centre(A), centre(B), 0.5 + 15 / F.metersBetween(centre(A), centre(B)));
  assert.equal(h3.latLngToCell(across.lat, across.lng, RES), B);
});

test("a corner (three hexes) holds too", () => {
  const corner = {
    lat: (centre(A).lat + centre(B).lat + centre(C).lat) / 3,
    lng: (centre(A).lng + centre(B).lng + centre(C).lng) / 3,
  };
  let spot = A;
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const towards = [centre(A), centre(B), centre(C)][i % 3];
    const p = lerp(corner, towards, 0.08); // a few metres off the corner
    seen.add(h3.latLngToCell(p.lat, p.lng, RES));
    spot = spotOf(spot, fix(p, 20));
    assert.equal(spot, A, `flipped on wobble ${i}`);
  }
  assert.ok(seen.size >= 2, "the wobble never left A — this test would prove nothing");
});

test("driving clearly into the next block switches", () => {
  assert.equal(spotOf(A, fix(centre(B), 10)), B);
  assert.equal(spotOf(A, fix(lerp(centre(A), centre(B), 0.8), 10)), B);
});

test("a very poor fix can't freeze a moving car: the margin is capped at half an edge", () => {
  // indoors / Wi-Fi: accuracy in the hundreds of metres
  assert.equal(spotOf(A, fix(centre(B), 2000)), B);
});

test("a remembered spot far away (another day, another place) is dropped at once", () => {
  const far = h3.latLngToCell(40.78, -73.95, RES);
  assert.equal(spotOf(far, fix(centre(A), 30)), A);
});

test("no reported accuracy: just the hex you're in", () => {
  assert.equal(spotOf(A, { ...centre(B) }), B);
});

// (the neighborhood and count areas come FROM the spot on the server now —
// Hoodride.H3, held to this same h3-js by Hoodride.H3Test — so they can't
// flap at their own edges either)

test("a browsing car sends on a new spot or the heartbeat — never for metres moved", () => {
  const here = centre(A);
  const last = F.stamp(here, A, 0, () => 0.5);
  const inside = lerp(centre(A), centre(B), 0.3); // ~100 m on, same spot
  assert.equal(F.shouldSend(last, 1000, inside, A, F.BROWSE_MIN_METERS), false);
  assert.equal(F.shouldSend(last, 1000, inside, B, F.BROWSE_MIN_METERS), true);
  assert.equal(F.shouldSend(last, F.HEARTBEAT_MS * 1.3, here, A, F.BROWSE_MIN_METERS), true);
});

test("no GPS fix: turning ON and sending wait; turning OFF never does", () => {
  for (const what of ["send", "turn_on"]) {
    assert.equal(F.gpsAllows(false, what), false, what);
    assert.equal(F.gpsAllows(true, what), true, what);
  }
  assert.equal(F.gpsAllows(false, "turn_off"), true);
  assert.equal(F.gpsAllows(true, "turn_off"), true);
});

test("online without a fix says so (riders can't see you yet)", () => {
  assert.match(F.noFixBanner({ haveFix: false, mode: "driver", online: true }), /can't see you/);
  assert.equal(F.noFixBanner({ haveFix: true, mode: "driver", online: true }), null);
  assert.equal(F.noFixBanner({ haveFix: false, mode: "driver", online: false }), null);
  assert.equal(F.noFixBanner({ haveFix: false, mode: "rider", online: false }), null);
});

// (auto-arrival's target — pin, or an exact AND fresh position, never a
// block centre — moved to ridepos.js; tested in ridepos.test.mjs)
