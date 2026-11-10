// Node tests for priv/static/nearby.js — find the nearest (owner,
// 2026-11-07): the exact file the browser runs, with the map's own
// planner (viewport.js) and the pinned h3-js bundle.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const V = require("../priv/static/viewport.js");
const N = require("../priv/static/nearby.js");

const RUNGS = [8, 7, 5]; // app.js: H3_RES then AGG_RESES
const BUDGET = 110; // app.js: MAX_WATCHED_CELLS
const NYC = { lat: 40.7154, lng: -74.0086 };
const PHONE = { w: 390, h: 844 };
const DESKTOP = { w: 1348, h: 851 };
// (step tests' covers: two simple boxes — a banner-sized one across the top,
// a band across the bottom — standing in for whatever covers the map; the
// box rule itself, with the app's real shapes: the in-sight tests below)
const COVERS = [
  { top: 0, bottom: 130, left: 0, right: PHONE.w },
  { top: PHONE.h - 120, bottom: PHONE.h, left: 0, right: PHONE.w },
];
const HALF = { x: 22, y: 22 };

const widest = (size, center = NYC) =>
  N.widestMarkerZoom({ viewport: V, h3, center, size, rungs: RUNGS, budget: BUDGET, maxZoom: 14 });
const markersAt = (center, z, size) => N.showsMarkers(V, h3, N.screenAt(center, z, size), RUNGS, BUDGET);
const km = (a, b) => N.metersBetween(a, b) / 1000;

test("screenAt: the whole world at zoom 0 on one 512-px tile; Web Mercator in between", () => {
  const r = N.screenAt({ lat: 0, lng: 0 }, 0, { w: 512, h: 512 });
  assert.ok(Math.abs(r.n - 85.0511) < 1e-3 && Math.abs(r.s + 85.0511) < 1e-3, JSON.stringify(r));
  assert.ok(Math.abs(r.e - 180) < 1e-9 && Math.abs(r.w + 180) < 1e-9);
  // north of the centre covers fewer degrees than south (Mercator), and
  // each zoom level halves the span
  const a = N.screenAt(NYC, 14, PHONE);
  const b = N.screenAt(NYC, 15, PHONE);
  assert.ok(a.n - NYC.lat < NYC.lat - a.s);
  assert.ok(Math.abs((a.e - a.w) / (b.e - b.w) - 2) < 1e-9);
  // zoom 14 on a phone: about 3 km top to bottom (INTENT_ZOOM's comment in app.js)
  const tall = km({ lat: a.s, lng: NYC.lng }, { lat: a.n, lng: NYC.lng });
  assert.ok(tall > 2.5 && tall < 3.5, `${tall} km`);
});

test("the widest zoom still shows people one by one — a hair wider shows counts", () => {
  for (const size of [PHONE, DESKTOP]) {
    for (const center of [NYC, { lat: 51.5072, lng: -0.1276 }, { lat: -33.8688, lng: 151.2093 }, { lat: 1.29, lng: 103.85 }]) {
      const z = widest(size, center);
      assert.ok(z < 14, `${JSON.stringify(center)} ${size.w}: ${z}`);
      assert.ok(markersAt(center, z, size), `not markers at ${z}`);
      assert.ok(!markersAt(center, z - 0.02, size), `still markers wider than ${z}`);
    }
  }
});

test("it's about the same ground on any screen: roughly 14 square miles (a phone: about 2½ × 5½ miles)", () => {
  for (const size of [PHONE, DESKTOP]) {
    const r = N.screenAt(NYC, widest(size), size);
    const w = km({ lat: NYC.lat, lng: r.w }, { lat: NYC.lat, lng: r.e });
    const h = km({ lat: r.s, lng: NYC.lng }, { lat: r.n, lng: NYC.lng });
    const sqmi = (w * h) / 2.59;
    assert.ok(sqmi > 10 && sqmi < 40, `${size.w}×${size.h}: ${w.toFixed(1)} × ${h.toFixed(1)} km, ${sqmi.toFixed(1)} sq mi`);
  }
});

test("a screen that can't show markers even at the usual zoom: stays at it (never wider)", () => {
  const huge = { w: 20000, h: 20000 };
  assert.equal(widest(huge), 14);
});

// someone `m` metres from NYC, `deg` degrees clockwise from north
function at(m, deg) {
  const d = m / 6371008.8;
  const b = (deg * Math.PI) / 180;
  const la = (NYC.lat * Math.PI) / 180;
  const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lng = (NYC.lng * Math.PI) / 180 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
  return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
}

// Step by step (owner, 2026-11-09): from the usual view out, half a level at
// a time, to the widest view that still shows people one by one; it stops
// at the first step where anyone is in sight (their whole marker, under no
// cover)
// and stays there — no zooming back in, so the others around show too.
const steps = (size = PHONE) => N.zoomSteps(14, widest(size), 0.5);
const anyoneAt = (people, zoom, size = PHONE) =>
  N.anyoneAt({ me: NYC, people: people.map((pos) => ({ pos })), size, covers: COVERS, zoom, half: HALF });
// the step the search stops at: the first with anyone, else the last
const stopsAt = (people, size = PHONE) => {
  const zs = steps(size);
  return zs.find((z) => anyoneAt(people, z, size)) ?? null;
};

test("the steps: the usual view, then half a level wider each time, ending exactly at the widest", () => {
  for (const size of [PHONE, DESKTOP]) {
    const zs = steps(size);
    const w = widest(size);
    assert.equal(zs[0], 14);
    assert.equal(zs.at(-1), w);
    for (let i = 1; i < zs.length - 1; i++) assert.equal(zs[i], 14 - 0.5 * i);
    // the last step is never a sliver: at least half a step past the one
    // before (a tiny last step is one more wait for the server, for nothing)
    assert.ok(zs.at(-2) - w >= 0.25, JSON.stringify(zs));
    assert.ok(zs.every((z, i) => i === 0 || z < zs[i - 1]), "always wider");
  }
  // a phone: a few steps, not dozens (each waits for the server)
  assert.ok(steps(PHONE).length >= 3 && steps(PHONE).length <= 5, JSON.stringify(steps(PHONE)));
});

test("the steps when the widest is the usual view (a huge screen): just that one", () => {
  assert.deepEqual(N.zoomSteps(14, 14, 0.5), [14]);
});

test("the steps when the widest is just past a half step: no sliver step", () => {
  assert.deepEqual(N.zoomSteps(14, 12.995, 0.5), [14, 13.5, 12.995]);
  // a phone in New York: 12.47 is 0.03 past 12.5 — straight from 13
  assert.deepEqual(N.zoomSteps(14, 12.47, 0.5), [14, 13.5, 13, 12.47]);
  // exactly half a step past one: kept
  assert.deepEqual(N.zoomSteps(14, 12.25, 0.5), [14, 13.5, 13, 12.5, 12.25]);
});

test("someone close: found at the usual view — it stops there", () => {
  assert.equal(stopsAt([at(300, 90)]), 14);
});

test("someone a mile or so off: the first step that shows them, not a step wider", () => {
  const far = at(2500, 0); // about 1½ miles north
  const z = stopsAt([far]);
  assert.ok(z < 14 && z >= widest(PHONE), String(z));
  // in sight on that step…
  assert.equal(anyoneAt([far], z), true);
  // …and not on the step before (it would have stopped there)
  const zs = steps();
  assert.equal(anyoneAt([far], zs[zs.indexOf(z) - 1]), false);
});

test("it stops for whoever shows first — two people, the step showing either", () => {
  // east 1.5 km (a phone is narrow) and north 2 km: whichever fits first
  const east = at(1500, 90);
  const north = at(2000, 0);
  const first = Math.max(...[east, north].map((p) => stopsAt([p])));
  assert.equal(stopsAt([east, north]), first);
});

test("under the banner or the buttons doesn't count: on the screen, but under a cover", () => {
  const r = N.screenAt(NYC, 14, PHONE);
  // just inside the screen's top edge, under the banner
  const hidden = { lat: NYC.lat + (r.n - NYC.lat) * 0.95, lng: NYC.lng };
  assert.ok(hidden.lat < r.n, "(on the screen itself)");
  assert.equal(anyoneAt([hidden], 14), false);
  // a step wider, they're in the clear
  assert.ok(stopsAt([hidden]) < 14);
});

test("nobody, or only people beyond the widest view: no step shows anyone", () => {
  assert.equal(stopsAt([]), null);
  assert.equal(stopsAt([at(9000, 90), at(12000, 180)]), null);
});

