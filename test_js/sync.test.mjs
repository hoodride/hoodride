// Node tests for priv/static/sync.js — the exact scheduler the browser runs,
// driven by a manual clock, a fake channel and a controlled random source
// (no real timers, no network, no flakiness).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../priv/static/sync.js");

// ---- a manual clock: timers only fire when the test advances time ----
function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id → {at, fn}
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        timers.delete(id);
        t.fn();
      }
      now = end;
    },
    now: () => now,
  };
}

// ---- a fake channel: records pushes; the test decides each reply ----
function fakeChannel() {
  const pushes = [];
  return {
    pushes,
    push(event, payload) {
      const p = { event, payload: structuredClone(payload), cbs: {}, answered: false };
      const handle = {
        receive(status, cb) {
          p.cbs[status] = cb;
          return handle;
        },
      };
      pushes.push(p);
      return handle;
    },
    reply(p, status, data) {
      assert.ok(!p.answered, "replied twice");
      p.answered = true;
      p.cbs[status] && p.cbs[status](data);
    },
    last: () => pushes[pushes.length - 1],
    open: () => pushes.filter((p) => !p.answered),
  };
}

// random: () => 1 makes every jittered wait its UPPER bound, () => 0 its
// lower bound — exact, deterministic schedules for the range tests
// pushTimeoutMs: as Phoenix, an unanswered push times out by itself (any
// moment, between any timers) — the model-based test turns it on
function setup(random = () => 1, { pushTimeoutMs } = {}) {
  const clock = manualClock();
  const ch = fakeChannel();
  const dropped = { geo: [], agg: [] };
  const snapshots = [];
  const push = !pushTimeoutMs
    ? ch.push
    : (event, payload) => {
        const h = ch.push(event, payload);
        const p = ch.last();
        clock.setTimeout(() => {
          if (!p.answered) ch.reply(p, "timeout");
        }, pushTimeoutMs);
        return h;
      };
  const sync = S.createWorldSync({
    push,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random,
    onDropGeo: (c) => dropped.geo.push(c),
    onDropAgg: (c) => dropped.agg.push(c),
    onSnapshot: (s) => snapshots.push(s),
  });
  return { clock, ch, sync, dropped, snapshots };
}

const set = (...xs) => new Set(xs);
const sorted = (xs) => [...xs].sort();

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// time from now until the next push goes out
function gapToNextPush(clock, ch) {
  const t0 = clock.now();
  const n = ch.pushes.length;
  while (ch.pushes.length === n) clock.advance(1);
  return clock.now() - t0;
}

// ===== the jitter formulas =====

test("full jitter: uniform in [0, min(cap, base·2^(attempt−1))], attempt counted from 1", () => {
  const { jitteredBackoff: jb } = S;
  // upper bounds per attempt (random → 1)
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 20].map((a) => jb(a, 1000, 30000, () => 1)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
  );
  // lower bound is 0 at every attempt (random → 0)
  for (const a of [1, 5, 50]) assert.equal(jb(a, 1000, 30000, () => 0), 0);
  // and real randomness stays in range and actually spreads out
  const r = rng(7);
  const draws = Array.from({ length: 2000 }, () => jb(3, 1000, 30000, r));
  assert.ok(draws.every((d) => d >= 0 && d <= 4000));
  assert.ok(Math.min(...draws) < 400 && Math.max(...draws) > 3600, "not spread across the range");
});

test("reconnect/rejoin backoff (given to Phoenix): starts ≤1 s, doubles, caps at 10 s", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 10].map((a) => S.reconnectBackoff(a, () => 1)),
    [1000, 2000, 4000, 8000, 10000, 10000]
  );
  assert.equal(S.reconnectBackoff(1, () => 0), 0);
  assert.equal(S.RECONNECT_MAX_MS, 10000);
});

// A planned restart: the server says "restarting" (with a window) before it
// goes; the FIRST reconnect then lands at a random moment in that window —
// not the growing backoff, which left phones in 8 s waits after the server
// was back (deploy test: everyone back in 22 s). Still down then: the
// normal backoff carries on.
test("restart notice: the first reconnect lands inside the server's window, spread across it", () => {
  const notice = { min: 4000, max: 10000 };
  assert.equal(S.restartWait(1, notice, () => 0), 4000);
  assert.equal(S.restartWait(1, notice, () => 1), 10000);
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const draws = Array.from({ length: 2000 }, () => S.restartWait(1, notice, r));
  assert.ok(draws.every((d) => d >= 4000 && d <= 10000));
  assert.ok(Math.min(...draws) < 4600 && Math.max(...draws) > 9400, "not spread across the window");
});

test("restart notice: later attempts, or no notice, use the normal backoff", () => {
  const notice = { min: 4000, max: 10000 };
  assert.equal(S.restartWait(2, notice, () => 1), S.reconnectBackoff(2, () => 1));
  assert.equal(S.restartWait(4, notice, () => 1), S.reconnectBackoff(4, () => 1));
  assert.equal(S.restartWait(1, null, () => 1), S.reconnectBackoff(1, () => 1));
  // a malformed notice can't stall reconnecting
  assert.equal(S.restartWait(1, { min: "x", max: 5 }, () => 1), S.reconnectBackoff(1, () => 1));
  // (random 0: a reversed window would give 9000, the backoff 0)
  assert.equal(S.restartWait(1, { min: 9000, max: 1000 }, () => 0), S.reconnectBackoff(1, () => 0));
});

test("restart notice: a window is capped, so a bad one can't park phones for minutes", () => {
  assert.equal(S.restartWait(1, { min: 4000, max: 600000 }, () => 1), S.RESTART_MAX_MS);
});

test("periodic jitter: ±20% around the period", () => {
  assert.equal(S.jittered(20000, 0.2, () => 0), 16000);
  assert.equal(S.jittered(20000, 0.2, () => 1), 24000);
  assert.equal(S.jittered(20000, 0.2, () => 0.5), 20000);
});

// ===== the scheduler rules =====

test("a change is sent once the map settles, as the COMPLETE wanted sets", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a", "b"), set());
  clock.advance(S.SETTLE_MS - 1);
  assert.equal(ch.pushes.length, 1, "sent before settling");
  clock.advance(1);
  assert.equal(ch.pushes.length, 2);
  assert.deepEqual(sorted(ch.last().payload.geo), ["a", "b"]);
  assert.deepEqual(ch.last().payload.agg, []);
});

