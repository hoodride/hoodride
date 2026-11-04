// Node tests for priv/static/viewport.js — the exact file the browser runs,
// against the exact pinned h3-js bundle the browser loads.
// Run: node --test test_js/   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const V = require("../priv/static/viewport.js");

const RUNGS = [8, 7, 5]; // app.js: H3_RES then AGG_RESES
const BUDGET = 110; // app.js: MAX_WATCHED_CELLS
const OVERLAP = h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping;
const NYC = { lat: 40.7154, lng: -74.0086 };
const PHONE = { w: 390, h: 844 };
const DESKTOP = { w: 1348, h: 851 };

// the rect a flat, north-up MapLibre map shows (512-px tiles)
function screenAt({ lat, lng }, zoom, size) {
  const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  const dLat = ((size.h / 2) * mpp) / 111320;
  const dLng = ((size.w / 2) * mpp) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { n: lat + dLat, s: lat - dLat, e: lng + dLng, w: lng - dLng };
}

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// H3's exact answer: every cell touching the (real-world) rect
function exactCells(rect, res) {
  const parts = [];
  // ground truth is computed per 360°-normalised piece so it is independent
  // of the code under test
  const k = Math.round((rect.e + rect.w) / 2 / 360);
  const w = rect.w - 360 * k;
  const e = rect.e - 360 * k;
  if (w < -180) parts.push([w + 360, 180], [-180, e]);
  else if (e > 180) parts.push([w, 180], [-180, e - 360]);
  else parts.push([w, e]);
  const out = new Set();
  for (const [pw, pe] of parts) {
    const poly = [[rect.n, pw], [rect.n, pe], [rect.s, pe], [rect.s, pw]];
    h3.polygonToCellsExperimental([poly], res, OVERLAP).forEach((c) => out.add(c));
  }
  return out;
}

function assertCovers(plan, screen, label) {
  assert.ok(plan, `${label}: no plan (empty map)`);
  const missing = [...exactCells(screen, plan.res)].filter((c) => !plan.cells.has(c));
  assert.equal(missing.length, 0, `${label}: ${missing.length} visible cells not watched`);
}

test("NYC at zoom 14 watches every cell touching the screen", () => {
  const screen = screenAt(NYC, 14, DESKTOP);
  const plan = V.planWatch(h3, screen, RUNGS, BUDGET);
  assertCovers(plan, screen, "NYC z14");
  assert.equal(plan.res, 8);
});

test("a wrapped world copy (lng −434 / 286) watches the same cells as lng −74", () => {
  const base = V.planWatch(h3, screenAt(NYC, 14, DESKTOP), RUNGS, BUDGET);
  for (const lng of [NYC.lng - 360, NYC.lng + 360, NYC.lng - 720]) {
    const plan = V.planWatch(h3, screenAt({ lat: NYC.lat, lng }, 14, DESKTOP), RUNGS, BUDGET);
    assert.ok(plan, `lng ${lng}: empty map`);
    assert.deepEqual([...plan.cells].sort(), [...base.cells].sort(), `lng ${lng}: different cells`);
  }
});

test("a screen straddling the 180° line watches cells on BOTH sides", () => {
  for (const lng of [179.99, -179.99, 539.99]) {
    const screen = screenAt({ lat: 52, lng }, 14, DESKTOP);
    const plan = V.planWatch(h3, screen, RUNGS, BUDGET);
    assertCovers(plan, screen, `straddle at ${lng}`);
    for (const pLng of [179.995, -179.995]) {
      assert.ok(plan.cells.has(h3.latLngToCell(52, pLng, plan.res)), `${lng}: side ${pLng} missing`);
    }
  }
});

test("street zoom is never empty and covers the whole screen (phone + desktop)", () => {
  const r = rng(11);
  for (let i = 0; i < 300; i++) {
    const c = { lat: 40.55 + r() * 0.35, lng: -74.25 + r() * 0.55 };
    const size = r() < 0.5 ? PHONE : DESKTOP;
    const screen = screenAt(c, 16 + r() * 2.5, size);
    const plan = V.planWatch(h3, screen, RUNGS, BUDGET);
    assertCovers(plan, screen, `street zoom #${i}`);
    assert.equal(plan.res, 8);
    // and a 21×21 grid of points on screen all sit in watched cells
    for (let a = 0; a <= 20; a++)
      for (let b = 0; b <= 20; b++) {
        const lat = screen.s + ((screen.n - screen.s) * a) / 20;
        const lng = screen.w + ((screen.e - screen.w) * b) / 20;
        assert.ok(plan.cells.has(h3.latLngToCell(lat, lng, 8)), `point not covered #${i}`);
      }
  }
});