test("who you're looking for: a rider with ✋ up — cars; a driver online — ✋; else nobody", () => {
  const L = (s) => N.lookingFor({ mode: "rider", handRaised: false, online: false, ride: null, ...s });
  assert.equal(L({ handRaised: true }), "driver");
  assert.equal(L({}), null, "a rider browsing: the locate button as before");
  assert.equal(L({ mode: "driver", online: true }), "hand");
  assert.equal(L({ mode: "driver" }), null, "offline");
  assert.equal(L({ handRaised: true, ride: { status: "requested" } }), null, "in a ride");
  assert.equal(L({ mode: "driver", online: true, ride: { status: "connected" } }), null);
});


// "If you can see it on the map, it counts" (owner, 2026-11-09 — the box
// rule): everything over the map is a box, measured where it is; each person
// is the box of their marker (44×44; a group 74×44). They count when their
// WHOLE marker is on the screen and overlaps no cover. Touching an edge is
// fine; one pixel over isn't.
const ONE = { x: 22, y: 22 }; // a single marker's half-size
const GROUP = { x: 37, y: 22 }; // a group marker's
const cover = (top, bottom, left, right) => ({ top, bottom, left, right });
const sight = (pt, covers = [], half = ONE, size = PHONE) => N.inSight(pt, half, size, covers);

test("screenPoint: me in the middle; a spot at the screen's edge lands on that edge", () => {
  assert.deepEqual(N.screenPoint(NYC, NYC, 14, PHONE), { x: PHONE.w / 2, y: PHONE.h / 2 });
  const r = N.screenAt(NYC, 14, PHONE);
  const east = N.screenPoint(NYC, { lat: NYC.lat, lng: r.e }, 14, PHONE);
  const north = N.screenPoint(NYC, { lat: r.n, lng: NYC.lng }, 14, PHONE);
  assert.ok(Math.abs(east.x - PHONE.w) < 1e-6 && Math.abs(east.y - PHONE.h / 2) < 1e-6, JSON.stringify(east));
  assert.ok(Math.abs(north.y) < 1e-6 && Math.abs(north.x - PHONE.w / 2) < 1e-6, JSON.stringify(north));
  // a level wider: half as far from the middle
  const east13 = N.screenPoint(NYC, { lat: NYC.lat, lng: r.e }, 13, PHONE);
  assert.ok(Math.abs(east13.x - (PHONE.w / 2 + PHONE.w / 4)) < 1e-6);
});

test("in sight: the whole marker on the screen — touching an edge counts, one pixel over doesn't", () => {
  assert.equal(sight({ x: 22, y: 400 }), true, "touching the left edge");
  assert.equal(sight({ x: 21, y: 400 }), false, "a pixel over it");
  assert.equal(sight({ x: PHONE.w - 22, y: 400 }), true);
  assert.equal(sight({ x: PHONE.w - 21, y: 400 }), false);
  assert.equal(sight({ x: 200, y: 22 }), true);
  assert.equal(sight({ x: 200, y: 21 }), false);
  assert.equal(sight({ x: 200, y: PHONE.h - 22 }), true);
  assert.equal(sight({ x: 200, y: PHONE.h - 21 }), false);
});

test("in sight: overlapping a cover — even a corner of it — doesn't count; touching it does", () => {
  const banner = cover(62, 101, 16, 374);
  assert.equal(sight({ x: 200, y: 101 + 22 }, [banner]), true, "touching the banner's bottom");
  assert.equal(sight({ x: 200, y: 101 + 21 }, [banner]), false, "a pixel under it");
  // only the marker's corner under the banner's corner
  assert.equal(sight({ x: 374 + 21, y: 101 + 21 }, [banner], ONE, { w: 500, h: 844 }), false);
  assert.equal(sight({ x: 374 + 22, y: 101 + 21 }, [banner], ONE, { w: 500, h: 844 }), true, "beside it");
});

test("in sight: beside a cover counts — the box rule's point (the old strips ignored these)", () => {
  // the locate button: a 48 px box in the corner
  const locate = cover(PHONE.h - 144, PHONE.h - 96, 328, 376);
  assert.equal(sight({ x: 300, y: PHONE.h - 120 }, [locate]), true, "level with it, beside it");
  assert.equal(sight({ x: 340, y: PHONE.h - 120 }, [locate]), false, "under it");
  // a desktop's chat: 640 px, centred at the bottom
  const DESK = { w: 1280, h: 700 };
  const chat = cover(700 - 336, 700, 320, 960);
  assert.equal(sight({ x: 200, y: 600 }, [chat], ONE, DESK), true, "beside the chat");
  assert.equal(sight({ x: 640, y: 600 }, [chat], ONE, DESK), false, "under it");
});

test("in sight: the chat open past the middle (a shorter phone) — the top half still counts", () => {
  const chat = cover(400, PHONE.h, 0, PHONE.w);
  assert.ok(chat.top < PHONE.h / 2, "(it reaches past the middle)");
  assert.equal(sight({ x: 195, y: 300 }, [chat]), true, "above it");
  assert.equal(sight({ x: 195, y: PHONE.h / 2 }, [chat]), false, "where I am, under it");
});

test("in sight: a group marker is wider — a group a pixel too close to a cover doesn't count", () => {
  const card = cover(500, 800, 100, 290);
  assert.equal(sight({ x: 100 - 22, y: 600 }, [card], ONE), true, "one car touching the card's left");
  assert.equal(sight({ x: 100 - 22, y: 600 }, [card], GROUP), false, "a group there overlaps it");
  assert.equal(sight({ x: 100 - 37, y: 600 }, [card], GROUP), true);
});

test("anyoneAt: anyone among several — each with their own marker size; the hidden ones don't count", () => {
  const r = N.screenAt(NYC, 14, PHONE);
  // a spot `y` px from the screen's top, straight above or below me (Mercator)
  const atY = (y) => {
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const m = merc(r.n) + (merc(r.s) - merc(r.n)) * (y / PHONE.h);
    return { lat: (Math.atan(Math.sinh(m)) * 180) / Math.PI, lng: NYC.lng };
  };
  const banner = cover(62, 101, 16, 374);
  const bar = cover(PHONE.h - 68, PHONE.h - 10, 0, PHONE.w);
  const covers = [banner, bar];
  const at = (people) => N.anyoneAt({ me: NYC, people, size: PHONE, covers, zoom: 14, half: ONE });
  const underBanner = { pos: atY(110) };
  const underBar = { pos: atY(PHONE.h - 40) };
  const clear = { pos: atY(300) };
  assert.equal(at([underBanner, underBar]), false);
  assert.equal(at([underBanner, underBar, clear]), true);
  // their own size: a group just clear for one car but not for its width
  // each person's own marker size: beside a cover ending 23 px left of
  // them, one car is clear — a group (74 px wide) overlaps it
  const side = [cover(0, PHONE.h, 0, PHONE.w / 2 - 23)];
  const beside = (half) => N.anyoneAt({ me: NYC, people: [{ pos: atY(300), half }], size: PHONE, covers: side, zoom: 14, half: ONE });
  assert.equal(beside(ONE), true, "one car beside it");
  assert.equal(beside(GROUP), false, "a group there overlaps it");
  assert.equal(beside(undefined), true, "no size given: a single marker's");
  assert.equal(at([{ pos: atY(PHONE.h - 68 - 22), half: ONE }]), true, "one car touching the bar");
  assert.equal(at([{ pos: atY(PHONE.h - 68 - 21), half: ONE }]), false);
});

test("the old fixed numbers are gone: spots they got wrong, the box rule gets right", () => {
  const OLD = { top: 130, bottom: 120, left: 40, right: 40 };
  const oldSays = (pt) => pt.x >= OLD.left && pt.x <= PHONE.w - OLD.right && pt.y >= OLD.top && pt.y <= PHONE.h - OLD.bottom;
  const banner = cover(62, 101, 16, 374);
  const locate = cover(PHONE.h - 144, PHONE.h - 96, 328, 376);
  const covers = [banner, locate];
  for (const [pt, want] of [
    [{ x: 200, y: 125 }, true], // just clear below a one-line banner: old said no
    [{ x: 300, y: PHONE.h - 110 }, true], // beside the locate button, low: old said no
    [{ x: 340, y: PHONE.h - 160 }, false], // the marker's bottom under the locate button: old said yes
    [{ x: 30, y: 400 }, true], // near the side, wholly on screen: old said no
  ]) {
    assert.equal(sight(pt, covers), want, JSON.stringify(pt));
    assert.notEqual(oldSays(pt), want, `(the old numbers got ${JSON.stringify(pt)} wrong)`);
  }
});

