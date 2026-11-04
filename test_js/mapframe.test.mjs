// Node tests for priv/static/mapframe.js — map updates on the phone.
// Before it, every car update redrew EVERY marker on screen (regroup all
// piles, draw each), so a busy area cost "messages × cars" per second on the
// phone. Standard practice: change the data at once, draw at most once per
// screen frame (requestAnimationFrame) — and a server "batch" is just its
// items fed to the same handlers, in order.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { unbatch, createFrameRender } = require("../priv/static/mapframe.js");

// a fake screen: frames run only when the test says so
function frames() {
  const f = { queued: [] };
  f.request = (cb) => f.queued.push(cb);
  f.tick = () => {
    const run = f.queued;
    f.queued = [];
    run.forEach((cb) => cb());
  };
  return f;
}

test("a batch feeds every item to its handler, in the server's order", () => {
  const seen = [];
  const handlers = {
    driver_update: (p) => seen.push(["u", p.id]),
    driver_left: (p) => seen.push(["l", p.id]),
  };
  unbatch(
    [
      ["driver_update", { id: 1 }],
      ["driver_left", { id: 2 }],
      ["driver_update", { id: 3 }],
    ],
    handlers
  );
  assert.deepEqual(seen, [["u", 1], ["l", 2], ["u", 3]]);
});

test("an event the app has no handler for is skipped, the rest still land", () => {
  const seen = [];
  unbatch(
    [["from_the_future", {}], ["driver_left", { id: 2 }]],
    { driver_left: (p) => seen.push(p.id) }
  );
  assert.deepEqual(seen, [2]);
});

test("a malformed batch is ignored without throwing", () => {
  const seen = [];
  const handlers = { driver_left: (p) => seen.push(p.id) };
  for (const bad of [null, undefined, "x", 5, {}, [null], [["driver_left"]], [[1, {}]]])
    assert.doesNotThrow(() => unbatch(bad, handlers));
  assert.deepEqual(seen, []);
});

test("many updates before the next frame draw ONCE", () => {
  const f = frames();
  let draws = 0;
  const schedule = createFrameRender(() => draws++, f.request);
  for (let i = 0; i < 50; i++) schedule();
  assert.equal(draws, 0, "nothing drawn before the frame");
  f.tick();
  assert.equal(draws, 1);
});

test("an update after a frame asks for the next one (nothing is lost)", () => {
  const f = frames();
  let draws = 0;
  const schedule = createFrameRender(() => draws++, f.request);
  schedule();
  f.tick();
  schedule();
  f.tick();
  assert.equal(draws, 2);
});

test("no update, no frame asked for", () => {
  const f = frames();
  createFrameRender(() => {}, f.request);
  assert.equal(f.queued.length, 0);
});

test("a hidden tab (frames paused) draws once when it comes back", () => {
  const f = frames();
  let draws = 0;
  const schedule = createFrameRender(() => draws++, f.request);
  for (let i = 0; i < 10; i++) schedule(); // updates while frames are paused
  assert.equal(f.queued.length, 1, "one frame asked for, however many updates");
  f.tick(); // the tab is shown again
  assert.equal(draws, 1);
});

test("a draw that throws doesn't stop later frames", () => {
  const f = frames();
  let draws = 0;
  const schedule = createFrameRender(() => {
    draws++;
    if (draws === 1) throw new Error("boom");
  }, f.request);
  schedule();
  assert.throws(() => f.tick());
  schedule();
  f.tick();
  assert.equal(draws, 2);
});
