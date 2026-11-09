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
function setup(random = () => 1) {
  const clock = manualClock();
  const ch = fakeChannel();
  const dropped = { geo: [], agg: [] };
  const snapshots = [];
  const sync = S.createWorldSync({
    push: ch.push,
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

test("snapshots are delivered only for cells still wanted", () => {
  const { clock, ch, sync, snapshots } = setup();
  sync.onJoined();
  ch.reply(ch.last(), "ok", {});
  sync.setWanted(set("a", "b"), set("x"));
  clock.advance(S.SETTLE_MS);
  const p = ch.last();
  sync.setWanted(set("b"), set()); // the view moved on while in flight
  ch.reply(p, "ok", { geo: [{ cell: "a" }, { cell: "b" }], agg: [{ cell: "x" }] });
  const s = snapshots[snapshots.length - 1];
  assert.deepEqual(s.geo.map((x) => x.cell), ["b"]);
  assert.deepEqual(s.agg, []);
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
