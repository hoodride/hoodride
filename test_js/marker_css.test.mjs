// Map markers are placed by MapLibre: it gives every marker element
// `position: absolute` (.maplibregl-marker) and moves it with a transform.
// A style of ours that sets `position` on the marker element itself wins
// (more specific) and breaks that: `.marker-bubble.pile { position:
// relative }` put piles back in the page flow, so each pile sat lower by
// the height of the piles before it — they slid up and down as piles came
// and went on zoom (seen with the monster crowd; single cars were fine).
// Children inside a marker (".marker-bubble .pile-more") may set it.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../priv/static/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

// the classes app.js gives a marker's own element
const MARKER_ROOT = /^\.marker-(bubble|me|pin)(\.[\w-]+)*(:[\w-]+(\([^)]*\))?)*$/;

test("no style sets `position` on a marker element (MapLibre owns it)", () => {
  const offenders = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/(^|;)\s*position\s*:/.test(body)) continue;
    for (const sel of selectors.split(",").map((s) => s.trim()))
      if (MARKER_ROOT.test(sel)) offenders.push(`${sel} { ${body.trim()} }`);
  }
  assert.deepEqual(offenders, []);
});

// A click is button-down + button-up on the SAME element. The icons inside
// a pile are redrawn whenever a car in it updates (~14×/s with a crowd); a
// redraw between down and up replaced the pressed icon and Chrome dropped
// the click — it took several clicks to open a pile (proven in Chrome: a
// forced redraw mid-click → 0 of 3 opened). Click-through children make
// the pressed element always the marker itself, which is never replaced.
test("everything inside a marker is click-through (a redraw can't steal a click)", () => {
  const clickThrough = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].some(
    ([, sel, body]) =>
      sel.split(",").some((s) => /^\.marker-bubble\s*>\s*\*$/.test(s.trim())) &&
      /(^|;)\s*pointer-events\s*:\s*none\s*(;|$)/.test(body)
  );
  assert.ok(clickThrough, "expected `.marker-bubble > * { pointer-events: none }`");
});

// The top bar spans the full width over the map (a dark fade keeps its white
// title readable). It caught every click, so a car or ✋ under its faded
// part couldn't be tapped, nor the map dragged from there (owner found it).
// Kept: the fade. Made click-through: the bar — except its buttons.
const rule = (selector) =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) =>
    sel.split(",").some((s) => s.trim() === selector)
  );
const pointerEvents = (selector) => {
  const r = rule(selector);
  const m = r && r[2].match(/(?:^|;)\s*pointer-events\s*:\s*([\w-]+)/);
  return m ? m[1] : null;
};

test("the top bar lets clicks through to the map, its buttons don't", () => {
  assert.equal(pointerEvents(".topbar"), "none");
  assert.equal(pointerEvents(".topbar button"), "auto");
});

// the bottom row spans the screen's width too: the map beside and between
// its buttons must drag and pinch (owner, 2026-11-02) — every child, the
// Navigate link (an <a>) as well, still catches its own tap
test("the bottom row lets touches through to the map, its buttons and link don't", () => {
  assert.equal(pointerEvents(".bottom-controls"), "none");
  assert.equal(pointerEvents(".bottom-controls > *"), "auto");
});

test("the top bar keeps its fade (the white title must stay readable)", () => {
  assert.match(rule(".topbar")[2], /background:\s*linear-gradient/);
});

test("the check sees a marker's own element, not its children", () => {
  assert.ok(MARKER_ROOT.test(".marker-bubble.pile"));
  assert.ok(MARKER_ROOT.test(".marker-bubble:not(.pile)"));
  assert.ok(!MARKER_ROOT.test(".marker-bubble .pile-more"));
});

// One border colour on the map (owner, 2026-11-08): hands and cars alike
// have the app's yellow edge (--accent). The hands kept a green one
// (.marker-bubble.hand) after the switch back to yellow.
test("no marker overrides the yellow border (hands look like cars)", () => {
  const offenders = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/(^|;)\s*border(-color|-top-color|-right-color|-bottom-color|-left-color)?\s*:/.test(body)) continue;
    for (const sel of selectors.split(",").map((s) => s.trim()))
      if (/^\.marker-bubble(\.[\w-]+|:[\w-]+)+$/.test(sel)) offenders.push(`${sel} { ${body.trim()} }`);
  }
  assert.deepEqual(offenders, []);
  assert.match(css, /\.marker-bubble\s*\{[^}]*border:\s*2px solid var\(--accent\)/);
});

// find the nearest measures a marker by its element's box and its parts'
// (app.js markerReach): anything drawn OUTSIDE those boxes, or changing them
// mid-search, would make "in sight" disagree with what you see — so no
// marker style may scale/move/animate it, draw a pseudo-element, a filter
// shadow, an outline or a solid ring (a soft shadow is fine: the map shows
// through it) — and its size stays tied to NEAR_HALF (22 px: a 44 px bubble)
test("no marker style draws outside its boxes or changes them (find the nearest measures the boxes)", () => {
  const offenders = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const sel of selectors.split(",").map((s) => s.trim())) {
      if (!/^\.marker-bubble\b/.test(sel)) continue;
      if (/::?(before|after)\b/.test(sel)) offenders.push(`${sel}: a pseudo-element`);
      const transform = /(^|;)\s*transform\s*:\s*([^;]+)/.exec(body);
      if (transform && !(sel === ".marker-bubble .pile-icon" && /^translate\(-50%,\s*-50%\)$/.test(transform[2].trim())))
        offenders.push(`${sel}: transform ${transform[2].trim()}`);
      for (const prop of ["animation", "transition", "filter", "outline"])
        if (new RegExp(`(^|;)\s*${prop}(-[a-z-]+)?\s*:`).test(body)) offenders.push(`${sel}: ${prop}`);
      const shadow = /(^|;)\s*box-shadow\s*:\s*([^;]+)/.exec(body);
      // a spread with no blur is a solid ring (ringReach): it would draw past the box
      if (shadow && /(^|,)\s*(rgba?\([^)]*\)|#\w+|\w+)?\s*-?\d+(px)?\s+-?\d+(px)?\s+0(px)?\s+[1-9]/.test(shadow[2])) offenders.push(`${sel}: a solid ring`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a marker's size stays what find the nearest assumes: a 44 px bubble (NEAR_HALF 22), a 74 px group", () => {
  const m = /(^|[}\s])\.marker-bubble\s*\{([^}]*)\}/.exec(css);
  const bubble = m ? m[2] : "";
  assert.match(bubble, /width:\s*44px/);
  assert.match(bubble, /height:\s*44px/);
  const app = readFileSync(new URL("../priv/static/app.js", import.meta.url), "utf8");
  assert.match(app, /^const NEAR_HALF = \{ x: 22, y: 22 \};$/m);
  assert.match(css, /\.marker-bubble\.pile\s*\{[^}]*width:\s*74px/);
});
