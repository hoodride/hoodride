// The PAGE never zooms on the map screen — only the map does (owner's
// iPhone, 2026-10-29: a pinch on the top bar zoomed the whole page, and
// the pinch back out landed on the map, so the page stayed big).
// The standard fix (MDN touch-action; caniuse: iOS 13+, all Android):
//   1. touch-action: pan-x pan-y — the browser handles no page pinch there.
//      On EVERYTHING inside the map screen: WebKit takes the value only up
//      to the nearest scrolling area (the drawer list, the chat).
//   2. the map handles its own pinch (MapLibre's canvas rules: more
//      specific, so they still win).
//   3. text boxes ≥ 16px: iPhones zoom the page into smaller ones on tap,
//      and don't zoom back out.
// The sign-in screen and the privacy page stay zoomable (low vision).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) =>
  readFileSync(new URL(`../priv/static/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ours = { "styles.css": read("styles.css"), "privacy.css": read("privacy.css") };

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({
    selectors: sel.split(",").map((s) => s.trim()),
    body,
  }));
}

test("the map screen and everything in it: no page pinch-zoom", () => {
  const r = rules(ours["styles.css"]).find(
    (x) => x.selectors.includes(".screen-map") && x.selectors.includes(".screen-map *")
  );
  assert.ok(r, "a rule for .screen-map, .screen-map *");
  assert.match(r.body, /touch-action\s*:\s*pan-x pan-y\s*(;|$)/);
});

test("nothing of ours lets pinch back in (manipulation / pinch-zoom / auto)", () => {
  for (const [file, css] of Object.entries(ours))
    for (const r of rules(css)) {
      const m = r.body.match(/touch-action\s*:\s*([^;]+)/);
      if (m) assert.doesNotMatch(m[1], /manipulation|pinch-zoom|auto/, `${file}: ${r.selectors.join(", ")}`);
    }
});

// the page itself too, while the map screen shows: a touch that reaches
// html/body (an edge, the address bar sliding, the drawer opening) zoomed the
// page — they were "auto" (owner's iPhone, 2026-10-30). Standard: touch-action
// on html and body; app.js marks html "on-map" with the screen
test("while the map screen shows, html and body don't zoom either", () => {
  const r = rules(ours["styles.css"]).find(
    (x) => x.selectors.includes("html.on-map") && x.selectors.includes("html.on-map body")
  );
  assert.ok(r, "a rule for html.on-map, html.on-map body");
  assert.match(r.body, /touch-action\s*:\s*pan-x pan-y\s*(;|$)/);
  const app = readFileSync(new URL("../priv/static/app.js", import.meta.url), "utf8");
  const show = app.match(/function show\(screenId\) \{[\s\S]*?\n\}/)[0];
  assert.ok(show.includes('document.documentElement.classList.toggle("on-map", screenId === "screen-map");'), show);
});

test("the sign-in screen and the privacy page stay zoomable", () => {
  for (const r of rules(ours["styles.css"])) {
    if (!/touch-action/.test(r.body)) continue;
    for (const s of r.selectors)
      assert.ok(s.startsWith(".screen-map") || s.startsWith("html.on-map"), `touch-action outside the map screen: ${s}`);
  }
  assert.doesNotMatch(ours["privacy.css"], /touch-action/);
});

test("every text box is at least 16px (iPhones zoom the page into smaller ones)", () => {
  const boxes = [];
  for (const r of rules(ours["styles.css"])) {
    if (!r.selectors.some((s) => /\b(input|select|textarea)\b/.test(s))) continue;
    const m = r.body.match(/font-size\s*:\s*([\d.]+)px/);
    if (m) boxes.push([r.selectors.join(", "), Number(m[1])]);
  }
  assert.ok(boxes.some(([s]) => s.includes(".chat-form input")), "the chat box sets its size");
  for (const [sel, px] of boxes) assert.ok(px >= 16, `${sel}: ${px}px`);
});
