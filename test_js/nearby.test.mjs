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
const NO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
const PAD = { top: 130, bottom: 120, left: 40, right: 40 };

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

test("fitZoom: a person exactly at the screen's edge fits at exactly that zoom", () => {
  for (const z of [11.3, 12.5, 14]) {
    const r = N.screenAt(NYC, z, PHONE);
    for (const target of [
      { lat: NYC.lat, lng: r.e },
      { lat: NYC.lat, lng: r.w },
      { lat: r.n, lng: NYC.lng },
      { lat: r.s, lng: NYC.lng },
    ])
      assert.ok(Math.abs(N.fitZoom(NYC, target, PHONE, NO_PAD) - z) < 1e-9, `${z} ${JSON.stringify(target)}`);
  }
  assert.equal(N.fitZoom(NYC, NYC, PHONE, NO_PAD), Infinity, "the same spot");
});

test("fitZoom keeps them clear of the banner (top) and the buttons (bottom)", () => {
  const z = 12;
  const r = N.screenAt(NYC, z, PHONE);
  // a person right at the bottom edge: with the buttons' 120 px, the map
  // must zoom out to bring them up past the buttons
  const bottom = { lat: r.s, lng: NYC.lng };
  const top = { lat: r.n, lng: NYC.lng };
  const zb = N.fitZoom(NYC, bottom, PHONE, PAD);
  const zt = N.fitZoom(NYC, top, PHONE, PAD);
  assert.ok(Math.abs(zb - (z + Math.log2((PHONE.h / 2 - 120) / (PHONE.h / 2)))) < 1e-6, String(zb));
  assert.ok(Math.abs(zt - (z + Math.log2((PHONE.h / 2 - 130) / (PHONE.h / 2)))) < 1e-6, String(zt));
  assert.ok(zt < zb, "the top's cover is bigger");
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
// at the first step where anyone shows (clear of the banner and buttons)
// and stays there — no zooming back in, so the others around show too.
const steps = (size = PHONE) => N.zoomSteps(14, widest(size), 0.5);
const anyoneAt = (people, zoom, size = PHONE) =>
  N.anyoneAt({ me: NYC, people: people.map((pos) => ({ pos })), size, pad: PAD, zoom });
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
  // on that screen, clear of the banner…
  assert.ok(N.fitZoom(NYC, far, PHONE, PAD) >= z);
  // …and not on the step before (it would have stopped there)
  const zs = steps();
  assert.ok(N.fitZoom(NYC, far, PHONE, PAD) < zs[zs.indexOf(z) - 1]);
});

test("it stops for whoever shows first — two people, the step showing either", () => {
  // east 1.5 km (a phone is narrow) and north 2 km: whichever fits first
  const east = at(1500, 90);
  const north = at(2000, 0);
  const first = Math.max(...[east, north].map((p) => stopsAt([p])));
  assert.equal(stopsAt([east, north]), first);
});

test("under the banner or the buttons doesn't count: they're not on screen", () => {
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
