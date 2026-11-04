// Node tests for the snapshot rule in priv/static/rehydrate.js: a state
// snapshot is only trusted if nothing live arrived while it was being
// fetched. The app rebuilds its whole mirror from /api/state; a live event
// (say "ride_started") landing during that fetch was applied, then wiped
// by the OLDER snapshot — the app forgot a ride that was happening (the
// mega monster: a rider receiving a partner's position for a ride their
// app had dropped). Same rule as the server's ride-join fix: listen first,
// then snapshot, and a snapshot something overtook is taken again.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../priv/static/rehydrate.js");

// a fake server: snapshot N is "state as of fetch N"; `during` lists how
// many live events land while each fetch is in flight
function world(during) {
  let live = 0;
  let fetches = 0;
  return {
    fetchState: async () => {
      fetches++;
      live += during[fetches - 1] || 0;
      return { snapshot: fetches };
    },
    liveCount: () => live,
    fetches: () => fetches,
  };
}

test("quiet: one fetch, that snapshot", async () => {
  const w = world([0]);
  assert.deepEqual(await R.freshState(w), { snapshot: 1 });
  assert.equal(w.fetches(), 1);
});

test("an event lands during the fetch → that snapshot may be older: fetch again", async () => {
  const w = world([1, 0]);
  assert.deepEqual(await R.freshState(w), { snapshot: 2 });
  assert.equal(w.fetches(), 2);
});

test("events keep landing → keeps fetching until one comes back with nothing in between", async () => {
  const w = world([2, 1, 3, 0]);
  assert.deepEqual(await R.freshState(w), { snapshot: 4 });
  assert.equal(w.fetches(), 4);
});

test("events BEFORE the fetch started don't count (the snapshot includes them)", async () => {
  let live = 5;
  let fetches = 0;
  const st = await R.freshState({ fetchState: async () => ({ n: ++fetches }), liveCount: () => live });
  assert.deepEqual(st, { n: 1 });
});

test("a failed fetch is a failure, not a snapshot", async () => {
  await assert.rejects(
    R.freshState({
      fetchState: async () => {
        throw new Error("offline");
      },
      liveCount: () => 0,
    }),
    /offline/
  );
});

test("what counts as live: anything on your own channel or your ride that /api/state also covers", () => {
  const m = (topic, event) => ({ topic, event });
  // the user channel: chats, requests, ride start…
  for (const e of ["msg", "request", "request_declined", "request_expired", "ride_started", "chat_closed"])
    assert.ok(R.countsAsLive(m("user:42", e)), e);
  // the ride: its end, arrival, the meetup pin
  for (const e of ["ended", "arrived", "pin"]) assert.ok(R.countsAsLive(m("ride:r7", e)), e);
  // NOT: the partner's position stream (not in /api/state, ~every 1.5 s — it
  // would never let a snapshot through), replies to our own pushes, the map
  assert.ok(!R.countsAsLive(m("ride:r7", "peer_pos")));
  assert.ok(!R.countsAsLive(m("user:42", "phx_reply")));
  assert.ok(!R.countsAsLive(m("world", "driver_update")));
  assert.ok(!R.countsAsLive(m("world", "role")));
});
