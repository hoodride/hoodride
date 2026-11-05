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

// ----- translatePage: the page's marked words (index.html) -----
// a stand-in for the few DOM parts it uses (Node has no page)
function textNode(value) {
  return { nodeType: 3, nodeValue: value, get textContent() { return this.nodeValue; } };
}
function el(tag, attrs = {}, ...kids) {
  const e = {
    nodeType: 1,
    tag,
    attrs: { ...attrs },
    childNodes: [],
    ownerDocument: { createTextNode: textNode },
    hasAttribute: (n) => n in e.attrs,
    getAttribute: (n) => (n in e.attrs ? e.attrs[n] : null),
    setAttribute: (n, v) => (e.attrs[n] = String(v)),
    replaceChildren: (...ns) => (e.childNodes = ns),
    querySelectorAll: (sel) => {
      const name = sel.slice(1, -1); // "[data-t]"
      const out = [];
      const walk = (n) => n.childNodes.forEach((c) => c.nodeType === 1 && (c.hasAttribute(name) && out.push(c), walk(c)));
      walk(e);
      return out;
    },
    get text() {
      return e.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : `<${c.tag}>${c.text}</${c.tag}>`)).join("");
    },
  };
  e.childNodes = kids.map((k) => (typeof k === "string" ? textNode(k) : k));
  return e;
}

const PAGE_ES = {
  lang: "es",
  messages: {
    Save: "Guardar",
    ["nav" + "\u0004" + "Change"]: "Cambiar",
    "By continuing, you agree to our {terms} and {privacy}.": "Al continuar, aceptas nuestra {privacy} y nuestros {terms}.",
    Terms: "Términos",
    "Privacy Policy": "Política de privacidad",
    Color: "Color del auto",
    Close: "Cerrar",
    "Message…": "Mensaje…",
  },
};

test("translatePage: in English the page is left exactly as it is", () => {
  I.load(null);
  const save = el("button", { "data-t": "" }, "\n  Save\n");
  const page = el("body", {}, save);
  I.translatePage(page);
  assert.equal(save.text, "\n  Save\n");
});

test("translatePage: words, a context, slots moved as the language orders them (the same links)", () => {
  const terms = el("a", { href: "/terms", "data-t": "", "data-t-slot": "terms" }, "Terms");
  const privacy = el("a", { href: "/privacy", "data-t": "", "data-t-slot": "privacy" }, "Privacy Policy");
  const fine = el("p", { "data-t": "" }, "By continuing, you agree to our ", terms, " and ", privacy, ".");
  const save = el("button", { "data-t": "" }, "Save");
  const change = el("button", { "data-t": "nav" }, "Change");
  const page = el("body", {}, fine, save, change);
  I.load(PAGE_ES);
  try {
    I.translatePage(page);
    assert.equal(save.text, "Guardar");
    assert.equal(change.text, "Cambiar");
    assert.equal(fine.text, "Al continuar, aceptas nuestra <a>Política de privacidad</a> y nuestros <a>Términos</a>.");
    assert.equal(fine.childNodes[1], privacy, "the same link element, moved");
    assert.equal(privacy.attrs.href, "/privacy");
  } finally {
    I.load(null);
  }
});

test("translatePage: an icon before and a field after stay; labels; untranslated stays English; twice is the same", () => {
  const icon = el("img", { src: "car.png" });
  const drive = el("button", { "data-t": "" }, icon, "Drive");
  const select = el("select", {}, el("option", { "data-t": "" }, "Choose…"));
  const color = el("label", { "data-t": "" }, "Color\n  ", select, "\n");
  const close = el("button", { "aria-label": "Close", title: "Close", "data-t-attr": "aria-label" }, "✕");
  const input = el("input", { placeholder: "Message…", "data-t-attr": "placeholder" });
  const page = el("body", {}, drive, color, close, input);
  I.load(PAGE_ES);
  try {
    I.translatePage(page);
    I.translatePage(page);
    assert.equal(drive.childNodes[0], icon);
    assert.equal(drive.text, "<img></img>Drive", "no translation: the English");
    assert.equal(color.childNodes[0].nodeValue, "Color del auto");
    assert.equal(color.childNodes[1], select);
    assert.equal(close.attrs["aria-label"], "Cerrar");
    assert.equal(close.attrs.title, "Close", "only the attributes named");
    assert.equal(input.attrs.placeholder, "Mensaje…");
  } finally {
    I.load(null);
  }
});

test("translatePage: an element between the words is left alone (the collector refuses it too)", () => {
  const b = el("b", {}, "here");
  const p = el("p", { "data-t": "" }, "Tap ", b, " now");
  I.load({ lang: "es", messages: { "Tap here now": "x", "Tap {x} now": "x" } });
  try {
    I.translatePage(el("body", {}, p));
    assert.equal(p.text, "Tap <b>here</b> now");
  } finally {
    I.load(null);
  }
});
