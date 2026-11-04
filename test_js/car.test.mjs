// Node tests for priv/static/car.js — "Your car" (ARCHITECTURE.md): the
// form's rules, the same as the server's (Hoodride.Accounts.User
// car_changeset — the server decides; these only spare a round trip), and
// how the car reads where riders see it.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../priv/static/car.js");

const civic = { color: "Gray", make: "Honda", model: "Civic" };

test("the colors are exactly the server's list, in its order", () => {
  const ex = readFileSync(new URL("../lib/hoodride/accounts/user.ex", import.meta.url), "utf8");
  const server = ex.match(/@car_colors ~w\(([^)]*)\)/)[1].trim().split(/\s+/);
  assert.deepEqual(C.COLORS, server);
});

test("a full car: no problems; tidied like the server (spaces trimmed, squeezed)", () => {
  assert.deepEqual(C.problems(civic), []);
  assert.deepEqual(C.tidy({ color: "White", make: "  Toyota ", model: " Corolla   Cross " }), {
    color: "White",
    make: "Toyota",
    model: "Corolla Cross",
  });
});

test("each wrong field is named: unknown color, blank, over 24, hidden characters", () => {
  assert.deepEqual(C.problems({ ...civic, color: "Sparkly" }), ["color"]);
  assert.deepEqual(C.problems({ ...civic, color: "" }), ["color"]);
  assert.deepEqual(C.problems({ ...civic, make: "   " }), ["make"]);
  assert.deepEqual(C.problems({ ...civic, model: "x".repeat(25) }), ["model"]);
  assert.deepEqual(C.problems({ ...civic, model: "é".repeat(24) }), [], "24 is fine, any language");
  assert.deepEqual(C.problems({ ...civic, make: "Hon​da" }), ["make"], "zero-width space");
  assert.deepEqual(C.problems({ ...civic, model: "Civ‮ic" }), ["model"], "right-to-left override");
  assert.deepEqual(C.problems({ ...civic, model: "Civic\n" }), ["model"]);
  assert.deepEqual(C.problems({}), ["color", "make", "model"]);
});

test("24 means characters as people see them (an accent typed as two codes is one)", () => {
  // "é" as e + a combining accent: 2 code units, 1 character (the server
  // counts the same way — graphemes)
  assert.deepEqual(C.problems({ ...civic, model: "é".repeat(24) }), []);
});

test("where riders see it: ' · Gray Honda Civic', or nothing when none is set", () => {
  assert.equal(C.inLine("Gray Honda Civic"), " · Gray Honda Civic");
  assert.equal(C.inLine(null), "");
  assert.equal(C.inLine(undefined), "");
});

test("suggestions while typing: names starting with it first, then a later word ('Benz')", () => {
  assert.deepEqual(C.suggest("to"), ["Toyota"]);
  assert.deepEqual(C.suggest("M"), ["Mazda", "Mercedes-Benz", "Mini", "Mitsubishi"]);
  assert.deepEqual(C.suggest("benz"), ["Mercedes-Benz"]);
  assert.deepEqual(C.suggest("ro"), ["Land Rover"], "a later word, after a space");
  assert.deepEqual(C.suggest("  hon "), ["Honda"], "spaces around are ignored");
  assert.deepEqual(C.suggest("c"), ["Cadillac", "Chevrolet", "Chrysler"]);
});

test("no suggestions: nothing typed, nothing matches, or it's already a full make", () => {
  assert.deepEqual(C.suggest(""), []);
  assert.deepEqual(C.suggest("   "), []);
  assert.deepEqual(C.suggest("zz"), []);
  assert.deepEqual(C.suggest("honda"), [], "already typed in full");
  assert.deepEqual(C.suggest(undefined), []);
});

test("at most 6 at once (a short list, no scrolling) — the first six, starts first", () => {
  const many = ["Aa1", "Aa2", "Aa3", "Aa4", "Aa5", "Aa6", "Aa7", "Aa8", "X Aa9"];
  assert.deepEqual(C.suggest("aa", many), ["Aa1", "Aa2", "Aa3", "Aa4", "Aa5", "Aa6"]);
  for (const letter of "abcdefghijklmnopqrstuvwxyz") assert.ok(C.suggest(letter).length <= 6, letter);
});

test("the makes suggested: common ones, sorted, no duplicates (any make can still be typed)", () => {
  assert.ok(C.MAKES.length >= 30);
  assert.ok(C.MAKES.includes("Toyota") && C.MAKES.includes("Honda") && C.MAKES.includes("Ford"));
  assert.deepEqual([...C.MAKES].sort((a, b) => a.localeCompare(b)), C.MAKES);
  assert.equal(new Set(C.MAKES).size, C.MAKES.length);
});
