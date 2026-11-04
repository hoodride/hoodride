// Node tests for the pile rules in priv/static/browse.js. Fuzzed markers in
// one block sit on EXACTLY the same point, so they'd stack with only the top
// one tappable — and zooming never separates identical points. One marker
// per (type, spot) instead: a visible pile, a tap opens a list (usability
// research favours a list over tiny fanned-out pins on phones, and finds
// bare numbered bubbles confusing).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = require("../priv/static/browse.js");

// the app's marker store: id → {type, spot}
const entries = (rows) => new Map(rows.map(([id, type, spot]) => [id, { type, spot }]));

test("markers in one spot are one group; other spots stay separate", () => {
  const groups = B.groupMarkers(
    entries([
      [1, "driver", "s1"],
      [2, "driver", "s1"],
      [3, "driver", "s2"],
    ])
  );
  assert.deepEqual(
    groups.map((g) => [g.key, g.ids]),
    [
      ["driver:s1", [1, 2]],
      ["driver:s2", [3]],
    ]
  );
});

test("a car and a hand never share a pile, even at the same spot", () => {
  const groups = B.groupMarkers(
    entries([
      [1, "driver", "s1"],
      [2, "hand", "s1"],
    ])
  );
  assert.equal(groups.length, 2);
});

test("the ride partner is never piled (it isn't a browse marker)", () => {
  const groups = B.groupMarkers(
    entries([
      [1, "ridepeer", "s1"],
      [2, "driver", "s1"],
    ])
  );
  assert.deepEqual(
    groups.map((g) => g.ids),
    [[2]]
  );
});

test("someone leaving shrinks the pile; the last one leaving dissolves it", () => {
  const held = entries([
    [1, "driver", "s1"],
    [2, "driver", "s1"],
  ]);
  held.delete(1);
  assert.deepEqual(
    B.groupMarkers(held).map((g) => g.ids),
    [[2]]
  );
  held.delete(2);
  assert.deepEqual(B.groupMarkers(held), []);
});

test("the pile's look: up to three icons, then +N", () => {
  assert.deepEqual(B.pileLook(1), { icons: 1, more: 0 });
  assert.deepEqual(B.pileLook(2), { icons: 2, more: 0 });
  assert.deepEqual(B.pileLook(3), { icons: 3, more: 0 });
  assert.deepEqual(B.pileLook(5), { icons: 3, more: 2 });
});

test("reveal only when the name isn't known yet", () => {
  assert.equal(B.needsReveal({ name: "…" }), true);
  assert.equal(B.needsReveal({ name: "" }), true);
  assert.equal(B.needsReveal({}), true);
  assert.equal(B.needsReveal({ name: "Maria" }), false);
});

test("a different server protocol asks for a reload; an unknown one doesn't nag", () => {
  assert.equal(B.versionMismatch(2, 2), false);
  assert.equal(B.versionMismatch(3, 2), true);
  assert.equal(B.versionMismatch(undefined, 2), false);
});