test("a burst of changes inside the settle window sends ONE sync with the latest wish", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  for (const c of ["a", "b", "c", "d"]) {
    sync.setWanted(set(c), set());
    clock.advance(100);
  }
  clock.advance(S.SETTLE_MS);
  assert.equal(ch.pushes.length, 2);
  assert.deepEqual(ch.last().payload.geo, ["d"]);
});

test("an unchanged wish sends nothing", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.setWanted(set(), set()), false);
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});
  const before = ch.pushes.length;
  assert.equal(sync.setWanted(set("a"), set()), false);
  clock.advance(5000);
  assert.equal(ch.pushes.length, before);
});

// A cell's markers are dropped only once the SERVER has let it go (the reply
// to the sync that left it out). Markers and counts are announced only when
// they change, so a cell dropped locally while the server still holds it is
// never sent again: its parked cars stayed invisible for good.
test("THE BLINK REPRO: a cell that leaves and comes straight back keeps its markers", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {}); // the join sync
  sync.setWanted(set("a"), set("x"));
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});
  // Drive → straight back: the wish blinks inside one settle window, so no
  // sync goes out and the server never stops sending — or resends — a
  sync.setWanted(set(), set());
  sync.setWanted(set("a"), set("x"));
  clock.advance(5000);
  assert.deepEqual(dropped, { geo: [], agg: [] });
});

test("a cell is dropped locally only once the server confirms it let go", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {}); // the join sync
  sync.setWanted(set("a", "b"), set("x", "y"));
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});

  sync.setWanted(set("b"), set("y"));
  assert.deepEqual(dropped, { geo: [], agg: [] }, "dropped before the server knew");
  clock.advance(S.SETTLE_MS);
  assert.deepEqual(ch.last().payload, { geo: ["b"], agg: ["y"] });
  assert.deepEqual(dropped, { geo: [], agg: [] }, "dropped before the server answered");
  ch.reply(ch.last(), "ok", {});
  assert.deepEqual(dropped, { geo: ["a"], agg: ["x"] });
});

test("a refused sync changed nothing: the cells it left out are still sent, still live", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {}); // the join sync
  sync.setWanted(set("a"), set("x"));
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});

  sync.setWanted(set(), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "error", { reason: "rate_limited", retry_ms: 1000 });
  assert.deepEqual(dropped, { geo: [], agg: [] });
  // the server still sends a's updates: they must still land
  assert.equal(sync.wantsGeo("a"), true);
  assert.equal(sync.wantsAgg("x"), true);
});

test("a cell wanted again by the time the reply lands stays (the follow-up's snapshot replaces it)", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {}); // the join sync
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});

  sync.setWanted(set(), set());
  clock.advance(S.SETTLE_MS); // the drop is in flight
  sync.setWanted(set("a"), set()); // ...and a is wanted again
  ch.reply(ch.last(), "ok", {});
  assert.deepEqual(dropped.geo, []);
  clock.advance(S.SETTLE_MS);
  assert.deepEqual(ch.last().payload.geo, ["a"], "the follow-up asks for a again");
});

test("a rejoined channel holds nothing: cells no longer wanted are dropped then", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {}); // the join sync
  sync.setWanted(set("a", "b"), set("x"));
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});

  sync.onLeft();
  sync.setWanted(set("b"), set());
  assert.deepEqual(dropped, { geo: [], agg: [] });
  sync.onJoined();
  assert.deepEqual(dropped, { geo: ["a"], agg: ["x"] });
});

test("one sync in flight; changes meanwhile → ONE follow-up with the latest wish", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  const first = ch.last();
  sync.setWanted(set("b"), set());
  clock.advance(S.SETTLE_MS);
  sync.setWanted(set("c"), set());
  clock.advance(S.SETTLE_MS);
  assert.equal(ch.open().length, 1, "a second sync went out while one was in flight");
  ch.reply(first, "ok", {});
  assert.equal(ch.pushes.length, 3);
  assert.deepEqual(ch.last().payload.geo, ["c"]);
});

test("rate_limited: never earlier than retry_ms + slack; jitter adds at most 250 ms", () => {
  for (const [random, expected] of [
    [() => 0, 997 + S.RETRY_SLACK_MS],
    [() => 1, 997 + S.RETRY_SLACK_MS + S.RETRY_JITTER_MS],
  ]) {
    const { clock, ch, sync } = setup(random);
    sync.onJoined();
    ch.reply(ch.last(), "error", { reason: "rate_limited", retry_ms: 997 });
    assert.equal(gapToNextPush(clock, ch), expected);
  }
});

test("timeouts: full-jitter backoff — upper bounds 1, 2, 4 … s capped at 30 s, reset after success", () => {
  const { clock, ch, sync } = setup(() => 1);
  sync.onJoined();
  const gaps = [];
  for (let i = 0; i < 8; i++) {
    ch.reply(ch.last(), "timeout");
    gaps.push(gapToNextPush(clock, ch));
  }
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "timeout");
  assert.equal(gapToNextPush(clock, ch), 1000, "backoff not reset after success");
});

test("timeouts with real randomness: every wait within its full-jitter range", () => {
  const { clock, ch, sync } = setup(rng(99));
  sync.onJoined();
  for (let attempt = 1; attempt <= 10; attempt++) {
    ch.reply(ch.last(), "timeout");
    const gap = gapToNextPush(clock, ch);
    const cap = Math.min(S.BACKOFF_MAX_MS, S.BACKOFF_BASE_MS * 2 ** (attempt - 1));
    assert.ok(gap >= 0 && gap <= cap + 1, `attempt ${attempt}: waited ${gap} ms, range 0–${cap}`);
  }
});

test("an unknown error is treated as retriable (backs off, never a hot loop)", () => {
  const { clock, ch, sync } = setup(() => 1);
  sync.onJoined();
  ch.reply(ch.last(), "error", { reason: "something_new" });
  assert.equal(gapToNextPush(clock, ch), 1000);
});

test("a PERMANENT refusal is not retried — not by backoff, not by the safety resync", () => {
  for (const reason of ["watch_limit", "read_only"]) {
    const { clock, ch, sync } = setup();
    sync.setWanted(set("a"), set());
    sync.onJoined();
    ch.reply(ch.last(), "error", { reason });
    clock.advance(10 * 60000); // ten minutes: backoff and many safety ticks
    assert.equal(ch.pushes.length, 1, `${reason} was retried`);
    // a CHANGED wish is a new request: it goes out
    sync.setWanted(set("b"), set());
    clock.advance(S.SETTLE_MS);
    assert.equal(ch.pushes.length, 2);
    assert.deepEqual(ch.last().payload.geo, ["b"]);
  }
});

