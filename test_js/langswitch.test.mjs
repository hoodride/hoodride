// Node tests for priv/static/langswitch.js — the language switch: each
// language in its own words, a list a person can scan, the pick's cookie.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
