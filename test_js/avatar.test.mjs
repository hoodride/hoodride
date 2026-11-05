// Node tests for priv/static/avatar.js — the photo of someone without one
// (owner, 2026-11-01): their first initial on a colour of their own, as
// Google does; a grey silhouette when the name has no letter to show.
// Never a 🙂.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../priv/static/avatar.js");

test("the first letter, as a capital — in any alphabet", () => {
  const cases = {
    Rita: "R",
    "  dan ": "D",
    "Élodie": "É",
    "Дмитрий": "Д",
    "محمد": "م",
    "沐阳": "沐",
    "민준": "민",
    "Ωmega": "Ω",
    "BT-Rita": "B",
  };
  for (const [name, letter] of Object.entries(cases)) assert.equal(A.initial(name), letter, name);
});

test("a letter with its accent marks stays whole (e + combining acute)", () => {
  assert.equal(A.initial("émilie"), "É");
});

test("no letter to show: an emoji, a number, a symbol, nothing", () => {
  for (const name of ["😎 Mike", "2Chainz", "★Star", "(Joe)", "", "   ", null, undefined])
    assert.equal(A.initial(name), null, String(name));
});

test("each person keeps one colour (the same name, the same colour), from the set", () => {
  assert.equal(A.color("Rita"), A.color("Rita"));
  assert.equal(A.color("Rita"), A.color(" rita "));
  for (const n of ["Rita", "Dan", "Eve", "Finn", "Gail", "沐阳", "محمد"]) assert.ok(A.COLORS.includes(A.color(n)), n);
  // not all one colour
  assert.ok(new Set(["Rita", "Dan", "Eve", "Finn", "Gail", "Hana", "Ivan", "Jo"].map(A.color)).size >= 3);
});

// WCAG relative luminance: white letters must reach 4.5:1 on every colour
function contrastWithWhite(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05);
}

test("white letters are easy to read on every colour (4.5:1 or more)", () => {
  for (const hex of A.COLORS) assert.ok(contrastWithWhite(hex) >= 4.5, `${hex}: ${contrastWithWhite(hex).toFixed(2)}`);
  assert.ok(A.COLORS.length >= 5);
  // never the app's yellow
  assert.ok(!A.COLORS.some((h) => h.toLowerCase() === "#ffc107"));
});

test("the picture: the letter on the colour, or the silhouette — never an emoji", () => {
  const r = A.svg("Rita");
  assert.match(r, /^<svg /);
  assert.ok(r.includes(`fill="${A.color("Rita")}"`));
  assert.match(r, />R<\/text>/);
  assert.ok(!r.includes("\u{1F642}"));

  const s = A.svg("😎 Mike");
  assert.ok(!s.includes("<text"), "a silhouette has no letter");
  assert.ok(s.includes(`fill="${A.SILHOUETTE}"`));
  assert.ok(!s.includes("😎"));
});

test("as an image address: a data URL the page can show", () => {
  const u = A.url("Dan");
  assert.ok(u.startsWith("data:image/svg+xml,"));
  assert.equal(decodeURIComponent(u.slice("data:image/svg+xml,".length)), A.svg("Dan"));
});

// ----- gaps a mutation sweep found (Stryker, owner 2026-11-05) -----

test("a person's colour comes from the name alone — capitals and spaces around it never change it", () => {
  // the rule, computed here on its own: the lowercased, trimmed name's code
  // points hashed ×31, picking one of the colours
  const expected = (name) => {
    let h = 0;
    for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return A.COLORS[h % A.COLORS.length];
  };
  for (const name of ["Dan", "Jaylen", "María", "Ωmega", "李雷", "Zoe Ann"]) {
    assert.equal(A.color(name), expected(name), name);
    assert.equal(A.color(`  ${name.toUpperCase()}  `), expected(name), `${name}, in capitals with spaces`);
  }
  assert.equal(A.color(null), A.color(""), "no name: one fixed colour");
});

test("no letter to show: the grey silhouette (head and shoulders), never a coloured square", () => {
  assert.equal(A.SILHOUETTE, "#666666");
  const s = A.svg("🙂");
  assert.match(s, /fill="#666666"/);
  assert.match(s, /<circle /);
  assert.match(s, /<path d="M16 96/);
  assert.doesNotMatch(s, /<text/);
});