test("refused(): the wish we want now was refused for good (find the nearest stops on it)", () => {
  const { clock, ch, sync } = setup();
  sync.setWanted(set("a"), set());
  sync.onJoined();
  assert.equal(sync.refused(), false, "asked, not answered");
  ch.reply(ch.last(), "error", { reason: "watch_limit" });
  assert.equal(sync.refused(), true);
  assert.equal(sync.settled(), false, "(never settled: why the search needs this)");
  // a passing failure isn't a refusal
  const t = setup();
  t.sync.setWanted(set("a"), set());
  t.sync.onJoined();
  t.ch.reply(t.ch.last(), "error", { reason: "something_new" });
  assert.equal(t.sync.refused(), false);
  // a changed wish isn't refused (yet)
  sync.setWanted(set("b"), set());
  assert.equal(sync.refused(), false);
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.refused(), false);
});

test("a permanent refusal is retried once after a rejoin (it may be a new server)", () => {
  const { ch, sync } = setup();
  sync.setWanted(set("a"), set());
  sync.onJoined();
  ch.reply(ch.last(), "error", { reason: "watch_limit" });
  sync.onLeft();
  sync.onJoined();
  assert.equal(ch.pushes.length, 2);
  assert.deepEqual(ch.last().payload.geo, ["a"]);
});

test("a refusal for an OLD wish doesn't block the newer wish queued behind it", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  const first = ch.last();
  sync.setWanted(set("b"), set()); // changes while the first is in flight
  clock.advance(S.SETTLE_MS);
  ch.reply(first, "error", { reason: "watch_limit" });
  assert.deepEqual(ch.last().payload.geo, ["b"], "the newer wish was not sent");
});

test("nothing is sent before joining; joining sends the whole wish immediately", () => {
  const { clock, ch, sync } = setup();
  sync.setWanted(set("a", "b"), set("x"));
  clock.advance(10000);
  assert.equal(ch.pushes.length, 0);
  sync.onJoined();
  assert.equal(ch.pushes.length, 1);
  assert.deepEqual(sorted(ch.last().payload.geo), ["a", "b"]);
  assert.deepEqual(ch.last().payload.agg, ["x"]);
});

test("a rejoin mid-flight resends the whole wish (the old reply may never come)", () => {
  const { ch, sync } = setup();
  sync.setWanted(set("a"), set());
  sync.onJoined(); // sync #1 in flight, never answered
  sync.onLeft();
  sync.onJoined();
  assert.equal(ch.pushes.length, 2);
  assert.deepEqual(ch.last().payload.geo, ["a"]);
});

test("safety resync: every 48–72 s while idle, never on top of a sync in flight", () => {
  for (const [random, period] of [
    [() => 0, 48000],
    [() => 1, 72000],
  ]) {
    const { clock, ch, sync } = setup(random);
    sync.setWanted(set("a"), set());
    sync.onJoined();
    ch.reply(ch.last(), "ok", {});
    const t0 = clock.now();
    assert.equal(gapToNextPush(clock, ch) + t0, period, `first resync at the wrong time`);
    assert.deepEqual(ch.last().payload.geo, ["a"]);
    // leave it unanswered: later ticks must not stack another
    clock.advance(period * 3);
    assert.equal(ch.pushes.length, 2);
  }
});

// every cell the server sent a snapshot for, it now holds — so its snapshot
// is kept, even if the view moved on meanwhile (owner, 2026-11-10). Thrown
// away, it was never sent again: the view back within the settle window
// asks for what the server already holds — no new snapshot — and parked
// cars there never appeared (find the nearest: "nobody" with cars there).
// Really let go later, the next sync releases it and its markers go then.
test("a snapshot for a cell the view left meanwhile is KEPT (the server holds it); released later, dropped then", () => {
  const { clock, ch, sync, snapshots, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a", "b"), set("x"));
  clock.advance(S.SETTLE_MS);
  const p = ch.last();
  sync.setWanted(set("b"), set()); // the view moved on while in flight
  ch.reply(p, "ok", { geo: [{ cell: "a" }, { cell: "b" }], agg: [{ cell: "x" }] });
  const s = snapshots[snapshots.length - 1];
  assert.deepEqual(s.geo.map((x) => x.cell).sort(), ["a", "b"], "kept: the server holds a now");
  assert.deepEqual(s.agg.map((x) => x.cell), ["x"]);
  // the follow-up (b only) releases a and x: their markers go then
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});
  assert.ok(dropped.geo.includes("a") && dropped.agg.includes("x"), JSON.stringify(dropped));
});

test("the view leaves a cell and comes back within the settle window: the cell's snapshot was kept — its cars on the map", () => {
  const { clock, ch, sync, snapshots } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a", "b"), set());
  clock.advance(S.SETTLE_MS);
  const p = ch.last();
  sync.setWanted(set("b"), set()); // away…
  ch.reply(p, "ok", { geo: [{ cell: "a", cars: [1] }, { cell: "b" }], agg: [] });
  sync.setWanted(set("a", "b"), set()); // …and back before it was ever sent
  clock.advance(S.SETTLE_MS);
  // nothing new to ask (the server already holds a + b): no snapshot again
  const got = snapshots.flatMap((x) => x.geo.map((g) => g.cell));
  assert.ok(got.includes("a"), `a's snapshot reached the app: ${JSON.stringify(got)}`);
});

test("the view leaves a cell, the follow-up is refused ('slow down'), the view comes back: the cell's snapshot was kept", () => {
  const { clock, ch, sync, snapshots } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  const p = ch.last();
  sync.setWanted(set("z"), set());
  ch.reply(p, "ok", { geo: [{ cell: "a", cars: [1] }], agg: [] });
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "error", { reason: "rate_limited", retry_ms: 500 });
  sync.setWanted(set("a"), set());
  const got = snapshots.flatMap((x) => x.geo.map((g) => g.cell));
  assert.ok(got.includes("a"), `a's snapshot reached the app: ${JSON.stringify(got)}`);
});

