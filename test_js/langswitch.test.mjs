// Node tests for priv/static/langswitch.js — the language switch: each
// language in its own words, a list a person can scan, the pick's cookie.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const L = require("../priv/static/langswitch.js");

test("each language in its own words, capitalized as it writes it", () => {
  assert.equal(L.name("en"), "English");
  assert.equal(L.name("es"), "Español");
  assert.equal(L.name("ja"), "日本語");
  assert.equal(L.name("ar"), "العربية");
  assert.equal(L.name("zh-Hant"), "繁體中文");
  assert.equal(L.name("id"), "Bahasa Indonesia", "as it names itself in menus");
  assert.equal(L.name("ms"), "Bahasa Melayu");
  assert.equal(L.name("tr"), "Türkçe");
});

test("an unknown tag: some name, never a crash", () => {
  for (const tag of ["xx-YY", "", "not a tag!"]) assert.equal(typeof L.name(tag), "string", tag);
});

test("the list: by own name, every language once", () => {
  const list = L.sorted(["ja", "es", "en", "de", "ar"]);
  assert.deepEqual(list.map((x) => x.tag).slice(0, 3), ["de", "en", "es"], "Deutsch, English, Español");
  assert.equal(list.length, 5);
});

test("the pick's cookie: a year, the whole site, Lax; Secure on https", () => {
  assert.equal(L.cookie("es", false), "hoodride_lang=es; path=/; max-age=31536000; SameSite=Lax");
  assert.equal(L.cookie("pt-BR", true), "hoodride_lang=pt-BR; path=/; max-age=31536000; SameSite=Lax; Secure");
  assert.equal(L.COOKIE, "hoodride_lang");
});

// ----- the search (owner, 2026-11-05: NN/g, Baymard — type to find in a
// long list; GOV.UK and DfE — other names, an exact match first) -----
const ALL = "en es pt-BR fr it ca de nl sv da nb fi zh-Hans zh-Hant ja ko vi th id ms fil tr ru uk pl cs sk hr sl ro hu el sw hi bn mr te ta gu kn ml or pa ar he ur".split(" ");
const found = (q, page = "en") => L.search(ALL, q, page).map((x) => x.tag);

test("search: nothing typed — every language, in the list's order", () => {
  assert.deepEqual(found(""), L.sorted(ALL).map((x) => x.tag));
  assert.deepEqual(found("   "), L.sorted(ALL).map((x) => x.tag));
});

test("search: by its own name, its English name, the page's language's name", () => {
  assert.deepEqual(found("Español"), ["es"]);
  assert.deepEqual(found("span"), ["es"], "English");
  assert.deepEqual(found("allemand", "fr"), ["de"], "French, on a French page");
  assert.deepEqual(found("日本"), ["ja"]);
  assert.deepEqual(found("arab"), ["ar"]);
});

test("search: no accents or capitals needed", () => {
  assert.deepEqual(found("espanol"), ["es"]);
  assert.deepEqual(found("TURKCE"), ["tr"]);
  assert.deepEqual(found("francais"), ["fr"]);
});

test("search: other names people type", () => {
  assert.deepEqual(found("tagalog"), ["fil"]);
  assert.deepEqual(found("mandarin"), ["zh-Hans"]);
  assert.deepEqual(found("norwegian"), ["nb"]);
  assert.deepEqual(found("bengali"), ["bn"]);
  assert.deepEqual(found("中文").sort(), ["zh-Hans", "zh-Hant"]);
});

test("search: the closest first — the whole name, then a start, then inside", () => {
  assert.equal(found("english")[0], "en");
  const e = found("e");
  assert.ok(e.indexOf("en") < e.indexOf("id"), "English (starts with e) before Bahasa Indonesia (only inside)");
  assert.equal(found("malay")[0], "ms", "Malay before Malayalam");
});

test("search: nothing matches — an empty list (the page says so)", () => {
  assert.deepEqual(found("zzqx"), []);
});

// ----- each language's own address (owner, 2026-11-05: Google — separate
// URLs per language; English stays at /) -----
test("a language's home address: English /, the rest /<tag> as the server spells it", () => {
  assert.equal(L.home("en"), "/");
  assert.equal(L.home("ja"), "/ja");
  assert.equal(L.home("pt-BR"), "/pt-BR");
  assert.equal(L.home("zh-Hant"), "/zh-Hant");
});

// the legal pages' language list is plain HTML: the server writes the
// names (Hoodride.I18n.name) — the same as the app's switch shows
test("the server's language names are the switch's own", () => {
  const ex = readFileSync(new URL("../lib/hoodride/i18n.ex", import.meta.url), "utf8");
  const block = ex.match(/@names %\{([\s\S]*?)\n  \}/)[1];
  const names = Object.fromEntries([...block.matchAll(/"([^"]+)" => "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const known = ex.match(/@known ~w\(([^)]*)\)/)[1].split(/\s+/).filter((t) => t !== "en-XA");
  assert.deepEqual(Object.keys(names).sort(), [...known].sort(), "a name for every language");
  for (const tag of known) assert.equal(names[tag], L.name(tag), tag);
});
