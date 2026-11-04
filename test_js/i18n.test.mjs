// Hood Ride in the reader's language (owner, 2026-11-04): HoodI18n's
// lookup. English is the key and the fallback — never a blank, never a key.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../priv/static/i18n.js");

const ES = {
  lang: "es",
  messages: {
    "Need a ride": "Necesito un viaje",
    "Hi {name}": "Hola, {name}",
    ["button" + "\u0004" + "Drive"]: "Conducir",
    ["{count} car" + "\u0000" + "{count} cars"]: { one: "{count} auto", other: "{count} autos" },
    ["{count} ride" + "\u0000" + "{count} rides"]: { one: "{count} viaje", many: "{count} de viajes", other: "{count} viajes" },
    "Left blank": "",
  },
};

beforeEach(() => I.load(null));

test("English: the message itself, with its placeholders filled", () => {
  assert.equal(I.lang(), "en");
  assert.equal(I.t("Need a ride"), "Need a ride");
  assert.equal(I.t("Hi {name}", { name: "Rita" }), "Hi Rita");
});

test("a catalog: the translation, placeholders filled", () => {
  assert.equal(I.load(ES), "es");
  assert.equal(I.t("Need a ride"), "Necesito un viaje");
  assert.equal(I.t("Hi {name}", { name: "Rita" }), "Hola, Rita");
});

test("not translated (missing, or left empty): the English, never blank", () => {
  I.load(ES);
  assert.equal(I.t("Go online"), "Go online");
  assert.equal(I.t("Left blank"), "Left blank");
});

test("a placeholder with no value stays visible, never 'undefined'", () => {
  assert.equal(I.t("Hi {name}"), "Hi {name}");
  assert.equal(I.t("Hi {name}", { name: null }), "Hi {name}");
  assert.equal(I.t("Hi {name}", { other: 1 }), "Hi {name}");
});

test("a value that looks like a placeholder is not filled again", () => {
  assert.equal(I.t("Hi {name}", { name: "{name}" }), "Hi {name}");
  assert.equal(I.fill("{a} {b}", { a: "{b}", b: "x" }), "{b} x");
});

test("context: the same English, two meanings", () => {
  I.load(ES);
  assert.equal(I.tc("button", "Drive"), "Conducir");
  assert.equal(I.tc("verb", "Drive"), "Drive"); // another context: not translated
  assert.equal(I.t("Drive"), "Drive"); // no context: a different message
});

test("plurals in English: 1 is singular, everything else plural", () => {
  for (const [n, s] of [[0, "0 cars"], [1, "1 car"], [2, "2 cars"], [1000000, "1000000 cars"]])
    assert.equal(I.tn("{count} car", "{count} cars", n), s);
});

test("plurals in Spanish: one / other by the browser's rules", () => {
  I.load(ES);
  assert.equal(I.tn("{count} car", "{count} cars", 1), "1 auto");
  assert.equal(I.tn("{count} car", "{count} cars", 2), "2 autos");
  assert.equal(I.tn("{count} car", "{count} cars", 0), "0 autos");
});

// CLDR gives Spanish a third form for exact millions ("1 millón DE viajes");
// a .po with only two forms has none: "other" then, never blank
test("Spanish 'many' (millions): used when present, else 'other'", () => {
  I.load(ES);
  const category = new Intl.PluralRules("es").select(1000000);
  assert.equal(I.tn("{count} ride", "{count} rides", 1000000), category === "many" ? "1000000 de viajes" : "1000000 viajes");
  assert.equal(I.tn("{count} car", "{count} cars", 1000000), "1000000 autos");
});

test("a plural left empty: the English forms, never blank", () => {
  I.load({ lang: "es", messages: { ["{count} car" + "\u0000" + "{count} cars"]: { one: "", other: "" } } });
  assert.equal(I.tn("{count} car", "{count} cars", 1), "1 car");
  assert.equal(I.tn("{count} car", "{count} cars", 4), "4 cars");
});

test("a plural not translated: the English forms", () => {
  I.load(ES);
  assert.equal(I.tn("{count} hand", "{count} hands", 1), "1 hand");
  assert.equal(I.tn("{count} hand", "{count} hands", 3), "3 hands");
});

test("a broken catalog is no catalog: English", () => {
  for (const bad of [undefined, {}, { lang: "es" }, { messages: {} }, { lang: 5, messages: {} }, "es"]) {
    assert.equal(I.load(bad), "en");
    assert.equal(I.t("Need a ride"), "Need a ride");
  }
});