// ---- the original bug, end to end against a fake server ----
function fakeServer(ch) {
  const held = { geo: new Set(), agg: new Set() };
  return {
    held,
    answer(p, how) {
      if (how === "ok") {
        held.geo = new Set(p.payload.geo);
        held.agg = new Set(p.payload.agg);
        ch.reply(p, "ok", {});
      } else if (how === "rate_limited") ch.reply(p, "error", { reason: "rate_limited", retry_ms: 997 });
      else if (how === "timeout_applied") {
        // the server DID apply it, but the reply was lost
        held.geo = new Set(p.payload.geo);
        held.agg = new Set(p.payload.agg);
        ch.reply(p, "timeout");
      } else ch.reply(p, "timeout");
    },
  };
}

test("THE DESYNC REPRO: a refused sync heals by itself (it left the map blank before)", () => {
  const { clock, ch, sync } = setup();
  const server = fakeServer(ch);
  sync.setWanted(set("away1", "away2"), set());
  sync.onJoined();
  server.answer(ch.last(), "ok");
  sync.setWanted(set("home1", "home2"), set());
  clock.advance(S.SETTLE_MS);
  server.answer(ch.last(), "rate_limited");
  assert.deepEqual(sorted(server.held.geo), ["away1", "away2"], "server unchanged by the refusal");
  // no user action at all — just time
  clock.advance(997 + S.RETRY_SLACK_MS + S.RETRY_JITTER_MS);
  server.answer(ch.last(), "ok");
  assert.deepEqual(sorted(server.held.geo), ["home1", "home2"]);
});

test("chaos: random wishes, refusals, lost replies, disconnects — always converges", () => {
  const r = rng(4242);
  const cells = ["a", "b", "c", "d", "e", "f"];
  const pick = () => new Set(cells.filter(() => r() < 0.4));
  for (let run = 0; run < 300; run++) {
    const { clock, ch, sync } = setup(rng(run + 1));
    const server = fakeServer(ch);
    let geo = new Set();
    let agg = new Set();
    let joinedNow = false;
    for (let step = 0; step < 60; step++) {
      const k = r();
      if (k < 0.3) {
        geo = pick();
        agg = r() < 0.3 ? pick() : new Set();
        sync.setWanted(geo, agg);
      } else if (k < 0.55 && ch.open().length) {
        const how = ["ok", "ok", "rate_limited", "timeout", "timeout_applied"][Math.floor(r() * 5)];
        server.answer(ch.open()[0], how);
      } else if (k < 0.62) {
        if (joinedNow) sync.onLeft();
        else sync.onJoined();
        joinedNow = !joinedNow;
      } else {
        clock.advance(Math.floor(r() * 3000));
      }
    }
    // quiesce: connected, every reply arrives
    if (!joinedNow) sync.onJoined();
    for (let i = 0; i < 50; i++) {
      for (const p of ch.open()) server.answer(p, "ok");
      clock.advance(S.BACKOFF_MAX_MS + 2 * S.SAFETY_RESYNC_MS);
    }
    for (const p of ch.open()) server.answer(p, "ok");
    assert.deepEqual(sorted(server.held.geo), sorted(geo), `run ${run}: server geo diverged`);
    assert.deepEqual(sorted(server.held.agg), sorted(agg), `run ${run}: server agg diverged`);
  }
});

// ===== resync: the server said our role changed — same wish, fresh sync =====

test("resync sends the SAME wish again (setWanted would see no change and send nothing)", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set("x"));
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});
  const before = ch.pushes.length;

  sync.resync();
  assert.equal(ch.pushes.length, before + 1);
  assert.deepEqual(ch.last().payload, { geo: ["a"], agg: ["x"] });
});

test("resync while a sync is in flight → exactly ONE follow-up, after the reply", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  const inFlight = ch.last();

  sync.resync();
  sync.resync();
  assert.equal(ch.open().length, 1, "a second sync went out while one was in flight");
  ch.reply(inFlight, "ok", {});
  assert.equal(ch.open().length, 1);
  assert.deepEqual(ch.last().payload.geo, ["a"]);
});

test("resync before joining sends nothing (the join will)", () => {
  const { ch, sync } = setup();
  sync.resync();
  assert.equal(ch.pushes.length, 0);
});

// find the nearest (nearby.js) decides "nobody nearby yet" only once the
// server has answered for the whole view — never on a half-loaded map
test("settled: only once the server has answered for exactly what's wanted, nothing on its way", () => {
  const { clock, ch, sync } = setup();
  assert.equal(sync.settled(), false, "not joined");
  sync.onJoined();
  assert.equal(sync.settled(), false, "the join's sync in flight");
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true, "nothing wanted, nothing held");

  sync.setWanted(set("a", "b"), set());
  assert.equal(sync.settled(), false, "a change waiting to settle");
  clock.advance(S.SETTLE_MS);
  assert.equal(sync.settled(), false, "in flight");
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true, "answered");

  // a change while one is in flight: not settled at that reply — only at the follow-up's
  sync.setWanted(set("c"), set());
  clock.advance(S.SETTLE_MS);
  const first = ch.last();
  sync.setWanted(set("d"), set("x"));
  clock.advance(S.SETTLE_MS);
  ch.reply(first, "ok", {});
  assert.equal(sync.settled(), false, "the follow-up is on its way");
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true);

  // a role change's resync: in flight again until answered
  sync.resync();
  assert.equal(sync.settled(), false);
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true);
});

test("settled: never while a failed sync waits to be retried, nor after the channel's gone", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "timeout");
  assert.equal(sync.settled(), false, "a timeout: retry pending");
  clock.advance(60000);
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true);
  sync.onLeft();
  assert.equal(sync.settled(), false, "left");
});

// ---- the live connection as the person sees it (createConnWatch) ----
// "Reconnecting…" only once it has been down LOST_AFTER_MS: a reload's
// hand-over or a blip of a second never flashes it (owner, 2026-10-30)
function connWatch() {
  const clock = manualClock();
  const changes = [];
  const w = S.createConnWatch({
    onChange: (lost) => changes.push(lost),
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });
  return { w, clock, changes };
}

