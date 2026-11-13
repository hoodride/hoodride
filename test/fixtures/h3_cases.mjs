// Makes test/fixtures/h3_cases.json: what the app's own h3-js says, for
// Hoodride.H3Test to hold the server's H3 math to. Run again only if
// h3-js is ever upgraded:  node test/fixtures/h3_cases.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const h3 = require("../../priv/static/h3-js.umd.js");

// a fixed seed: the same file every run
let seed = 20261113;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const points = [];
for (let i = 0; i < 300; i++) points.push([rand() * 180 - 90, rand() * 360 - 180]);
// around each of the 12 pentagons (their missing child is the tricky case)
for (const p of h3.getPentagons(0)) {
  const [lat, lng] = h3.cellToLatLng(p);
  for (let i = 0; i < 25; i++) points.push([lat + (rand() - 0.5) * 6, lng + (rand() - 0.5) * 6]);
}
// the poles and the date line
points.push([90, 0], [-90, 0], [0, 180], [0, -180], [40.715, -74.008]);

const valid = points.map(([lat, lng]) => {
  const spot = h3.latLngToCell(lat, lng, 9);
  return { spot, cell: h3.cellToParent(spot, 8), parents: [7, 5].map((r) => h3.cellToParent(spot, r)) };
});

// ids that are NOT a block: other resolutions, and near-misses of real ones
const flip = (s, i, c) => s.slice(0, i) + c + s.slice(i + 1);
const invalid = new Set();
for (const { spot, cell, parents } of valid.slice(0, 40)) {
  invalid.add(cell);
  parents.forEach((p) => invalid.add(p));
  invalid.add(spot + "0");
  invalid.add(spot.slice(1));
  for (let i = 0; i < 15; i++) for (const c of "0137f") {
    const s = flip(spot, i, c);
    if (s !== spot && !h3.isValidCell(s)) invalid.add(s);
  }
}
// a pentagon's deleted child: first non-zero digit 1
for (const p of h3.getPentagons(9)) {
  const n = BigInt("0x" + p) & ~(7n << 42n) | (1n << 42n);
  const s = n.toString(16);
  if (!h3.isValidCell(s)) invalid.add(s);
}
for (const s of ["", "cellA", "zzzzzzzzzzzzzzz", "-92a1072c63ffff", "+92a1072c63ffff", "892a1072c63fff"]) invalid.add(s);
// h3-js also takes UPPERCASE; the server takes only the app's own
// lowercase (one spelling per area: the ids are topic names)
const uppercase = valid.slice(0, 20).map(({ spot }) => spot.toUpperCase());
for (const s of invalid) if (h3.isValidCell(s) && h3.getResolution(s) === 9) throw new Error(s);

writeFileSync(
  new URL("./h3_cases.json", import.meta.url),
  JSON.stringify({ valid, invalid: [...invalid], uppercase }, null, 0) + "\n",
);
console.log(valid.length, "valid,", invalid.size, "invalid");
