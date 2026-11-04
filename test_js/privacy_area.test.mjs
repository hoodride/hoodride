// The privacy page promises how precisely others see you: "an area roughly
// 350 m (about a quarter mile) across". That size is the app's, set by one
// number — H3_DISPLAY_RES in app.js. This ties the two (owner, 2026-10-30):
// change the area and this fails until the page (and its date) say so.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const read = (f) => readFileSync(new URL(`../priv/static/${f}`, import.meta.url), "utf8");

// the area the app puts you in, measured: an H3 hexagon's average width
// (flat side to flat side) at the app's resolution
function areaAcrossMeters() {
  const res = Number(read("app.js").match(/const H3_DISPLAY_RES = (\d+);/)[1]);
  const area = h3.getHexagonAreaAvg(res, "m2");
  return Math.sqrt((area * 2) / Math.sqrt(3));
}

const QUARTER_MILE_M = 402.336;

test("every size the privacy page states matches the app's area (within 10%)", () => {
  const across = areaAcrossMeters();
  const html = read("privacy.html");
  const stated = [...html.matchAll(/(\d+) m \(about a quarter mile\) across/g)].map((m) => Number(m[1]));
  assert.equal(stated.length, 2, "the map, and people you message or ask for a ride");
  for (const m of stated) assert.ok(Math.abs(m - across) / across < 0.1, `page says ${m} m; the app's area is ${Math.round(across)} m`);
});

test("'about a quarter mile' is fair for it (within 20%)", () => {
  const across = areaAcrossMeters();
  assert.ok(Math.abs(QUARTER_MILE_M - across) / across < 0.2, `${Math.round(across)} m vs a quarter mile`);
});
