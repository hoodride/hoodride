// The found watch (HoodNearby.watchLook — app.js stillSeen's rule), checked
// look by look against a reference model of the owner's rules, over random
// event sequences (owner, 2026-11-10):
//   - gone → look again OUTWARD after 5 s, backing off to 60 s ±20%;
//   - the back-off resets after a whole minute in sight without a break
//     (broken by a panel, a message, the background, the person gone, or a
//     gap of more than 3 s between looks);
//   - coming back to the app NEVER searches at once: the wait for someone
//     already gone restarts from the return (a gap alone keeps the count);
//   - the map never zooms in by itself.
// Replay one seed: SEED=<n> node --test test_js/foundwatch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("../priv/static/nearby.js");

const GAP_MS = 3000; // app.js NEAR_LOOK_GAP_MS
const SETTLED_MS = 60000; // app.js NEAR_SETTLED_MS

function prng(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BASES = [5000, 10000, 20000, 40000, 60000];
const base = (k) => BASES[Math.min(k, 4)];
const since = (a, b) => Math.max(b.p - a.p, b.d - a.d);
const START_Z = 16, WIDEST_Z = 11, ALL = N.zoomSteps(START_Z, WIDEST_Z, 0.5);
const near = (x, y) => Math.abs(x - y) < 1e-6;

test("researchWait = the rule's table, ±20%, for random n and rand", () => {
  const r = prng(1);
  for (let i = 0; i < 20000; i++) {
    const n = Math.floor(r() * 12), x = r();
    assert.ok(near(N.researchWait(n, x), base(n) * (0.8 + 0.4 * x)));
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => N.researchWait(n, 0.5)), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test("a look-again's steps never zoom in — from anywhere, wider than the widest included", () => {
  const r = prng(2);
  for (let i = 0; i < 5000; i++) {
    const s = 14 + r() * 4, w = s - r() * 6, from = r() < 0.2 ? w - r() * 5 : w + r() * (s - w);
    for (const z of N.stepsFrom(N.zoomSteps(s, w, 0.5), from)) assert.ok(z <= from + 1e-6, `${z} > ${from}`);
  }
  assert.deepEqual(N.stepsFrom(ALL, WIDEST_Z - 1), [], "wider than the widest: no step at all");
});

// the code under test
const sut = (rand) => {
  let w;
  return {
    start(k) {
      w = { goneAt: null, seenAt: null, lookedAt: null, wait: N.researchWait(k, rand()) };
    },
    look(now, e, k) {
      const r = N.watchLook(w, k, now, { gapMs: GAP_MS, settledMs: SETTLED_MS, stop: false, refused: false, hidden: e.hidden, covered: e.panel, ready: e.ready, message: e.message, inSight: () => e.inSight }, rand);
      w = r.w;
      return { act: r.act, k: r.researches };
    },
    wait: () => w.wait,
  };
};

// the owner's rules, stated directly
const model = (rand) => {
  let gone, clean, last, wait, away;
  return {
    start(k) {
      gone = clean = last = null;
      away = false;
      wait = base(k) * (0.8 + 0.4 * rand());
    },
    look(now, e, k) {
      const gap = !!last && since(last, now) > GAP_MS;
      if (gap) clean = null; // a gap > 3 s breaks the minute
      last = now;
      if (e.hidden) {
        clean = null; // background: minute broken
        away = true;
        return { act: "none", k };
      }
      if (away && gone) gone = now; // back from the background: the wait starts again
      away = false;
      if (e.panel) {
        clean = gone = null;
        return { act: "none", k };
      }
      if (!e.ready) return { act: "none", k }; // a resync breaks nothing
      if (e.message) {
        clean = gone = null;
        return { act: "none", k };
      }
      if (e.inSight) {
        gone = null;
        clean = clean || now;
        if (k && since(clean, now) >= SETTLED_MS) {
          k = 0;
          wait = base(0) * (0.8 + 0.4 * rand());
        }
        return { act: "none", k };
      }
      clean = null;
      gone = gone || now;
      return since(gone, now) >= wait ? { act: "relook", k: k + 1 } : { act: "none", k };
    },
    wait: () => wait,
  };
};

const moved = (d, looking, outward, active) => (!active || d <= 500 ? null : looking && !outward ? "fresh" : "outward");

function simulate(seed, make, n = 800) {
  const sc = prng(seed), impl = make(prng(seed ^ 0x5bd1e995));
  const now = { p: 0, d: 1.7e12 }, e = { inSight: true, panel: false, message: false, hidden: false, ready: true };
  let k = 0, mode = "idle", zoom = START_Z, pos = 0, at = 0, search = null, returned = false;
  const tr = [];
  const log = (ev, x = {}) => tr.push({ ev, t: { ...now }, k, zoom, wait: mode === "watch" ? impl.wait() : null, env: { ...e }, returned, ...x });
  const startSearch = (outward, cause) => {
    const steps = outward ? N.stepsFrom(ALL, zoom) : ALL;
    search = { outward, steps, found: steps.length && sc() < 0.85 ? Math.floor(sc() * steps.length) : -1, left: 1 + Math.floor(sc() * 4) };
    log("search", { outward, steps, from: zoom, cause });
    mode = "search";
    at = pos;
  };
  const watch = () => {
    mode = "watch";
    impl.start(k);
    log("watch");
  };
  startSearch(false, "tap");
  for (let i = 0; i < n; i++) {
    const r = sc();
    if (r < 0.1) e.inSight = !e.inSight;
    else if (r < 0.14) e.panel = !e.panel;
    else if (r < 0.17) e.message = !e.message;
    else if (r < 0.2) {
      e.hidden = !e.hidden;
      returned = !e.hidden;
      log(e.hidden ? "hide" : "show");
    } else if (r < 0.23) e.ready = !e.ready;
    else if (r < 0.26) {
      pos += (sc() - 0.3) * 1500;
      const a = moved(Math.abs(pos - at), mode === "search", !!search?.outward, mode !== "idle");
      if (a) {
        k = 0;
        log("move", { a });
        startSearch(a === "outward", a);
      }
    } else if (r < 0.27) {
      k = 0;
      log("tap");
      startSearch(false, "tap");
    }
    const g = sc();
    if (g < 0.85) {
      now.p += 1000;
      now.d += 1000;
    } else if (g < 0.95) {
      const dt = 1000 + sc() * 4000;
      now.p += dt;
      now.d += dt;
    } else if (g < 0.98) now.d += 3000 + sc() * 120000; // asleep: the steady clock stopped
    else {
      now.p += 1000;
      now.d -= sc() * 3.6e6; // the wall clock set back
    }
    if (mode === "search") {
      if (--search.left === 0) {
        const s = search;
        search = null;
        zoom = !s.steps.length ? zoom : s.found >= 0 ? s.steps[s.found] : s.steps.at(-1);
        log("searched");
        if (s.found >= 0) watch();
        else mode = "nobody";
      }
    } else if (mode === "nobody") {
      if (e.inSight && !e.hidden && !e.panel) watch();
    } else if (mode === "watch") {
      const was = k, res = impl.look({ ...now }, e, k);
      k = res.k;
      log("look", { act: res.act, was });
      if (res.act === "relook") startSearch(true, "relook");
    }
    if (mode !== "search") returned = false;
  }
  return tr;
}

function check(tr) {
  let kw, chain = 0, prev = null, run = null, gone = null, away = false, lastZoom = START_Z, cause;
  for (const x of tr) {
    if (x.ev === "tap" || x.ev === "move") chain = 0;
    if (x.ev === "search") {
      cause = x.cause;
      if (x.outward) for (const z of x.steps) assert.ok(z <= x.from + 1e-6, "zoomed in by itself");
    }
    if (x.ev === "searched") {
      if (x.zoom > lastZoom) assert.ok(cause === "tap" || cause === "fresh", "a zoom-in not from a tap");
      lastZoom = x.zoom;
    }
    if (x.ev === "watch") {
      kw = x.k;
      assert.equal(kw, chain, "back-off = looks-again since the last reset");
      prev = run = gone = null;
      away = false;
    }
    if (x.ev !== "look") continue;
    assert.ok(x.wait >= 0.8 * base(kw) - 1e-6 && x.wait <= 1.2 * base(kw) + 1e-6, "wait within jitter");
    const e = x.env;
    const gap = !!prev && since(prev, x.t) > GAP_MS;
    if (gap) run = null;
    prev = x.t;
    let fresh = false;
    if (e.hidden) {
      run = null;
      away = true;
    } else {
      if (away && gone) {
        gone = x.t;
        fresh = true;
      }
      away = false;
      if (e.panel) run = gone = null;
      else if (e.ready) {
        if (e.message) run = gone = null;
        else if (e.inSight) {
          gone = null;
          run = run || x.t;
        } else {
          run = null;
          gone = gone || x.t;
        }
      }
    }
    const minute = !!run && since(run, x.t) >= SETTLED_MS;
    if (x.act !== "relook") {
      assert.equal(x.k, x.was > 0 && minute ? 0 : x.was, "reset iff a clean minute");
      if (x.was > 0 && x.k === 0) {
        chain = 0;
        kw = 0;
      }
    }
    const due = !e.hidden && e.ready && !!gone && since(gone, x.t) >= x.wait;
    assert.equal(x.act === "relook", due, "looked again exactly when gone ≥ the wait");
    if (e.hidden) assert.notEqual(x.act, "relook", "searched from the background");
    // coming back (or the first look after a gap): never a search at once
    if (x.returned || fresh) assert.notEqual(x.act, "relook", "searched the moment the app came back");
    if (x.act === "relook") chain++;
  }
}

test("model-based: random sequences — the code matches the rule, look by look; never searches on coming back", () => {
  const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: Number(process.env.SEEDS || 300) }, (_, i) => i + 1);
  for (const seed of seeds) {
    const a = simulate(seed, sut), b = simulate(seed, model);
    assert.equal(a.length, b.length, `seed ${seed}`);
    a.forEach((x, i) =>
      assert.deepEqual(
        [x.ev, x.act, x.k, x.zoom, x.wait && Math.round(x.wait)],
        [b[i].ev, b[i].act, b[i].k, b[i].zoom, b[i].wait && Math.round(b[i].wait)],
        `seed ${seed} step ${i}`
      )
    );
    check(a);
    check(b);
  }
});

// the case behind the rule, by hand: gone before the app went to the
// background, its wait run out while away — coming back does NOT search
test("gone before going away, the wait ran out meanwhile: coming back starts the wait over — no search at once", () => {
  const rand = () => 0.5;
  let w = { goneAt: null, seenAt: null, lookedAt: null, wait: 5000 };
  const o = (extra) => ({ gapMs: GAP_MS, settledMs: SETTLED_MS, stop: false, refused: false, hidden: false, covered: false, ready: true, message: false, inSight: false, ...extra });
  const at = (s) => ({ p: s * 1000, d: 1.7e12 + s * 1000 });
  let r = N.watchLook(w, 0, at(0), o(), rand); // gone from now
  w = r.w;
  r = N.watchLook(w, 0, at(1), o({ hidden: true }), rand); // away
  w = r.w;
  r = N.watchLook(w, 0, at(2), o({ hidden: true }), rand);
  w = r.w;
  r = N.watchLook(w, 0, at(30), o(), rand); // back, 30 s later
  assert.equal(r.act, "none", "no search the moment it comes back");
  w = r.w;
  for (let s = 31; s < 35; s++) {
    r = N.watchLook(w, 0, at(s), o(), rand);
    assert.equal(r.act, "none", `still waiting at ${s}`);
    w = r.w;
  }
  r = N.watchLook(w, 0, at(35), o(), rand);
  assert.equal(r.act, "relook", "the full 5 s after coming back: looks again");
});

// each stored time is its own copy: shifting one (as the journeys do to fake
// "seen a minute ago") never moves another — a shared object made "last
// looked" jump with it: a fake gap, the minute in sight reset
test("watchLook stores its own copy of each time — never one object shared", () => {
  const o = { gapMs: GAP_MS, settledMs: SETTLED_MS, stop: false, refused: false, hidden: false, covered: false, ready: true, message: false, inSight: true };
  const now = { p: 1000, d: 1.7e12 };
  const r = N.watchLook({ goneAt: null, seenAt: null, lookedAt: null, wait: 5000 }, 1, now, o, () => 0.5);
  assert.notEqual(r.w.seenAt, r.w.lookedAt, "seenAt and lookedAt are different objects");
  assert.notEqual(r.w.lookedAt, now, "not the caller's object either");
  r.w.seenAt.p -= 59000;
  assert.equal(r.w.lookedAt.p, 1000, "shifting seenAt leaves lookedAt alone");
});
