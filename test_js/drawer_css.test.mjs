// "Reduce motion" (a phone's own setting, for people made dizzy by moving
// screens): Settings appears and goes AT ONCE — opening too, not only
// closing. The open drawer's own slide rule is more specific than a plain
// ".drawer" rule, so the reduced-motion rule must name the open state too
// (owner, 2026-11-09: it slid open anyway). The browser check:
// test_browser/findnearestcover.mjs (reduced motion).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../priv/static/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// the rules inside every @media (prefers-reduced-motion: reduce) block
function reducedRules() {
  const out = [];
  for (const m of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    for (const [, sel, body] of css.slice(start, i - 1).matchAll(/([^{}]+)\{([^}]*)\}/g))
      out.push({ selectors: sel.split(",").map((s) => s.trim()), body });
  }
  return out;
}

const transitionNone = (selector) =>
  reducedRules().some((r) => r.selectors.includes(selector) && /transition\s*:\s*none/.test(r.body));

test("reduce motion: the drawer and its backdrop don't slide or fade — closed or OPEN", () => {
  for (const sel of [".drawer", ".drawer-backdrop", ".drawer.open", ".drawer-backdrop.open"])
    assert.ok(transitionNone(sel), `${sel}: no transition under reduced motion`);
});

test("(the check sees it: the open drawer slides by its own rule otherwise)", () => {
  const open = [...css.matchAll(/([^{}@]+)\{([^}]*)\}/g)].find(([, s]) => s.split(",").map((x) => x.trim()).includes(".drawer.open"));
  assert.ok(open && /transition\s*:\s*transform/.test(open[2]), "the open drawer's own slide");
});