test("broken data never counts as seen: a position that isn't a number, a missing size", () => {
  assert.equal(sight({ x: NaN, y: 400 }), false);
  assert.equal(sight({ x: 200, y: NaN }), false);
  assert.equal(sight({ x: 200, y: 400 }, [], { x: NaN, y: 22 }), false);
  assert.equal(sight({ x: 200, y: 400 }, [cover(NaN, NaN, NaN, NaN)]), false, "a cover that can't be measured: assume it covers");
  assert.equal(N.anyoneAt({ me: NYC, people: [{ pos: { lat: NaN, lng: NYC.lng } }], size: PHONE, covers: [], zoom: 14, half: ONE }), false);
  assert.equal(N.anyoneAt({ me: NYC, people: [{ pos: { lat: NYC.lat, lng: undefined } }], size: PHONE, covers: [], zoom: 14, half: ONE }), false);
});

test("screenPoint: known answers worked out by hand, not with the module's own maths", () => {
  // the whole world on one 512 px tile at zoom 0: its corner at the edge
  const W = { w: 512, h: 512 };
  // (179.9°, not 180°: 180° east and west are the same line)
  const c = N.screenPoint({ lat: 0, lng: 0 }, { lat: 85.0511287798, lng: 179.9 }, 0, W);
  assert.ok(Math.abs(c.x - (256 + (179.9 / 360) * 512)) < 1e-6 && Math.abs(c.y - 0) < 1e-3, JSON.stringify(c));
  // Oslo (59.91°N) at zoom 12.47, a spot 0.01° north and 0.02° west: the
  // textbook web-Mercator pixel, 256·2^z·(1 − ln(tan(π/4 + φ/2))/π), per 512 tile
  const me = { lat: 59.91, lng: 10.75 };
  const pos = { lat: 59.92, lng: 10.73 };
  const z = 12.47;
  const py = (lat) => 512 * 2 ** z * (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const px = (lng) => 512 * 2 ** z * ((lng + 180) / 360);
  const got = N.screenPoint(me, pos, z, PHONE);
  assert.ok(Math.abs(got.x - (PHONE.w / 2 + px(pos.lng) - px(me.lng))) < 1e-6, JSON.stringify(got));
  assert.ok(Math.abs(got.y - (PHONE.h / 2 + py(pos.lat) - py(me.lat))) < 1e-6, JSON.stringify(got));
  assert.ok(got.x < PHONE.w / 2 && got.y < PHONE.h / 2, "west is left, north is up");
  // a fractional zoom, south-west: half a level wider — 1/√2 as far
  const r = N.screenAt(NYC, 13.5, PHONE);
  const sw = N.screenPoint(NYC, { lat: NYC.lat, lng: r.w }, 13, PHONE);
  assert.ok(Math.abs(sw.x - (PHONE.w / 2 - PHONE.w / 2 / 2 ** 0.5)) < 1e-6, JSON.stringify(sw));
});

test("across the 180° line: someone 400 m away on the other side is beside you, not a world away", () => {
  const me = { lat: -16.8, lng: 179.998 };
  const pos = { lat: -16.8, lng: -179.998 }; // 0.004° east of me
  const got = N.screenPoint(me, pos, 14, PHONE);
  const want = PHONE.w / 2 + (0.004 / 360) * 512 * 2 ** 14;
  assert.ok(Math.abs(got.x - want) < 1e-3, JSON.stringify(got));
  assert.equal(N.anyoneAt({ me, people: [{ pos }], size: PHONE, covers: [], zoom: 14, half: ONE }), true);
  // and the other way
  const back = N.screenPoint(pos, me, 14, PHONE);
  assert.ok(Math.abs(back.x - (PHONE.w / 2 - (0.004 / 360) * 512 * 2 ** 14)) < 1e-3, JSON.stringify(back));
});

test("in sight: a group's height is its own (not its width) — and every side of a cover", () => {
  const banner = cover(62, 101, 16, 374);
  assert.equal(sight({ x: 200, y: 101 + 22 }, [banner], GROUP), true, "a group touching the banner's bottom");
  assert.equal(sight({ x: 200, y: 101 + 21 }, [banner], GROUP), false);
  const box = cover(300, 400, 100, 200);
  const W = { w: 500, h: 844 };
  for (const [pt, want, side] of [
    [{ x: 100 - 22, y: 350 }, true, "touching its left"],
    [{ x: 100 - 21, y: 350 }, false, "a pixel into its left"],
    [{ x: 200 + 22, y: 350 }, true, "touching its right"],
    [{ x: 200 + 21, y: 350 }, false, "a pixel into its right"],
    [{ x: 150, y: 300 - 22 }, true, "touching its top"],
    [{ x: 150, y: 300 - 21 }, false, "a pixel into its top"],
    [{ x: 150, y: 400 + 22 }, true, "touching its bottom"],
    [{ x: 150, y: 400 + 21 }, false, "a pixel into its bottom"],
    [{ x: 150, y: 350 }, false, "inside it"],
  ])
    assert.equal(sight(pt, [box], ONE, W), want, side);
});

test("in sight: odd boxes — partly off the screen, a cover holding the whole marker, a marker bigger than the screen", () => {
  const offTop = cover(-50, 30, -10, 400);
  assert.equal(sight({ x: 200, y: 30 + 21 }, [offTop]), false);
  assert.equal(sight({ x: 200, y: 30 + 22 }, [offTop]), true);
  assert.equal(sight({ x: 200, y: 400 }, [cover(0, PHONE.h, 0, PHONE.w)]), false, "a cover over everything");
  assert.equal(sight({ x: 20, y: 20 }, [], { x: 30, y: 30 }, { w: 40, h: 40 }), false, "bigger than the screen");
  // a cover of no width through the marker's middle still counts as covering
  // (the cautious side; nearCovers leaves those out before they get here)
  assert.equal(sight({ x: 200, y: 400 }, [cover(390, 410, 200, 200)]), false, "a zero-width line through it");
});

test("steps everywhere: a desktop, people due south and due west, a city far north", () => {
  const DESK = { w: 1280, h: 700 };
  const stop = (me, people, size) => {
    const zs = N.zoomSteps(14, widest(size, me), 0.5);
    return zs.find((z) => N.anyoneAt({ me, people: people.map((pos) => ({ pos })), size, covers: [], zoom: z, half: ONE })) ?? null;
  };
  // each: found at a middle step, and the step before shows them not
  for (const [me, deg, m, size] of [
    [NYC, 180, 2500, PHONE],
    [NYC, 270, 1500, PHONE], // a phone is narrow: 1.5 km fits its widest view
    [NYC, 0, 1800, DESK], // a desktop shows more blocks: its widest view is closer in
    [{ lat: 69.65, lng: 18.96 }, 0, 1800, PHONE], // Tromsø
  ]) {
    const at2 = (() => {
      const d = m / 6371008.8;
      const b = (deg * Math.PI) / 180;
      const la = (me.lat * Math.PI) / 180;
      const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lng = (me.lng * Math.PI) / 180 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
      return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
    })();
    const z = stop(me, [at2], size);
    assert.ok(z !== null && z < 14, `${deg}° ${m} m: ${z}`);
    const zs = N.zoomSteps(14, widest(size, me), 0.5);
    const before = zs[zs.indexOf(z) - 1];
    assert.equal(N.anyoneAt({ me, people: [{ pos: at2 }], size, covers: [], zoom: before, half: ONE }), false, `${deg}°: not a step sooner`);
  }
});

// A marker's reach from its middle, each side on its own (a group's "+N"
// badge pokes out of ONE corner: top-right; top-left right-to-left).
test("markerReach: a single marker — the same each way", () => {
  const el = { left: 100, right: 144, top: 200, bottom: 244 };
  assert.deepEqual(N.markerReach(el, []), { l: 22, r: 22, t: 22, b: 22 });
});

test("markerReach: a group with its +N badge top-right (8 px out) — only top and right reach further", () => {
  const el = { left: 100, right: 174, top: 200, bottom: 244 }; // 74×44
  const badge = { left: 174 + 8 - 30, right: 174 + 8, top: 200 - 8, bottom: 200 - 8 + 22 };
  assert.deepEqual(N.markerReach(el, [badge]), { l: 37, r: 45, t: 30, b: 22 });
  // right-to-left: the badge top-left
  const rtl = { left: 100 - 8, right: 100 - 8 + 30, top: 192, bottom: 214 };
  assert.deepEqual(N.markerReach(el, [rtl]), { l: 45, r: 37, t: 30, b: 22 });
  // an empty box (not laid out) changes nothing
  assert.deepEqual(N.markerReach(el, [{ left: 0, right: 0, top: 0, bottom: 0 }]), { l: 37, r: 37, t: 22, b: 22 });
});

test("in sight: each side its own reach — a group's badge-free side can touch what its badge side can't", () => {
  const reach = { l: 37, r: 45, t: 30, b: 22 };
  const W = { w: 500, h: 844 };
  // the screen's left edge: the badge-free side touching it counts
  assert.equal(sight({ x: 37, y: 400 }, [], reach, W), true);
  assert.equal(sight({ x: 36, y: 400 }, [], reach, W), false);
  // the right edge: the badge side needs 45
  assert.equal(sight({ x: 500 - 45, y: 400 }, [], reach, W), true);
  assert.equal(sight({ x: 500 - 44, y: 400 }, [], reach, W), false);
  // a cover below: only the bottom's 22; above: the badge's 30
  const below = cover(422, 500, 0, 500);
  assert.equal(sight({ x: 200, y: 400 }, [below], reach, W), true, "bottom 422 touching");
  assert.equal(sight({ x: 200, y: 401 }, [below], reach, W), false);
  const above = cover(300, 370, 0, 500);
  assert.equal(sight({ x: 200, y: 400 }, [above], reach, W), true, "top 370 touching");
  assert.equal(sight({ x: 200, y: 399 }, [above], reach, W), false);
  // a cover to the left: 37; to the right: 45
  const leftC = cover(0, 844, 0, 163);
  assert.equal(sight({ x: 200, y: 400 }, [leftC], reach, W), true);
  assert.equal(sight({ x: 199, y: 400 }, [leftC], reach, W), false);
  const rightC = cover(0, 844, 245, 500);
  assert.equal(sight({ x: 200, y: 400 }, [rightC], reach, W), true);
  assert.equal(sight({ x: 201, y: 400 }, [rightC], reach, W), false);
  // a half-size {x, y} still works (the same each way)
  assert.equal(sight({ x: 22, y: 400 }, [], { x: 22, y: 22 }, W), true);
  assert.equal(sight({ x: 21, y: 400 }, [], { x: 22, y: 22 }, W), false);
});

test("anyoneAt: each person's own reach", () => {
  const W = { w: 390, h: 844 };
  const leftC = [cover(0, 844, 0, W.w / 2 - 38)]; // 38 px left of the middle: clear for 37, not for 45
  const at = (half) => N.anyoneAt({ me: NYC, people: [{ pos: NYC, half }], size: W, covers: leftC, zoom: 14, half: ONE });
  assert.equal(at({ l: 37, r: 45, t: 30, b: 22 }), true, "badge on the right: clear");
  assert.equal(at({ l: 45, r: 37, t: 30, b: 22 }), false, "badge on the left: overlaps");
});

test("markerReach: a part with no height (or no width), however far out, changes nothing", () => {
  const el = { left: 100, right: 174, top: 200, bottom: 244 };
  assert.deepEqual(N.markerReach(el, [{ left: 0, right: 300, top: 222, bottom: 222 }]), { l: 37, r: 37, t: 22, b: 22 }, "flat");
  assert.deepEqual(N.markerReach(el, [{ left: 500, right: 500, top: 0, bottom: 400 }]), { l: 37, r: 37, t: 22, b: 22 }, "thin");
});

// Big screens (owner, 2026-11-09): a 2560×1440 monitor at 100% already
// shows counts, not people one by one, at the usual view (the 110-block
// limit) — the search starts at the first zoom that does show them.
const startZoom = (size, center = NYC) =>
  N.markerStartZoom({ viewport: V, h3, center, size, rungs: RUNGS, budget: BUDGET, maxZoom: 14 });

test("markerStartZoom: a phone, a laptop, a 1080p screen — the usual view (people one by one there)", () => {
  for (const size of [PHONE, { w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
    assert.equal(markersAt(NYC, 14, size), true, JSON.stringify(size));
    assert.equal(startZoom(size), 14, JSON.stringify(size));
  }
});

test("markerStartZoom: a 2560×1440 and a 4K monitor — the first zoom closer in that shows people one by one, to a hundredth", () => {
  for (const size of [{ w: 2560, h: 1440 }, { w: 3840, h: 2160 }]) {
    assert.equal(markersAt(NYC, 14, size), false, `(counts at the usual view: ${JSON.stringify(size)})`);
    const z = startZoom(size);
    assert.ok(z > 14 && z <= 18, String(z));
    assert.equal(markersAt(NYC, z, size), true, `one by one at ${z}`);
    assert.equal(markersAt(NYC, z - 0.01, size), false, `not a hundredth wider (${z - 0.01})`);
    assert.equal(Math.round(z * 100) / 100, z, "a hundredth");
  }
  assert.ok(startZoom({ w: 3840, h: 2160 }) > startZoom({ w: 2560, h: 1440 }), "bigger screen: closer in");
});

test("big screens: the search's steps start there and step out to the widest view from there", () => {
  const size = { w: 2560, h: 1440 };
  const z0 = startZoom(size);
  const w = N.widestMarkerZoom({ viewport: V, h3, center: NYC, size, rungs: RUNGS, budget: BUDGET, maxZoom: z0 });
  assert.equal(w, z0, "(at most where it starts: closer in, it only ever shows more one by one)");
  const zs = N.zoomSteps(z0, w, 0.5);
  assert.deepEqual(zs, [z0], "(one step: the only view that shows people one by one)");
});

test("in sight: a marker whose MIDDLE is off the screen isn't measured at all (its size is only asked for when it could be seen)", () => {
  let asked = 0;
  const lazy = { get l() { asked++; return 22; }, get r() { asked++; return 22; }, get t() { asked++; return 22; }, get b() { asked++; return 22; } };
  for (const pt of [{ x: -1, y: 400 }, { x: PHONE.w + 1, y: 400 }, { x: 200, y: -1 }, { x: 200, y: PHONE.h + 1 }, { x: NaN, y: 400 }])
    assert.equal(N.inSight(pt, lazy, PHONE, []), false, JSON.stringify(pt));
  assert.equal(asked, 0, "never measured");
  assert.equal(N.inSight({ x: 200, y: 400 }, lazy, PHONE, []), true);
  assert.ok(asked > 0, "measured when its middle is on the screen");
});

test("markerStartZoom, all over the world and on every big screen: exactly the first hundredth that shows people one by one — and a single step", () => {
  let big = 0;
  for (let lat = 0; lat <= 70; lat += 10)
    for (const lng of [-74, 0.1, 103.8, 151.2])
      for (const size of [{ w: 2400, h: 1350 }, { w: 2560, h: 1440 }, { w: 3000, h: 1600 }, { w: 3840, h: 2160 }, { w: 1440, h: 2560 }]) {
        const c = { lat, lng };
        if (markersAt(c, 14, size)) continue;
        big++;
        const z = N.markerStartZoom({ viewport: V, h3, center: c, size, rungs: RUNGS, budget: BUDGET, maxZoom: 14 });
        const at = JSON.stringify({ lat, lng, size, z });
        assert.equal(markersAt(c, z, size), true, `shows people one by one: ${at}`);
        assert.equal(markersAt(c, Math.round((z - 0.01) * 100) / 100, size), false, `a hundredth wider shows counts: ${at}`);
        const w = N.widestMarkerZoom({ viewport: V, h3, center: c, size, rungs: RUNGS, budget: BUDGET, maxZoom: z });
        assert.deepEqual(N.zoomSteps(z, w, 0.5), [z], `one step, no sliver: ${at} widest ${w}`);
      }
  assert.ok(big > 50, `(enough big-screen cases: ${big})`);
});

test("markerStartZoom: a screen that shows counts even fully in (an 8K monitor) — the limit, and showsMarkers says no there", () => {
  const countsOnly = { planWatch: () => ({ res: 7, cells: [] }) };
  const z = N.markerStartZoom({ viewport: countsOnly, h3, center: NYC, size: { w: 7680, h: 4320 }, rungs: RUNGS, budget: BUDGET, maxZoom: 14 });
  assert.equal(z, 18);
  assert.equal(N.showsMarkers(countsOnly, h3, N.screenAt(NYC, z, { w: 7680, h: 4320 }), RUNGS, BUDGET), false, "(the app asks this, and skips the search)");
  // the real ladder on a real 8K screen at 100%
  const real = { w: 7680, h: 4320 };
  const zr = N.markerStartZoom({ viewport: V, h3, center: NYC, size: real, rungs: RUNGS, budget: BUDGET, maxZoom: 14 });
  assert.ok(zr > 14, String(zr));
});

test("markerReach: an empty part (an icon still loading) before the badge — the badge still counts", () => {
  const el = { left: 100, right: 174, top: 200, bottom: 244 };
  const loading = { left: 120, right: 150, top: 222, bottom: 222 };
  const badge = { left: 152, right: 182, top: 192, bottom: 214 };
  assert.deepEqual(N.markerReach(el, [loading, loading, badge]), { l: 37, r: 45, t: 30, b: 22 });
});

test("markerReach: a part reaching below the marker (a label under it) — reaches further down", () => {
  const el = { left: 100, right: 144, top: 200, bottom: 244 };
  assert.deepEqual(N.markerReach(el, [{ left: 110, right: 134, top: 240, bottom: 254 }]), { l: 22, r: 22, t: 22, b: 32 });
});

// A found result watched over time (owner, 2026-11-09): when everyone it
// found has gone, it looks again — 5 s, then longer each time it keeps
// happening (10, 20, … up to 60 s), each ±20% at random (phones that lose
// the same car don't all ask at once) — the jitter as the heartbeat's
test("researchWait: 5 s, doubling each time, at most 60 s — the middle of the jitter exactly that", () => {
  const mid = (n) => N.researchWait(n, 0.5);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(mid), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test("researchWait: ±20% at random — the ends of the range, and never outside it", () => {
  assert.equal(N.researchWait(0, 0), 4000);
  assert.equal(N.researchWait(0, 1), 6000);
  assert.equal(N.researchWait(4, 0), 48000);
  assert.equal(N.researchWait(4, 1), 72000);
  for (let i = 0; i < 2000; i++) {
    const n = i % 7;
    const w = N.researchWait(n, Math.random());
    const base = Math.min(5000 * 2 ** n, 60000);
    assert.ok(w >= base * 0.8 - 1e-9 && w <= base * 1.2 + 1e-9, `${n}: ${w}`);
  }
  assert.equal(N.researchWait(-1, 0.5), 5000, "(never below the first)");
});

test("stepsFrom: a search looking again starts from the zoom it's at — never closer in", () => {
  const zs = [14, 13.5, 13, 12.5, 12.47];
  assert.deepEqual(N.stepsFrom(zs, 13), [13, 12.5, 12.47]);
  assert.deepEqual(N.stepsFrom(zs, 13.2), [13, 12.5, 12.47], "between steps: the next one out");
  assert.deepEqual(N.stepsFrom(zs, 15), zs, "closer in than the start: all of them");
  assert.deepEqual(N.stepsFrom(zs, 12.47), [12.47]);
  // (owner, 2026-11-10: the map NEVER zooms in by itself — a look-again
  // from wider than the widest step has nowhere further out to go: none)
  assert.deepEqual(N.stepsFrom(zs, 11), [], "wider than the widest: no step (never closer in)");
});

// Time away (owner, 2026-11-09): a phone asleep stops the steady clock
// (performance.now) — the wall clock (Date.now) goes on; a clock set back
// stops the wall clock — the steady one goes on. Time passed: whichever
// says more.
test("elapsed: whichever clock says more — asleep an hour (the steady clock stopped), or the phone's clock set back", () => {
  const at = { p: 1000, d: 1_700_000_000_000 };
  assert.equal(N.elapsed(at, { p: 3000, d: 1_700_000_002_000 }), 2000, "both agree");
  assert.equal(N.elapsed(at, { p: 1500, d: 1_700_003_600_000 }), 3_600_000, "asleep an hour: the wall clock's hour");
  assert.equal(N.elapsed(at, { p: 61_000, d: 1_699_999_000_000 }), 60_000, "clock set back: the steady clock's minute");
  assert.equal(N.elapsed(at, at), 0);
});

// a solid ring round a cover is part of what you see (the raised ✋'s
// yellow ring: styles.css .btn-ask.on — the browser's own computed form)
test("ringReach: the raised ✋'s yellow ring — 3 px past its box; its soft shadow doesn't count", () => {
  const style = { boxShadow: "rgb(255, 204, 0) 0px 0px 0px 3px, rgba(0, 0, 0, 0.4) 0px 2px 10px 0px", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" };
  assert.equal(N.ringReach(style), 3);
  assert.equal(N.ringReach({ ...style, boxShadow: "rgba(0, 0, 0, 0.4) 0px 2px 10px 0px" }), 0, "a soft shadow only: nothing");
  assert.equal(N.ringReach({ ...style, boxShadow: "none" }), 0);
  assert.equal(N.ringReach({ ...style, boxShadow: "" }), 0);
  assert.equal(N.ringReach({}), 0, "nothing known: nothing");
});

test("ringReach: a ring offset or blurred is soft — only a spread with no offset and no blur; inside rings don't reach out", () => {
  const ring = (boxShadow) => N.ringReach({ boxShadow, outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" });
  assert.equal(ring("rgb(1, 2, 3) 0px 0px 0px 2.5px"), 2.5, "fractional");
  assert.equal(ring("rgb(1, 2, 3) 0px 0px 4px 3px"), 0, "blurred");
  assert.equal(ring("rgb(1, 2, 3) 1px 0px 0px 3px"), 0, "offset");
  assert.equal(ring("rgb(1, 2, 3) 0px 0px 0px 3px inset"), 0, "inset: inside the box");
  assert.equal(ring("rgb(1, 2, 3) 0px 0px 0px 0px"), 0, "no spread");
  assert.equal(ring("rgb(1, 2, 3) 0px 0px 0px -2px"), 0, "a negative spread");
  assert.equal(ring("rgb(1, 2, 3) 0px 0px 0px 2px, rgb(4, 5, 6) 0px 0px 0px 6px"), 6, "two rings: the wider");
  assert.equal(ring("#fff 0px 0px 0px 4px"), 4, "a colour written otherwise");
});

test("ringReach: an outline — its width and offset (the account button's focus ring: 3 px, 2 px out); none or zero — nothing", () => {
  const base = { boxShadow: "none" };
  assert.equal(N.ringReach({ ...base, outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "2px" }), 5);
  assert.equal(N.ringReach({ ...base, outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "-3px" }), 0, "drawn inside");
  assert.equal(N.ringReach({ ...base, outlineStyle: "none", outlineWidth: "3px", outlineOffset: "0px" }), 0, "no outline");
  assert.equal(N.ringReach({ ...base, outlineStyle: "solid", outlineWidth: "0px", outlineOffset: "4px" }), 0, "zero width");
  assert.equal(N.ringReach({ boxShadow: "rgb(1, 2, 3) 0px 0px 0px 4px", outlineStyle: "solid", outlineWidth: "1px", outlineOffset: "1px" }), 4, "both: the wider");
});

test("ringReach: every engine's written form — WebKit/Gecko/Chromium alike, and newer colour forms", () => {
  const ring = (boxShadow) => N.ringReach({ boxShadow, outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" });
  assert.equal(ring("rgb(255, 204, 0) 0px 0px 0px 3px, rgba(0, 0, 0, 0.4) 0px 2px 10px 0px"), 3, "Safari / Firefox / Chrome");
  assert.equal(ring("oklch(0.8 0.17 90) 0px 0px 0px 3px"), 3, "oklch");
  assert.equal(ring("color(display-p3 1 0.8 0) 0px 0px 0px 3px"), 3, "display-p3");
  assert.equal(ring("rgb(255 204 0) 0px 0px 0px 3px"), 3, "space-separated rgb");
  assert.equal(ring("rgb(255 204 0 / 0.5) 0px 0px 0px 3px"), 3, "half see-through: still seen");
});

test("ringReach: a ring you can't see draws nothing — alpha 0, transparent", () => {
  const ring = (boxShadow) => N.ringReach({ boxShadow, outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" });
  assert.equal(ring("rgba(0, 0, 0, 0) 0px 0px 0px 3px"), 0);
  assert.equal(ring("rgb(0 0 0 / 0) 0px 0px 0px 3px"), 0);
  assert.equal(ring("rgb(0 0 0 / 0%) 0px 0px 0px 3px"), 0);
  assert.equal(ring("transparent 0px 0px 0px 3px"), 0);
  assert.equal(ring("rgba(0, 0, 0, 0) 0px 0px 0px 3px, rgb(1, 2, 3) 0px 0px 0px 2px"), 2, "the seen one of two");
  assert.equal(ring("rgba(0, 0, 0, 0.05) 0px 0px 0px 3px"), 3, "faint but there: counted (errs safe)");
  assert.equal(ring("rgb(255, 204, 0) 0px 0px 0px 3px"), 3, "a colour ending in 0 (yellow) is no alpha: seen");
  assert.equal(ring("rgba(255, 204, 0, 1) 0px 0px 0px 3px"), 3);
  assert.equal(ring("rgb(255 204 0) 0px 0px 0px 3px"), 3, "space-separated, ending in 0: seen");
  assert.equal(ring("rgba(255, 204, 0, 0.0) 0px 0px 0px 3px"), 0, "alpha 0.0");
});

// the app works the widest step out for a screen NEAR_EDGE_PX (2) bigger on
// each side (app.js): the map's real view can be a pixel or so wider than
// the whole-pixel size measured — and at that step it must still show
// people one by one, never tip over into counts
test("the widest step, worked out 2 px bigger each side: the real view up to 2 px wider each side still shows people one by one", () => {
  const EDGE = 2;
  const sizes = [PHONE, DESKTOP, { w: 320, h: 568 }, { w: 412, h: 915 }, { w: 844, h: 390 }, { w: 1280, h: 720 }, { w: 1920, h: 1080 }, { w: 260, h: 563 }];
  const places = [NYC, { lat: 51.5072, lng: -0.1276 }, { lat: -33.8688, lng: 151.2093 }, { lat: 1.29, lng: 103.85 }, { lat: 69.6492, lng: 18.9553 }, { lat: -16.78, lng: 179.9995 }];
  let tight = 0;
  for (const size of sizes)
    for (const center of places) {
      // (as the app: the start — closer in on a big screen — and the
      // widest, both for the bigger screen)
      const big = { w: size.w + 2 * EDGE, h: size.h + 2 * EDGE };
      const plan = { viewport: V, h3, center, size: big, rungs: RUNGS, budget: BUDGET };
      const start = N.markerStartZoom({ ...plan, maxZoom: 14 });
      if (!N.showsMarkers(V, h3, N.screenAt(center, start, big), RUNGS, BUDGET)) continue;
      const z = N.widestMarkerZoom({ ...plan, maxZoom: start });
      for (const grow of [0, 0.5, 1, 1.5, 2])
        assert.ok(markersAt(center, start, { w: size.w + 2 * grow, h: size.h + 2 * grow }), `${size.w}×${size.h} at ${JSON.stringify(center)}: counts at the START ${start} when the view is ${grow} px wider each side`);
      for (const grow of [0, 0.5, 1, 1.5, 2]) {
        const real = { w: size.w + 2 * grow, h: size.h + 2 * grow };
        assert.ok(markersAt(center, z, real), `${size.w}×${size.h} at ${JSON.stringify(center)}: counts at ${z} when the view is ${grow} px wider each side`);
      }
      // (and the margin matters: worked out for the measured size alone, a
      // view 2 px wider tips over somewhere — else the test proves nothing)
      const s0 = N.markerStartZoom({ ...plan, size, maxZoom: 14 });
      const z0 = N.widestMarkerZoom({ ...plan, size, maxZoom: s0 });
      if (!markersAt(center, z0, big) || !markersAt(center, s0, big)) tight++;
    }
  assert.ok(tight > 0, "no screen tips over without the margin — the case isn't exercised");
});

// exact: the "moved 500 m" rule measures real ground in every direction
// (east–west shrinks with latitude: without it 300 m east reads as ~400)
test("metersBetween: exact in every direction (1 km north, east, south-west — within a metre)", () => {
  for (const deg of [0, 90, 225]) assert.ok(Math.abs(N.metersBetween(NYC, at(1000, deg)) - 1000) < 1, `${deg}°: ${N.metersBetween(NYC, at(1000, deg))}`);
  assert.ok(Math.abs(N.metersBetween(NYC, at(500, 90)) - 500) < 0.5);
});

// exact: half a level at a time, the widest last — a gap under half a step
// to the widest is merged into it (never a tiny extra step)
test("zoomSteps: exact steps — the last gap under half a step merged into the widest", () => {
  assert.deepEqual(N.zoomSteps(14, 12.3, 0.5), [14, 13.5, 13, 12.3]);
  assert.deepEqual(N.zoomSteps(14, 12.6, 0.5), [14, 13.5, 13, 12.6]);
  assert.deepEqual(N.zoomSteps(14, 12.76, 0.5), [14, 13.5, 12.76]);
});

test("ringReach: a shadow moved down (or sideways) isn't a ring round it — only an unmoved spread is", () => {
  const ring = (boxShadow) => N.ringReach({ boxShadow, outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" });
  assert.equal(ring("rgb(1, 2, 3) 0px 2px 0px 3px"), 0, "moved down");
  assert.equal(ring("rgb(1, 2, 3) 2px 0px 0px 3px"), 0, "moved sideways");
});

// the work a search start costs (owner, 2026-11-10): each "does this zoom
// show people one by one?" asks the map planner (planWatch: an H3 fill of up
// to ~110 cells) — counted, so a slowdown fails here, not on a phone. And
// it stays BOUNDED whatever the planner answers (a planner that says yes,
// no, yes… at random zooms must never make it loop for ever)
test("the zooms a search starts with: a bounded number of planner calls — on a phone, a big screen, and with a planner that answers inconsistently", () => {
  const counting = (inner) => {
    const v = { calls: 0, planWatch: (...a) => (v.calls++, inner(...a)) };
    return v;
  };
  const plan = (viewport, size, center = NYC) => {
    const base = { viewport, h3, center, size, rungs: RUNGS, budget: BUDGET };
    const start = N.markerStartZoom({ ...base, maxZoom: 14 });
    const widest = N.widestMarkerZoom({ ...base, maxZoom: start });
    return { start, widest };
  };
  const phone = counting(V.planWatch);
  plan(phone, PHONE);
  assert.ok(phone.calls <= 20, `a phone: ${phone.calls} planner calls`);
  const big = counting(V.planWatch);
  plan(big, { w: 2560, h: 1440 });
  assert.ok(big.calls <= 40, `a big screen: ${big.calls} planner calls`);
  // a planner that, past its first answers, says "fits" to every halving
  // step and then "doesn't" to everything after — the shape that would make
  // a step-by-step search walk a hundredth at a time all the way in
  let n = 0;
  const odd = { calls: 0, planWatch: () => { odd.calls++; n++; const yes = n === 1 || (n > 2 && n <= 14); return { res: yes ? RUNGS[0] : RUNGS[1] }; } };
  const r = { widest: N.widestMarkerZoom({ viewport: odd, h3, center: NYC, size: PHONE, rungs: RUNGS, budget: BUDGET, maxZoom: 14 }), start: 14 };
  assert.ok(odd.calls <= 40, `an inconsistent planner: ${odd.calls} calls — bounded`);
  assert.ok(r.widest >= 1 && r.widest <= r.start && r.start <= 18, JSON.stringify(r));
});

// edges a future edit could break unnoticed (a unit-boundary review,
// 2026-11-10)
test("widestMarkerZoom: exact to a hundredth — a hundredth wider shows counts; a whole hundredth itself", () => {
  for (const size of [PHONE, DESKTOP])
    for (const center of [NYC, { lat: 51.5072, lng: -0.1276 }]) {
      const z = widest(size, center);
      assert.equal(Math.round(z * 100) / 100, z, `${z}: a whole hundredth`);
      assert.ok(!markersAt(center, Math.round((z - 0.01) * 100) / 100, size), `${z}: a hundredth wider still shows people`);
    }
});

test("widestMarkerZoom / showsMarkers: even the whole world shows people → 1; a planner with no plan → not people", () => {
  assert.equal(N.widestMarkerZoom({ viewport: { planWatch: () => ({ res: RUNGS[0] }) }, h3, center: NYC, size: PHONE, rungs: RUNGS, budget: BUDGET, maxZoom: 14 }), 1);
  assert.equal(N.showsMarkers({ planWatch: () => null }, h3, N.screenAt(NYC, 14, PHONE), RUNGS, BUDGET), false);
});

test("zoomSteps from a fractional start (a big screen's); stepsFrom with the map's float zoom a hair under a step", () => {
  assert.deepEqual(N.zoomSteps(14.37, 13.1, 0.5), [14.37, 13.87, 13.37, 13.1]);
  const zs = [14, 13.5, 13, 12.5, 12.47];
  assert.deepEqual(N.stepsFrom(zs, 13 - 1e-7), [13, 12.5, 12.47]);
});

test("metersBetween: across the 180° line, to the far side of the earth, and to itself", () => {
  assert.ok(Math.abs(N.metersBetween({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 }) - 222.4) < 1);
  assert.ok(Math.abs(N.metersBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }) - Math.PI * 6371008.8) < 1);
  assert.equal(N.metersBetween(NYC, NYC), 0);
});

test("screenPoint: a longitude a whole turn off lands in the same place; inSight with a zero reach; markerReach skips a part it can't measure", () => {
  assert.ok(Math.abs(N.screenPoint(NYC, { lat: NYC.lat, lng: NYC.lng + 360 }, 14, PHONE).x - PHONE.w / 2) < 1e-6);
  assert.equal(N.inSight({ x: 0, y: 400 }, { l: 0, r: 0, t: 0, b: 0 }, PHONE, []), true);
  assert.deepEqual(N.markerReach({ left: 100, right: 144, top: 200, bottom: 244 }, [{ left: NaN, right: NaN, top: NaN, bottom: NaN }]), { l: 22, r: 22, t: 22, b: 22 });
});

// ===== Randomized (property test): the whole search, planned and walked =====
// (owner, 2026-11-10) Drives markerStartZoom, showsMarkers, screenAt,
// widestMarkerZoom, zoomSteps, stepsFrom, anyoneAt (→ screenPoint,
// inSight), ringReach — composed as app.js findNearest does (rpPlan +
// rpSearch mirror it). Replay: SEED=<seed> CASE=<i>; CASES=<n> for more.
const RP_EDGE = 2; // app.js NEAR_EDGE_PX
const RP_STEP = 0.5; // app.js NEAR_STEP
const RP_CASES = Number(process.env.CASES) || 5000;

function rpRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()),
    pick: (xs) => xs[Math.floor(xs.length * next())],
    chance: (p) => next() < p,
  };
}

const rpMercY = (lat) => {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const rpLatOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
// the spot drawn at screen point `pt` (inverse of screenPoint)
function rpFromScreen(me, pt, zoom, size) {
  const scale = 512 * 2 ** zoom;
  return { lat: rpLatOf(rpMercY(me.lat) + (pt.y - size.h / 2) / scale), lng: me.lng + ((pt.x - size.w / 2) / scale) * 360 };
}
// `m` metres from `me`, `deg` clockwise from north
function rpAt(me, m, deg) {
  const d = m / 6371008.8;
  const b = (deg * Math.PI) / 180;
  const la = (me.lat * Math.PI) / 180;
  const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lng = (me.lng * Math.PI) / 180 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
  return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
}

// the box rule written out again (the oracle): whole marker on screen
// (touching ok), middle on screen, overlapping no cover; unmeasurable = covered
function rpSeen(pt, reach, size, covers) {
  const L = reach.l ?? reach.x, R = reach.r ?? reach.x, T = reach.t ?? reach.y, B = reach.b ?? reach.y;
  const bx = { l: pt.x - L, r: pt.x + R, t: pt.y - T, b: pt.y + B };
  if (![pt.x, pt.y, bx.l, bx.r, bx.t, bx.b].every((v) => typeof v === "number" && !Number.isNaN(v))) return false;
  if (pt.x < 0 || pt.x > size.w || pt.y < 0 || pt.y > size.h) return false;
  if (bx.l < 0 || bx.r > size.w || bx.t < 0 || bx.b > size.h) return false;
  for (const c of covers) {
    if (!(bx.r <= c.left || bx.l >= c.right || bx.b <= c.top || bx.t >= c.bottom)) return false;
  }
  return true;
}

function rpPlanner(r, kind) {
  const yes = { res: RUNGS[0] };
  const no = { res: RUNGS[1] };
  if (kind === "real") return { planWatch: V.planWatch };
  if (kind === "always") return { planWatch: () => yes };
  if (kind === "never") return { planWatch: () => r.pick([no, null]) };
  if (kind === "noisy") return { planWatch: () => r.pick([yes, no, null]) };
  const limit = 360 * 2 ** -r.range(-1, 21); // people one by one iff the view is at most this wide
  const nul = r.chance(0.2);
  return { planWatch: (_h3, rect) => (rect.e - rect.w <= limit ? yes : nul ? null : no) };
}

// app.js findNearest's planning: the zooms, for a screen RP_EDGE bigger each side
function rpPlan({ planner, me, size, maxZoom }) {
  let calls = 0;
  const viewport = { planWatch: (...a) => (calls++, planner.planWatch(...a)) };
  const ladder = { viewport, h3, center: me, size: { w: size.w + 2 * RP_EDGE, h: size.h + 2 * RP_EDGE }, rungs: RUNGS, budget: BUDGET };
  const start = N.markerStartZoom({ ...ladder, maxZoom });
  if (!N.showsMarkers(viewport, h3, N.screenAt(me, start, ladder.size), RUNGS, BUDGET)) return { start, widest: null, all: null, calls };
  const widest = N.widestMarkerZoom({ ...ladder, maxZoom: start });
  return { start, widest, all: N.zoomSteps(start, widest, RP_STEP), calls };
}

// app.js findNearest's walk: no steps further out (a look-again from wider
// than the widest): it stays; else each step — anyone in sight: found; else
// counts only (wanted agg > 0, geo 0): silent; else the last: nobody; else out
function rpSearch({ plan, me, people, size, covers, outFrom, world }) {
  if (!plan.all) return { verdict: "no-search", zooms: [], looks: 0, steps: [] };
  const steps = outFrom === null ? plan.all : N.stepsFrom(plan.all, outFrom);
  if (!steps.length) return { verdict: "stay", zooms: [], looks: 0, steps };
  const zooms = [steps[0]];
  let looks = 0;
  for (let i = 0; ; ) {
    if (++looks > 1000) return { verdict: "runaway", zooms, looks, steps };
    if (N.anyoneAt({ me, people, size, covers, zoom: steps[i], half: HALF })) return { verdict: "found", index: i, zoom: steps[i], zooms, looks, steps };
    const w = world[Math.min(i, world.length - 1)];
    if (w.agg > 0 && w.geo === 0) return { verdict: "silent", index: i, zooms, looks, steps };
    if (i === steps.length - 1) return { verdict: "nobody", index: i, zooms, looks, steps };
    zooms.push(steps[++i]);
  }
}

const RP_STYLES = [
  {},
  { boxShadow: "none", outlineStyle: "none", outlineWidth: "0px", outlineOffset: "0px" },
  { boxShadow: "rgb(255, 204, 0) 0px 0px 0px 3px, rgba(0, 0, 0, 0.4) 0px 2px 10px 0px" },
  { boxShadow: "rgba(0, 0, 0, 0) 0px 0px 0px 6px" },
  { boxShadow: "none", outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "2px" },
  { boxShadow: "oklch(0.8 0.17 90) 0px 0px 0px 2.5px" },
];
function rpCovers(r, size) {
  const out = [];
  const box = (top, bottom, left, right, style = {}) => {
    const g = N.ringReach(style);
    out.push({ top: top - g, bottom: bottom + g, left: left - g, right: right + g });
  };
  const inset = { top: r.pick([0, 0, 20, 47, 59]), bottom: r.pick([0, 0, 21, 34]), left: r.pick([0, 0, 0, 44, 59]), right: r.pick([0, 0, 0, 44]) };
  if (inset.top) box(0, inset.top, 0, size.w);
  if (inset.bottom) box(size.h - inset.bottom, size.h, 0, size.w);
  if (inset.left) box(0, size.h, 0, inset.left);
  if (inset.right) box(0, size.h, size.w - inset.right, size.w);
  if (r.chance(0.6)) {
    const t = r.range(0, 80);
    box(t, t + r.range(20, 120), 16, size.w - 16, r.pick(RP_STYLES)); // a banner
  }
  if (r.chance(0.6))
    for (let k = 0, n = r.int(1, 4); k < n; k++) {
      const l = r.range(0, size.w - 48);
      box(size.h - 96, size.h - 48, l, l + 48, r.pick(RP_STYLES)); // bottom buttons
    }
  for (let k = 0, n = r.int(0, 4); k < n; k++) {
    const t = r.range(-50, size.h);
    const l = r.range(-50, size.w);
    box(t, t + r.range(0, size.h / 2), l, l + r.range(0, size.w / 2), r.pick(RP_STYLES)); // anything, partly off-screen too
  }
  if (r.chance(0.02)) box(0, size.h, 0, size.w); // over everything
  if (r.chance(0.02)) out.push({ top: NaN, bottom: NaN, left: NaN, right: NaN }); // can't be measured
  return out;
}

function rpReach(r) {
  const k = r.int(0, 3);
  if (k === 0) return undefined; // the default (HALF)
  if (k === 1) return { x: 22, y: 22 };
  if (k === 2) return { x: 37, y: 22 }; // a group
  return { l: r.range(0, 45), r: r.range(0, 45), t: r.range(0, 45), b: r.range(0, 45) }; // a badge
}

function rpPeople(r, me, size, covers, zs) {
  const out = [];
  const n = r.chance(0.2) ? 0 : r.int(1, 8);
  for (let k = 0; k < n; k++) {
    const half = rpReach(r);
    const re = half || HALF;
    const L = re.l ?? re.x, R = re.r ?? re.x, T = re.t ?? re.y, B = re.b ?? re.y;
    const z = r.pick(zs);
    const d = r.pick([0, 0, -1, 1]); // exactly touching, or a pixel either way
    let pos;
    switch (r.int(0, 6)) {
      case 0:
        pos = rpAt(me, 10 ** r.range(0, 4.7), r.chance(0.3) ? r.pick([0, 90, 180, 270]) : r.range(0, 360));
        break;
      case 1: {
        const pt = r.pick([
          { x: L + d, y: r.range(T, size.h - B) },
          { x: size.w - R - d, y: r.range(T, size.h - B) },
          { x: r.range(L, size.w - R), y: T + d },
          { x: r.range(L, size.w - R), y: size.h - B - d },
        ]);
        pos = rpFromScreen(me, pt, z, size);
        break;
      }
      case 2: {
        const c = covers.length ? r.pick(covers) : { top: 0, bottom: 0, left: 0, right: 0 };
        const mx = (c.left + c.right) / 2, my = (c.top + c.bottom) / 2;
        const pt = r.pick([
          { x: mx, y: my },
          { x: mx, y: c.bottom + T + d },
          { x: mx, y: c.top - B - d },
          { x: c.left - R - d, y: my },
          { x: c.right + L + d, y: my },
        ]);
        pos = rpFromScreen(me, pt, z, size);
        break;
      }
      case 3:
        pos = rpFromScreen(me, r.pick([{ x: 0, y: size.h / 2 }, { x: size.w, y: size.h / 2 }, { x: size.w / 2, y: 0 }, { x: size.w / 2, y: size.h }]), z, size);
        break;
      case 4:
        pos = { lat: me.lat, lng: me.lng };
        break;
      case 5:
        pos = rpAt(me, r.range(5000, 2e6), r.range(0, 360));
        break;
      default:
        pos = r.chance(0.8) ? rpFromScreen(me, { x: r.range(0, size.w), y: r.range(0, size.h) }, z, size) : { lat: NaN, lng: me.lng };
    }
    out.push({ pos, half });
  }
  return out;
}

const rpWorld = (r) => {
  const u = r.next();
  if (u < 0.7) return { agg: 0, geo: r.int(1, 110) };
  if (u < 0.85) return { agg: r.int(1, 20), geo: 0 }; // counts only
  if (u < 0.95) return { agg: r.int(1, 5), geo: r.int(1, 50) };
  return { agg: 0, geo: 0 };
};

const RP_SIZES = [{ w: 1, h: 1 }, { w: 40, h: 40 }, { w: 260, h: 563 }, { w: 320, h: 568 }, PHONE, { w: 391, h: 843 }, { w: 844, h: 390 }, { w: 1280, h: 720 }, DESKTOP, { w: 2560, h: 1440 }, { w: 7680, h: 4320 }, { w: 20000, h: 20000 }];
const RP_PLACES = [{ lat: 40.7154, lng: -74.0086 }, { lat: -16.78, lng: 179.9995 }, { lat: 69.6492, lng: 18.9553 }, { lat: 0, lng: 0 }];

function rpCase(r, tally, info) {
  const size = r.chance(0.7) ? r.pick(RP_SIZES) : { w: r.int(1, 4000), h: r.int(1, 4000) };
  const me = r.chance(0.3) ? r.pick(RP_PLACES) : { lat: r.range(-80, 80), lng: r.range(-180, 180) };
  const kind = size.w * size.h <= 2560 * 1440 && r.chance(1 / 40) ? "real" : r.pick(["span", "span", "span", "span", "always", "never", "noisy"]);
  const maxZoom = r.chance(0.8) ? 14 : Math.round(r.range(10, 17) * 100) / 100;
  Object.assign(info, { size, me, kind, maxZoom });
  const plan = rpPlan({ planner: rpPlanner(r, kind), me, size, maxZoom });
  info.plan = plan;
  const zs = plan.all || [plan.start];
  const outFrom = r.chance(0.5) ? null : r.pick([0, 24, plan.start, plan.widest ?? plan.start, r.pick(zs), r.pick(zs) - 1e-7, r.pick(zs) + 1e-7, r.range(0, 24)]);
  const covers = rpCovers(r, size);
  const people = rpPeople(r, me, size, covers, zs);
  const world = zs.map(() => rpWorld(r));
  Object.assign(info, { outFrom, covers, people, world });
  const res = rpSearch({ plan, me, people, size, covers, outFrom, world });
  info.res = res;
  if (kind === "real") tally.real++;

  // (2) always ends, within bounds: planner calls, steps, looks
  assert.notEqual(res.verdict, "runaway", "never ended");
  tally[res.verdict]++;
  const startCalls = 2 + Math.ceil(Math.log2(Math.max(2, 1800 - Math.round(maxZoom * 100))));
  const widestCalls = 2 + Math.ceil(Math.log2(1800 - 100));
  assert.ok(plan.calls <= startCalls + widestCalls + 1, `planner calls ${plan.calls}`);
  if (plan.all) {
    assert.ok(plan.all.length <= Math.floor((plan.start - plan.widest) / RP_STEP) + 2, `steps ${plan.all}`);
    assert.ok(res.zooms.length <= plan.all.length && res.looks === res.zooms.length, "one look per step");
  }

  // (1) never zooms in: always wider; never past the widest; a fresh search
  // starts at the start; a look-again never closer in than the map is
  const z = res.zooms;
  for (let k = 1; k < z.length; k++) assert.ok(z[k] < z[k - 1], `zoomed in mid-search: ${z}`);
  if (plan.all) {
    assert.ok(z.every((q) => q >= plan.widest - 1e-9), `wider than the widest ${plan.widest}: ${z}`);
    if (outFrom === null) assert.equal(z[0], plan.start);
  }
  if (outFrom !== null) assert.ok(z.every((q) => q <= outFrom + 1e-6), `a look-again from ${outFrom} zoomed IN: ${z}`);
  if (kind === "real")
    for (const q of z) assert.ok(N.showsMarkers(V, h3, N.screenAt(me, q, size), RUNGS, BUDGET), `counts at step ${q}`);
  if (!plan.all) return;

  // the oracle: every person at every step, by the box rule written out —
  // and inSight agrees with it everywhere
  let o = null;
  res.steps.forEach((q, i) => {
    const seen = people.filter((p) => {
      const pt = N.screenPoint(me, p.pos, q, size);
      const mine = rpSeen(pt, p.half || HALF, size, covers);
      assert.equal(N.inSight(pt, p.half || HALF, size, covers), mine, `inSight disagrees at ${q}: ${JSON.stringify({ pt, half: p.half })}`);
      return mine;
    });
    if (!o && seen.length) o = { index: i, zoom: q, seen };
  });
  const tipped = (k) => {
    const w = world[Math.min(k, world.length - 1)];
    return w.agg > 0 && w.geo === 0;
  };
  const firstTip = res.steps.findIndex((_, k) => tipped(k));

  // (3) someone in sight at a step (and no counts-only state before it):
  // found exactly there — never later, never a step that shows nobody
  if (o && (firstTip === -1 || firstTip >= o.index)) assert.equal(res.verdict, "found", `in sight at ${o.zoom}, said ${res.verdict}`);
  if (res.verdict === "found") assert.ok(o && o.index === res.index, `found at ${res.zoom}; first in sight: ${o && o.zoom}`);
  if (res.verdict === "silent") assert.ok(tipped(res.index) && (!o || o.index > res.index), "silent only over counts, before anyone's in sight");

  // (4) "nobody nearby yet": never with anyone in sight, never over counts
  if (res.verdict === "nobody") {
    assert.equal(o, null, `nobody — but in sight at ${o && o.zoom}`);
    assert.equal(firstTip, -1, "nobody while the map shows counts");
  }

  // (5) found: it stays at that zoom, and someone there passes the box rule
  if (res.verdict === "found") {
    assert.equal(z.at(-1), res.zoom, "no step after finding");
    const clear = people.filter((p) => {
      const pt = N.screenPoint(me, p.pos, res.zoom, size);
      return N.inSight(pt, p.half || HALF, size, covers) && rpSeen(pt, p.half || HALF, size, covers);
    });
    assert.ok(clear.length > 0, "found nobody in sight");
  }
}

test("randomized: the whole search — never zooms in, always ends, stops at the first step anyone's in sight, never 'nobody' over counts", () => {
  const seed = process.env.SEED !== undefined ? Number(process.env.SEED) >>> 0 : 20261110;
  const only = process.env.CASE !== undefined ? Number(process.env.CASE) : null;
  const tally = { found: 0, nobody: 0, silent: 0, stay: 0, "no-search": 0, real: 0 };
  const from = only ?? 0;
  const to = only === null ? RP_CASES : only + 1;
  for (let i = from; i < to; i++) {
    const r = rpRng((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
    const info = {};
    try {
      rpCase(r, tally, info);
    } catch (e) {
      throw new Error(`${e.message}\n  seed ${seed} case ${i}: ${JSON.stringify(info).slice(0, 1500)}\n  replay: SEED=${seed} CASE=${i} node --test test_js/nearby.test.mjs`, { cause: e });
    }
  }
  // (the cases really cover every outcome — else the run proves little)
  if (only === null && RP_CASES >= 2000) {
    const at = `seed ${seed}: ${JSON.stringify(tally)}`;
    assert.ok(tally.found > RP_CASES / 10, at);
    assert.ok(tally.nobody > RP_CASES / 50, at);
    assert.ok(tally.silent > RP_CASES / 100, at);
    assert.ok(tally["no-search"] > RP_CASES / 100, at);
    assert.ok(tally.real >= 40, at);
  }
});