test("connection: down for LOST_AFTER_MS → lost, once; back up → not lost, once", () => {
  const { w, clock, changes } = connWatch();
  w.up();
  assert.equal(w.lost(), false);
  w.down();
  clock.advance(S.LOST_AFTER_MS - 1);
  assert.equal(w.lost(), false, "not yet");
  clock.advance(1);
  assert.equal(w.lost(), true);
  w.down(); // Phoenix reports every failed retry: still one change
  clock.advance(S.LOST_AFTER_MS * 3);
  assert.deepEqual(changes, [true]);
  w.up();
  assert.equal(w.lost(), false);
  assert.deepEqual(changes, [true, false]);
});

test("connection: a blip shorter than LOST_AFTER_MS never shows", () => {
  const { w, clock, changes } = connWatch();
  w.up();
  w.down();
  clock.advance(S.LOST_AFTER_MS - 1);
  w.up();
  clock.advance(S.LOST_AFTER_MS * 2);
  assert.equal(w.lost(), false);
  assert.deepEqual(changes, []);
});

test("connection: up while up says nothing; LOST_AFTER_MS is a couple of seconds", () => {
  const { w, changes } = connWatch();
  w.up();
  w.up();
  assert.deepEqual(changes, []);
  assert.ok(S.LOST_AFTER_MS >= 1000 && S.LOST_AFTER_MS <= 5000);
});

// find the nearest waits on settled() and stops on refused(): "slow down"
// (rate_limited — after a group's list asked for many names, say) must make
// it WAIT, never stop — and it carries on once the retry is answered
test("rate_limited: not settled (the search waits), not refused (the search doesn't end) — settled once the retry is answered", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a", "b"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "error", { reason: "rate_limited", retry_ms: 997 });
  assert.equal(sync.settled(), false, "slowed down: not answered yet — the search waits");
  assert.equal(sync.refused(), false, "slowed down: not refused — the search carries on");
  const asked = ch.pushes.length;
  clock.advance(2000);
  assert.ok(ch.pushes.length > asked, "asked again after the wait");
  assert.deepEqual(ch.last().payload.geo.slice().sort(), ["a", "b"], "the same view asked for again");
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true, "answered: settled");
  assert.equal(sync.refused(), false);
});

// find the nearest reads these: what the map wants right now (people one by
// one, or counts) — and a refusal is about the wish refused, forgotten on a
// rejoin
test("wantedGeoSize / wantedAggSize: what's wanted now; refused() back for the refused wish, forgotten on a rejoin", () => {
  const { clock, ch, sync } = setup();
  sync.setWanted(set("a", "b"), set("c"));
  assert.equal(sync.wantedGeoSize(), 2);
  assert.equal(sync.wantedAggSize(), 1);
  sync.onJoined();
  ch.reply(ch.last(), "error", { reason: "watch_limit" });
  assert.equal(sync.refused(), true);
  sync.setWanted(set("z"), set());
  assert.equal(sync.refused(), false, "another wish: not refused (yet)");
  sync.setWanted(set("a", "b"), set("c"));
  assert.equal(sync.refused(), true, "the refused wish again: refused");
  sync.onJoined();
  assert.equal(sync.refused(), false, "a rejoin: asked afresh");
  void clock;
});

// a sync the server DID handle, but whose reply came too late (timed out
// here): its snapshots are lost, and the retry asks for cells the server
// already holds — no snapshot again; parked cars there never showed (find
// the nearest: "nobody" with a car right there). So after a timeout the
// next sync asks for everything afresh (owner, 2026-11-10).
test("after a timed-out sync, the next one asks for fresh snapshots; once answered, no more", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  assert.ok(!ch.last().payload.fresh, "(a normal sync: not fresh)");
  ch.reply(ch.last(), "timeout");
  clock.advance(60000);
  const retry = ch.last();
  assert.equal(retry.payload.fresh, true, "the retry after a timeout asks afresh");
  assert.deepEqual(retry.payload.geo, ["a"]);
  ch.reply(retry, "ok", {});
  sync.setWanted(set("a", "b"), set());
  clock.advance(S.SETTLE_MS);
  assert.ok(!ch.last().payload.fresh, "answered: back to normal");
});

// drawn: only what the view wants NOW — a cell the server still holds but the
// view has left keeps its data (wantsGeo/wantsAgg) but isn't drawn
// (wantedGeoHas/wantedAggHas): never count hexes over the markers of a view
// zoomed in meanwhile, nor markers under the hexes of one zoomed out
test("wantedGeoHas / wantedAggHas: the view's wish now — a held cell the view left is still wanted for data, not for drawing", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set(), set("x"));
  clock.advance(S.SETTLE_MS);
  const p = ch.last();
  sync.setWanted(set("a"), set()); // zoomed in while the counts' sync was in flight
  ch.reply(p, "ok", { geo: [], agg: [{ cell: "x" }] });
  assert.equal(sync.wantsAgg("x"), true, "(its counts kept: the server holds it)");
  assert.equal(sync.wantedAggHas("x"), false, "but not drawn");
  assert.equal(sync.wantedGeoHas("a"), true);
});

// a timed-out sync the server DID handle: its live updates come in (the cell
// is wanted) and the app draws them — then the view leaves that cell. The
// app must take them off then, as for any cell the server held: after a
// timeout it treats what it sent as possibly held (owner, 2026-11-10)
test("a timed-out sync, then the view leaves its cell: that cell's people are dropped (no ghosts off screen)", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set("x"));
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "timeout");
  sync.setWanted(set("b"), set());
  clock.advance(60000);
  ch.reply(ch.last(), "ok", {});
  assert.ok(dropped.geo.includes("a"), `a dropped: ${JSON.stringify(dropped)}`);
  assert.ok(dropped.agg.includes("x"), `x dropped: ${JSON.stringify(dropped)}`);
  assert.equal(sync.wantsGeo("a"), false);
});

// a sync sent before a reconnect times out AFTER it (its timer still runs):
// the new connection's own sync is untouched — still in flight, no extra
// send, still settled once answered
test("a timeout left over from before a rejoin changes nothing on the new connection", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  const old = ch.last();
  sync.onJoined(); // the socket dropped and came back
  const fresh = ch.last();
  assert.notEqual(fresh, old);
  ch.reply(fresh, "ok", {});
  assert.equal(sync.settled(), true, "(answered on the new connection)");
  const pushes = ch.pushes.length;
  ch.reply(old, "timeout");
  clock.advance(30000);
  assert.equal(sync.settled(), true, "still settled");
  assert.equal(ch.pushes.length, pushes, "no extra send");
});

