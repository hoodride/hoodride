// The README's picture (docs/screenshot.png): the demo on a phone-sized
// screen, once the map has drawn. Against a running app (default: your own
// `mix phx.server`):
//
//   node test_browser/screenshot.mjs                 # → docs/screenshot.png
//   BASE=http://localhost:4000 node test_browser/screenshot.mjs out.png
//
// The demo's pretend people only: no real account or location appears.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { launch } from "./cdp.mjs";

const base = process.env.BASE || "http://localhost:4000";
const out = process.argv[2] || "docs/screenshot.png";

const browser = await launch();
try {
  const p = await browser.visitor("Screenshot", null);
  // shown 300 px wide in the README; drawn 600 px wide (twice that) to
  // stay sharp on sharp screens without a needlessly big file
  await p.phone(390, 780, 600 / 390);
  await p.goto(`${base}/?demo=1`);
  await p.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 0`, "the demo's pretend cars", 20000);
  // every map tile drawn, and a moment for the markers to settle
  await p.waitFor(`map.loaded() && map.areTilesLoaded() && !map.isMoving()`, "the map drawn", 30000);
  await new Promise((r) => setTimeout(r, 1500));
  await p.waitFor(`map.areTilesLoaded()`, "the map drawn", 10000);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await p.screenshot());
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
