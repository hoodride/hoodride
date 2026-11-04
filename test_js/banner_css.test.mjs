// The top banner WRAPS, never cuts off: a "location is blocked" message
// carries the steps to fix it, and one line with "…" hid exactly the part
// that says where to tap on a phone (owner's iPhone, 2026-10-29). Short
// messages still fit on one line (max-content), capped to the screen.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../priv/static/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

function rule(selector) {
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g))
    if (selectors.split(",").map((s) => s.trim()).includes(selector)) return body;
  return null;
}

test("the banner wraps onto more lines instead of cutting off", () => {
  const b = rule(".banner");
  assert.ok(b, "a .banner rule");
  assert.doesNotMatch(b, /white-space\s*:\s*nowrap/, "one line only");
  assert.doesNotMatch(b, /text-overflow\s*:\s*ellipsis/, "cut off with …");
  assert.doesNotMatch(b, /overflow\s*:\s*hidden/, "the rest hidden");
  assert.match(b, /white-space\s*:\s*normal/);
  assert.match(b, /max-width\s*:/, "never wider than the screen");
});