test("a fresh retry refused ('slow down'): the next still asks fresh — until one is answered", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "timeout");
  clock.advance(60000);
  assert.equal(ch.last().payload.fresh, true);
  ch.reply(ch.last(), "error", { reason: "rate_limited", retry_ms: 500 });
  clock.advance(2000);
  assert.equal(ch.last().payload.fresh, true, "refused: still fresh");
});

// (the rest of the timeout/rejoin edges — owner, 2026-11-10)
const timedOutOnA = () => {
  const t = setup();
  t.sync.onJoined();
  t.ch.reply(t.ch.last(), "ok", {});
  t.sync.setWanted(set("a"), set());
  t.clock.advance(S.SETTLE_MS);
  return { ...t, first: t.ch.last() };
};

test("a stale ok or refusal from before a rejoin changes nothing on the new connection", () => {
  for (const [status, data] of [["ok", { geo: [{ cell: "a", drivers: [] }] }], ["error", { reason: "watch_limit" }]]) {
    const { ch, sync, snapshots, first } = timedOutOnA();
    sync.onJoined();
    const before = snapshots.length;
    ch.reply(first, status, data);
    assert.equal(snapshots.length, before, `${status}: no snapshot from the old connection`);
    assert.equal(sync.settled(), false, `${status}: the new sync is still unanswered`);
    assert.equal(sync.refused(), false, `${status}: not refused`);
  }
});

test("a timeout while disconnected: the rejoin drops what's no longer wanted and sends once, not fresh", () => {
  const { ch, sync, dropped, first } = timedOutOnA();
  sync.onLeft();
  ch.reply(first, "timeout");
  sync.setWanted(set("b"), set());
  const pushes = ch.pushes.length;
  sync.onJoined();
  assert.ok(dropped.geo.includes("a"), JSON.stringify(dropped));
  assert.equal(ch.pushes.length, pushes + 1, "exactly one sync after the join");
  assert.ok(!ch.last().payload.fresh, "a new channel needs no fresh flag");
  assert.deepEqual(ch.last().payload.geo, ["b"]);
});

test("a rejoin clears the fresh flag", () => {
  const { ch, sync, first } = timedOutOnA();
  ch.reply(first, "timeout");
  sync.onJoined();
  assert.ok(!ch.last().payload.fresh);
});

test("settled() across a timeout: not until the retry is answered", () => {
  const { clock, ch, sync, first } = timedOutOnA();
  ch.reply(first, "timeout");
  assert.equal(sync.settled(), false, "timed out: not settled");
  clock.advance(60000);
  assert.equal(sync.settled(), false, "retry in flight: not settled");
  ch.reply(ch.last(), "ok", {});
  assert.equal(sync.settled(), true, "answered: settled");
});

test("a fresh retry refused for good: refused, not settled; a new wish still asks fresh", () => {
  const { clock, ch, sync, first } = timedOutOnA();
  ch.reply(first, "timeout");
  clock.advance(60000);
  ch.reply(ch.last(), "error", { reason: "watch_limit" });
  assert.equal(sync.refused(), true);
  assert.equal(sync.settled(), false);
  sync.setWanted(set("c"), set());
  clock.advance(S.SETTLE_MS);
  assert.equal(ch.last().payload.fresh, true, "the snapshots are still owed");
});

// a client stuck timing out (a slow server) never floods it: retries follow
// the backoff (1 s → 30 s), each asking fresh; one answer ends it
test("stuck timing out for 5 minutes: retries bounded by the backoff, each fresh; one answer clears it", () => {
  const { clock, ch, sync } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a"), set());
  clock.advance(S.SETTLE_MS);
  const start = ch.pushes.length;
  for (let t = 0; t < 300; t++) {
    ch.open().forEach((p) => ch.reply(p, "timeout"));
    clock.advance(1000);
  }
  const sent = ch.pushes.slice(start);
  assert.ok(sent.length <= 20, `at most ~20 syncs in 5 minutes, got ${sent.length}`);
  assert.ok(sent.slice(1).every((p) => p.payload.fresh === true), "every retry fresh: " + JSON.stringify(sent.map((p) => [p.event, p.payload.fresh])));
  // (between retries: the next one is waited for, then answered)
  for (let t = 0; t < 60 && ch.open().length === 0; t++) clock.advance(1000);
  assert.equal(ch.open().length, 1, "the next retry out");
  ch.reply(ch.open()[0], "ok", {});
  sync.setWanted(set("a", "b"), set());
  clock.advance(S.SETTLE_MS);
  assert.ok(!ch.last().payload.fresh, "answered: back to normal");
});

// ===== model-based: random network vs a model server, invariants every step =====
// The server mirrors world_channel.ex reconcile/2: cap checked first
// (watch_limit, changes nothing), new cells subscribed, snapshots for new
// cells — or every wanted one when "fresh". (owner, 2026-11-10)
// Repro one seed: SYNC_SEED=n node --test test_js/sync.test.mjs