test("the budget is never exceeded, at any zoom", () => {
  const r = rng(22);
  for (let i = 0; i < 1500; i++) {
    const screen = screenAt(
      { lat: 40.55 + r() * 0.35, lng: -74.25 + r() * 0.55 },
      3 + r() * 15.5,
      r() < 0.5 ? PHONE : DESKTOP
    );
    const plan = V.planWatch(h3, screen, RUNGS, BUDGET);
    if (plan) assert.ok(plan.cells.size <= BUDGET, `${plan.cells.size} cells watched`);
  }
});

// The app skips all work while the screen stays inside the watched rect at
// the same zoom. Replay thousands of moves the way app.js does and check
// every skip against H3's exact answer.
for (const [label, size, seed] of [
  ["desktop", DESKTOP, 4242],
  ["desktop, second seed", DESKTOP, 99991],
  ["phone", PHONE, 777],
]) {
  test(`random walk (${label}): skipped moves never miss a visible cell`, () => {
    const r = rng(seed);
    let center = { ...NYC };
    let zoom = 14;
    let plan = null;
    let planZoom = null;
    let skipped = 0;
    for (let i = 0; i < 2000; i++) {
      const k = r();
      const mpp = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
      const degPerPx = mpp / 111320;
      if (k < 0.6) {
        center = { lat: center.lat + (r() - 0.5) * 80 * degPerPx, lng: center.lng + (r() - 0.5) * 80 * degPerPx };
      } else if (k < 0.8) {
        center = { lat: center.lat + (r() - 0.5) * 1200 * degPerPx, lng: center.lng + (r() - 0.5) * 1200 * degPerPx };
      } else if (k < 0.95) {
        zoom = Math.max(9, Math.min(18.5, zoom + (r() - 0.5) * 3));
      } else {
        center = { lat: 40.55 + r() * 0.35, lng: -74.25 + r() * 0.55 };
        zoom = 9 + r() * 9.5;
      }
      const screen = screenAt(center, zoom, size);
      if (plan && planZoom === zoom && V.rectContains(plan.rect, screen)) {
        skipped++;
      } else {
        plan = V.planWatch(h3, screen, RUNGS, BUDGET);
        planZoom = zoom;
      }
      if (plan) {
        assert.ok(plan.cells.size <= BUDGET);
        assertCovers(plan, screen, `${label} move ${i}`);
      }
    }
    assert.ok(skipped > 1000, `only ${skipped} skips — the margin isn't working`);
  });
}

test("fallback: if H3's overlap mode throws, street zoom still finds the cells on screen", () => {
  const broken = Object.create(h3);
  broken.polygonToCellsExperimental = () => {
    throw new Error("simulated");
  };
  const r = rng(33);
  for (let i = 0; i < 100; i++) {
    const screen = screenAt({ lat: 40.55 + r() * 0.35, lng: -74.25 + r() * 0.55 }, 17 + r(), PHONE);
    const plan = V.planWatch(broken, screen, RUNGS, BUDGET);
    assert.ok(plan && plan.cells.size > 0, `fallback empty #${i}`);
    const c = { lat: (screen.n + screen.s) / 2, lng: (screen.e + screen.w) / 2 };
    assert.ok(plan.cells.has(h3.latLngToCell(c.lat, c.lng, 8)), `fallback misses the centre #${i}`);
  }
});

// Counts the work instead of timing it (wall-clock thresholds flake under
// load): the old freeze was listing millions of cells, so the assertion is
// that zoomed out NOTHING is listed at all.
test("zoomed out past the whole world: the floor, with zero cell listings", () => {
  let listings = 0;
  const counting = Object.create(h3);
  counting.polygonToCellsExperimental = (...a) => (listings++, h3.polygonToCellsExperimental(...a));
  counting.polygonToCells = (...a) => (listings++, h3.polygonToCells(...a));
  for (const zoom of [0, 1, 2, 5, 8]) {
    listings = 0;
    const plan = V.planWatch(counting, screenAt(NYC, zoom, DESKTOP), RUNGS, BUDGET);
    assert.equal(plan, null, `zoom ${zoom} should be the floor`);
    assert.equal(listings, 0, `zoom ${zoom} listed cells ${listings} times`);
  }
});
