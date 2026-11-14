// Node tests for priv/static/rehydrate.js — a reconnect is a reload: the
// app rebuilds its mirror from the server, then tells the user about
// anything they HAD that the server no longer has (a server restart wipes
// live state; a short wifi blip loses nothing).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../priv/static/rehydrate.js");

const rider = { mode: "rider", handRaised: false, online: false, ride: null };
const v = (over) => ({ ...rider, ...over });

test("summarize: what the user is in the middle of", () => {
  assert.deepEqual(R.summarize(v({})), { ride: false, request: false, hand: false, shift: false });
  assert.deepEqual(R.summarize(v({ handRaised: true })), { ride: false, request: false, hand: true, shift: false });
  assert.deepEqual(R.summarize(v({ mode: "driver", online: true })), { ride: false, request: false, hand: false, shift: true });
  assert.deepEqual(R.summarize(v({ ride: { status: "requested" } })), { ride: false, request: true, hand: false, shift: false });
  for (const status of ["connected", "arrived"])
    assert.deepEqual(R.summarize(v({ ride: { status } })), { ride: true, request: false, hand: false, shift: false });
  // "online" only counts in driver mode
  assert.equal(R.summarize(v({ mode: "rider", online: true })).shift, false);
});

test("a short wifi blip loses nothing: no banner", () => {
  for (const s of [v({}), v({ handRaised: true }), v({ mode: "driver", online: true }), v({ ride: { status: "connected" } })]) {
    assert.deepEqual(R.lost(R.summarize(s), R.summarize(s)), []);
    assert.equal(R.lostBanner([]), null);
  }
});

test("a server restart mid-hand: the hand is reported lost", () => {
  const lost = R.lost(R.summarize(v({ handRaised: true })), R.summarize(v({})));
  assert.deepEqual(lost, ["hand"]);
  assert.match(R.lostBanner(lost), /✋/);
});

test("mid-request, mid-shift, mid-ride: each reported with its own message", () => {
  const cases = [
    [v({ ride: { status: "requested" } }), "request", /request/i],
    [v({ mode: "driver", online: true }), "shift", /GO ONLINE/],
    [v({ ride: { status: "arrived" } }), "ride", /ride/i],
  ];
  for (const [before, kind, re] of cases) {
    const lost = R.lost(R.summarize(before), R.summarize(v({ mode: before.mode })));
    assert.deepEqual(lost, [kind]);
    assert.match(R.lostBanner(lost), re);
  }
});

test("only losses count — something NEW from the server is not a loss", () => {
  // e.g. the other tab raised a hand meanwhile: the reload just shows it
  assert.deepEqual(R.lost(R.summarize(v({})), R.summarize(v({ handRaised: true }))), []);
  // a request that turned into a ride while we were away is not "lost"
  assert.deepEqual(
    R.lost(R.summarize(v({ ride: { status: "requested" } })), R.summarize(v({ ride: { status: "connected" } }))),
    []
  );
});

test("several losses at once: the most important one is told (ride > request > hand > shift)", () => {
  assert.match(R.lostBanner(["hand", "ride"]), /ride ended/i);
  assert.match(R.lostBanner(["shift", "request"]), /request/i);
  assert.match(R.lostBanner(["shift", "hand"]), /✋/);
});

test("every banner says why: the connection was reset", () => {
  for (const k of ["ride", "request", "hand", "shift"]) assert.match(R.lostBanner([k]), /connection/i);
});

// A refused ride join used to end the ride locally whatever the reason. A
// join can now also be refused for the join budget ("rate_limited"):
// Phoenix's client retries that itself — the ride is fine.
test("a ride join refusal ends the ride only when the ride is really gone", () => {
  assert.equal(R.rideJoinLost({ reason: "gone" }), true);
  assert.equal(R.rideJoinLost({ reason: "not_yours" }), true);
  assert.equal(R.rideJoinLost({ reason: "rate_limited", retry_ms: 2000 }), false);
  // a ride alive but slow to answer (the server struggling): retried, kept
  assert.equal(R.rideJoinLost({ reason: "busy", retry_ms: 1000 }), false);
  assert.equal(R.rideJoinLost({}), false);
  assert.equal(R.rideJoinLost(undefined), false);
});
