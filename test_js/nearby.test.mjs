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

const decide = (people, size = PHONE) =>
  N.decide({ me: NYC, people: people.map((pos, i) => ({ id: i, pos })), size, pad: PAD, widestZoom: widest(size), maxZoom: 14 });

test("nobody: the widest zoom, and nobody nearest", () => {
  const d = decide([]);
  assert.deepEqual(d, { zoom: widest(PHONE), nearest: null });
});

test("someone close: the usual zoom (never closer)", () => {
  const d = decide([at(300, 90)]);
  assert.equal(d.zoom, 14);
  assert.equal(d.nearest.id, 0);
});

test("someone a couple of miles off: zoomed out just enough to show them, clear of the edges", () => {
  const far = at(2500, 0); // about 1½ miles north
  const d = decide([far]);
  assert.ok(d.zoom < 14 && d.zoom > widest(PHONE), String(d.zoom));
  const r = N.screenAt(NYC, d.zoom, PHONE);
  assert.ok(far.lat <= r.n && far.lat > NYC.lat, "on screen");
  // and just enough: a hair closer and they're under the banner
  assert.ok(Math.abs(N.fitZoom(NYC, far, PHONE, PAD) - d.zoom) < 1e-9);
});

test("the nearest by distance — not the first in the list, not the one that fits a closer zoom", () => {
  // east 1.5 km (a phone is narrow: needs a WIDER zoom) vs north 2 km
  const east = at(1500, 90);
  const north = at(2000, 0);
  const d = decide([north, east]);
  assert.equal(d.nearest.id, 1, "east is nearer");
  assert.ok(N.fitZoom(NYC, north, PHONE, PAD) > N.fitZoom(NYC, east, PHONE, PAD), "the test's premise");
});

test("someone beyond the widest view (off that screen) doesn't count: nobody nearby", () => {
  const d = decide([at(9000, 90), at(12000, 180)]);
  assert.equal(d.nearest, null);
  assert.equal(d.zoom, widest(PHONE));
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