const MB_GEO = ["g1", "g2", "g3", "g4", "g5"];
const MB_AGG = ["a1", "a2", "a3"];
const MB_CAP = 5; // @max_watch, scaled down so over-cap wishes happen
const MB_OUTCOMES = ["ok", "ok", "ok", "rate_limited", "timeout_lost", "timeout_applied", "silent"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mbKey = (geo, agg) => [...geo].sort().join(",") + "|" + [...agg].sort().join(",");
const mbSame = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function modelServer(ch) {
  const m = {
    conn: 0,
    connected: false,
    geo: new Set(),
    agg: new Set(),
    subAt: new Map(), // "g:x"/"a:x" → step the server (last) subscribed it, this connection
    pendingRelease: new Set(), // released by an applied-but-timed-out sync, no ok since
    lastAnswer: new Map(), // wish key → last answer the client processed, this connection
    seen: 0,
    tag() {
      for (; m.seen < ch.pushes.length; m.seen++) {
        const p = ch.pushes[m.seen];
        if (!m.connected) m.pushedUnjoined = p;
        p.n = m.seen;
        p.conn = m.conn;
        p.silent = false;
      }
    },
    join() {
      m.conn++;
      m.connected = true;
      m.geo = new Set();
      m.agg = new Set();
      m.subAt = new Map();
      m.pendingRelease = new Set();
      m.lastAnswer = new Map();
    },
    leave() {
      m.connected = false;
    },
    current: (p) => p.conn === m.conn,
    apply(p, tick) {
      const fresh = p.payload.fresh === true;
      const snap = { geo: [], agg: [] };
      const released = [];
      const layers = [
        ["geo", "g:", (cell) => ({ cell, cars: [`car@${tick}`] })],
        ["agg", "a:", (cell) => ({ cell, count: tick })],
      ];
      for (const [layer, pre, item] of layers) {
        const want = new Set(p.payload[layer]);
        for (const c of m[layer])
          if (!want.has(c)) {
            m.subAt.delete(pre + c);
            released.push(pre + c);
          }
        for (const c of want) {
          const isNew = !m[layer].has(c);
          if (isNew) m.subAt.set(pre + c, tick);
          if (isNew || fresh) snap[layer].push(item(c));
        }
        m[layer] = want;
      }
      return { snap, released };
    },
  };
  return m;
}

function mbRun(seed, steps) {
  const r = mulberry32(seed);
  const { clock, ch, sync, dropped, snapshots } = setup(mulberry32(seed ^ 0x9e3779b9), { pushTimeoutMs: 10000 });
  const m = modelServer(ch);
  let wantG = new Set();
  let wantA = new Set();
  const data = new Map(); // "g:x" → step of the snapshot the client holds
  let dG = 0, dA = 0, nS = 0, tick = 0;
  const trace = [];

  const fail = (msg) =>
    assert.fail(
      `seed ${seed}, step ${tick}: ${msg}\n  last actions:\n    ${trace.join("\n    ")}\n` +
        `  repro: SYNC_SEED=${seed} node --test test_js/sync.test.mjs`
    );
  const held = (k) => (k[0] === "g" ? m.geo : m.agg).has(k.slice(2));
  const wanted = (k) => (k[0] === "g" ? wantG : wantA).has(k.slice(2));
  const wantKeys = () => [...[...wantG].map((c) => "g:" + c), ...[...wantA].map((c) => "a:" + c)];
  const over = () => wantG.size + wantA.size > MB_CAP;

  function absorb() {
    for (; dG < dropped.geo.length; dG++) data.delete("g:" + dropped.geo[dG]);
    for (; dA < dropped.agg.length; dA++) data.delete("a:" + dropped.agg[dA]);
    for (; nS < snapshots.length; nS++) {
      for (const s of snapshots[nS].geo) {
        if (s.cars && s.cars[0] === "stale") fail(`(3) snapshot from a pre-rejoin reply accepted: ${s.cell}`);
        data.set("g:" + s.cell, tick);
      }
      for (const s of snapshots[nS].agg) {
        if (s.count === -1) fail(`(3) snapshot from a pre-rejoin reply accepted: ${s.cell}`);
        data.set("a:" + s.cell, tick);
      }
    }
  }

  function check() {
    // (0) never a push while not joined: Phoenix would buffer it and send it
    // after the rejoin — an old wish applied first on the new connection
    if (m.pushedUnjoined) fail(`(0) push #${m.pushedUnjoined.n} while not joined`);

    // (1) at most one sync in flight per connection
    const perConn = new Map();
    for (const p of ch.open()) perConn.set(p.conn, (perConn.get(p.conn) || 0) + 1);
    for (const [c, n] of perConn) if (n > 1) fail(`(1) ${n} syncs in flight on connection ${c}`);

    // (2) settled ⇒ the server holds exactly the wish, with a snapshot since each subscription
    if (sync.settled()) {
      if (!m.connected) fail("(2) settled with no channel");
      if (!mbSame(m.geo, wantG) || !mbSame(m.agg, wantA))
        fail(`(2) settled, server holds ${mbKey(m.geo, m.agg)}, wanted ${mbKey(wantG, wantA)}`);
      for (const k of wantKeys()) {
        if (!data.has(k)) fail(`(2) settled but no snapshot for ${k}: its parked cars would never show`);
        if (data.get(k) < m.subAt.get(k))
          fail(`(2) settled but ${k}'s snapshot (step ${data.get(k)}) predates its subscription (step ${m.subAt.get(k)})`);
      }
    }

    // (3) no ghosts: once settled, the app has data only for what it wants
    // (mid-flight it can't know yet what the server let go — the reply says)
    if (sync.settled())
      for (const k of data.keys())
        if (!wanted(k))
        fail(`(3) ghost: settled, yet data for ${k}, not wanted (server holds ${mbKey(m.geo, m.agg)})`);

    // (3b) at EVERY step: data for a cell neither wanted nor (possibly)
    // held is a ghost for good — no cleanup ever walks it
    for (const k of data.keys()) {
      const c = k.slice(2);
      if (!(k[0] === "g" ? sync.wantsGeo(c) : sync.wantsAgg(c)))
        fail(`(3b) ghost for good: data for ${k}, neither wanted nor held`);
    }

    // (4) refused() only after a permanent refusal of THIS wish
    if (sync.refused()) {
      const a = m.lastAnswer.get(mbKey(wantG, wantA));
      if (a !== "watch_limit" || !over()) fail(`(4) refused() but the last answer to this wish was ${a}`);
    }
  }

  function act(what, fn) {
    tick++;
    trace.push(`${tick} t=${clock.now ? clock.now() : "?"} ${what}`);
    if (trace.length > 30) trace.shift();
    fn();
    m.tag();
    absorb();
    check();
  }

  function serve(p, how) {
    const rec = (a) => m.lastAnswer.set(mbKey(p.payload.geo, p.payload.agg), a);
    if (!m.current(p)) {
      if (how === "ok" || how === "timeout_applied")
        ch.reply(p, "ok", {
          geo: p.payload.geo.map((cell) => ({ cell, cars: ["stale"] })),
          agg: p.payload.agg.map((cell) => ({ cell, count: -1 })),
        });
      else if (how === "rate_limited") ch.reply(p, "error", { reason: "watch_limit" });
      else ch.reply(p, "timeout");
      return;
    }
    if (how === "silent") {
      p.silent = true;
      return;
    }
    if (!m.connected) {
      ch.reply(p, "timeout");
      rec("timeout");
      return;
    }
    const overCap = p.payload.geo.length + p.payload.agg.length > MB_CAP;
    if (how === "rate_limited") {
      ch.reply(p, "error", { reason: "rate_limited", retry_ms: 1 + Math.floor(r() * 2000) });
      rec("rate_limited");
    } else if (how === "timeout_lost" || (how === "timeout_applied" && overCap)) {
      ch.reply(p, "timeout");
      rec("timeout");
    } else if (overCap) {
      ch.reply(p, "error", { reason: "watch_limit" });
      rec("watch_limit");
    } else if (how === "timeout_applied") {
      for (const k of m.apply(p, tick).released) m.pendingRelease.add(k);
      ch.reply(p, "timeout");
      rec("timeout");
    } else {
      const { snap } = m.apply(p, tick);
      m.pendingRelease.clear();
      ch.reply(p, "ok", snap);
      rec("ok");
    }
  }

  function step() {
    const k = r();
    const open = ch.open().filter((p) => !(p.silent && m.current(p)));
    if (k < 0.15) {
      const g = new Set(MB_GEO.filter(() => r() < 0.35));
      const a = new Set(MB_AGG.filter(() => r() < 0.35));
      act(`setWanted ${mbKey(g, a)}`, () => {
        wantG = g;
        wantA = a;
        sync.setWanted(g, a);
      });
    } else if (k < 0.55 && open.length) {
      const p = open[Math.floor(r() * open.length)];
      const how = MB_OUTCOMES[Math.floor(r() * MB_OUTCOMES.length)];
      act(`#${p.n} ${JSON.stringify(p.payload)} conn ${p.conn}/${m.conn} → ${how}`, () => serve(p, how));
    } else if (k < 0.6) {
      if (m.connected)
        act("onLeft", () => {
          m.leave();
          sync.onLeft();
        });
      else
        act("onJoined", () => {
          m.join();
          sync.onJoined();
        });
    } else if (k < 0.62) {
      act("resync", () => sync.resync());
    } else if (k < 0.63 && m.connected) {
      // the role changed: the server drops every topic (no reply); the app
      // clears that layer and asks for its wish again
      act("role ping", () => {
        m.geo = new Set();
        m.agg = new Set();
        m.subAt.clear();
        data.clear();
        sync.resync();
      });
    } else if (k < 0.66 && m.connected && m.geo.size + m.agg.size > 0) {
      // a live update for a cell the server holds: the app must take it
      const held = [...[...m.geo].map((c) => "g:" + c), ...[...m.agg].map((c) => "a:" + c)];
      const key = held[Math.floor(r() * held.length)];
      const c = key.slice(2);
      act(`live ${key}`, () => {
        const ok = key[0] === "g" ? sync.wantsGeo(c) : sync.wantsAgg(c);
        if (!ok) fail(`(6) the server holds ${key} and sends its update: the app ignores it`);
        if (!data.has(key)) data.set(key, -Infinity); // live data, no snapshot behind it
      });
    } else {
      const ms = r() < 0.85 ? Math.floor(r() * 400) : Math.floor(r() * 40000);
      act(`+${ms}ms`, () => clock.advance(ms));
    }
  }

  // (5) a perfect network: settled (or, over the cap, refused) within 40 s
  function calm() {
    if (!m.connected)
      act("calm: onJoined", () => {
        m.join();
        sync.onJoined();
      });
    for (const p of ch.open())
      if (p.silent && m.current(p))
        act(`calm: #${p.n} push timer → timeout`, () => {
          ch.reply(p, "timeout");
          m.lastAnswer.set(mbKey(p.payload.geo, p.payload.agg), "timeout");
        });
    const done = () => (over() ? sync.refused() : sync.settled());
    for (let round = 0; round < 80 && !done(); round++) {
      for (const p of ch.open()) act(`calm: #${p.n} → ok`, () => serve(p, "ok"));
      if (!done()) act("calm: +500ms", () => clock.advance(500));
    }
    if (!done()) fail(`(5) a perfect network for 40 s and still not ${over() ? "refused" : "settled"}`);
  }

  for (let i = 1; i <= steps; i++) {
    step();
    if (i % 250 === 0) calm();
  }
}

test("model-based: random network vs a model server — invariants after every step", () => {
  const seeds = process.env.SYNC_SEED
    ? [Number(process.env.SYNC_SEED)]
    : Array.from({ length: Number(process.env.SYNC_SEEDS || 30) }, (_, i) => i + 1 + Number(process.env.SYNC_SEED_BASE || 0));
  for (const seed of seeds) mbRun(seed, 2000);
});

// mutation kill: what's possibly held after a timeout is what was SENT —
// not what's wanted by the time it times out (the view moved meanwhile)
test("a timed-out sync whose view moved while in flight: the SENT cells are the ones dropped later", () => {
  const t = setup();
  t.sync.onJoined();
  t.ch.reply(t.ch.last(), "ok", {});
  t.sync.setWanted(set("a"), set("x"));
  t.clock.advance(S.SETTLE_MS);
  const first = t.ch.last();
  t.sync.setWanted(set("b"), set()); // moved while in flight
  t.ch.reply(first, "timeout");
  t.clock.advance(60000);
  t.ch.open().forEach((p) => t.ch.reply(p, "ok", {}));
  assert.ok(t.dropped.geo.includes("a"), JSON.stringify(t.dropped));
  assert.ok(t.dropped.agg.includes("x"), JSON.stringify(t.dropped));
});

// a kept cell (the server let it go at a rejoin, still wanted) whose new
// request is refused for GOOD: nobody will ever send it — its old data
// goes, never drawn stale for good (owner, 2026-11-10)
test("kept cells, then the new connection's request refused for good: their old data dropped", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("g1"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", { geo: [{ cell: "g1", drivers: [] }] });
  sync.onLeft();
  sync.onJoined(); // g1 kept: still wanted, the new connection holds nothing
  ch.reply(ch.last(), "error", { reason: "watch_limit" });
  assert.ok(dropped.geo.includes("g1"), JSON.stringify(dropped));
});

test("a kept cell carried over a rejoin, held again, then left: dropped exactly once", () => {
  const { clock, ch, sync, dropped } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("g1"), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", { geo: [{ cell: "g1", drivers: [] }] });
  sync.onLeft();
  sync.onJoined();
  ch.reply(ch.last(), "ok", { geo: [{ cell: "g1", drivers: [] }] }); // held again
  sync.setWanted(set(), set());
  clock.advance(S.SETTLE_MS);
  ch.reply(ch.last(), "ok", {});
  assert.deepEqual(dropped.geo.filter((c) => c === "g1"), ["g1"], JSON.stringify(dropped));
});
