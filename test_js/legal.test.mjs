// The privacy policy and Terms of Use in every language (owner, 2026-11-05:
// all 45 with the app, each saying the English version applies unless
// local law says otherwise). Each translation is a whole copy beside the
// English page — privacy.<lang>.html, terms.<lang>.html (PageController
// .legal_file) — and must stay the same document: the same sections,
// links, lists and tables, the same effective date, the app's own button
// names, and a note at the top linking to the English original.
//
// It can't fall out of date quietly: each copy names the English page it
// was translated from (<meta name="translation-of"> — the first 16 hex of
// its SHA-256). Change the English page and this fails until every copy is
// translated again from the new one.
//
// Run: node --test test_js/legal.test.mjs     (part of `mix precommit`)
//   just some languages, while translating: LEGAL_LANGS=es,fr node --test …
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const STATIC = new URL("../priv/static/", import.meta.url);
const GETTEXT = new URL("../priv/gettext/", import.meta.url);
// right to left: the app's own list (Hoodride.I18n @rtl) — one list, so a
// new right-to-left language can't be missed here (Persian was, 2026-11-05)
const RTL = readFileSync(new URL("../lib/hoodride/i18n.ex", import.meta.url), "utf8")
  .match(/@rtl ~w\(([^)]*)\)/)[1]
  .split(/\s+/);

// every translated language: the app's own (a .po for each)
const ALL = readdirSync(GETTEXT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name.replace("_", "-"))
  .sort();
const LANGS = process.env.LEGAL_LANGS ? process.env.LEGAL_LANGS.split(",") : ALL;

const read = (name) => readFileSync(new URL(name, STATIC), "utf8");
const fingerprint = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
const all = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const count = (html, tag) => (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
const noComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
const text = (s) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// the app's own words for a label, in a language (its .po)
function label(lang, msgid) {
  const po = readFileSync(new URL(`${lang.replace("-", "_")}/LC_MESSAGES/default.po`, GETTEXT), "utf8");
  const blocks = po.split(/\n\n+/);
  for (const b of blocks) {
    if (/^msgctxt /m.test(b)) continue;
    const m = b.match(new RegExp(`^msgid "${msgid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\nmsgstr "(.*)"$`, "m"));
    if (m) return m[1];
  }
  throw new Error(`${lang}: no "${msgid}" in its .po`);
}

// where Firefox's own translation keeps "Do Not Track" in English
// (mozilla-l10n/firefox-l10n, preferences.ftl: do-not-track-removal3)
const DNT_ENGLISH = ["it", "de", "zh-Hant", "ja", "th", "tr", "pl", "cs", "hu"];

// the buttons each page names: the reader must find them by the same words
const LABELS = {
  privacy: ["Privacy Policy", "Delete account", "Refresh from Google", "Change", "Navigate", "Sign out"],
  terms: ["Privacy Policy"],
};

test("every app language has its own privacy policy and terms", () => {
  assert.ok(ALL.length >= 45, `languages: ${ALL.length}`);
  const missing = ALL.flatMap((l) => ["privacy", "terms"].map((p) => `${p}.${l}.html`)).filter((f) => !existsSync(new URL(f, STATIC)));
  assert.deepEqual(missing, []);
});

for (const page of ["privacy", "terms"]) {
  const en = read(`${page}.html`);
  const enBody = noComments(en);
  const enDate = en.match(/data-effective="([\d-]+)"/)[1];
  const enHrefs = all(enBody, /href="([^"]*)"/g).sort();
  const enIds = all(enBody, /\sid="([^"]*)"/g).sort();
  // the English phrases, to catch any left untranslated — a whole paragraph
  // or half of one: each run of text between tags, cut at punctuation;
  // those with English words in them beyond the names that stay as they are
  const KEEP = /Hood Ride|Google Maps|Google|Cloudflare Web Analytics|Cloudflare|OpenFreeMap|Do Not Track|HTTPS|contact@hoodride\.app|\bIP\b/g;
  const enTexts = [
    ...new Set(
      all(noComments(enBody.split("<body>")[1]), />([^<]+)</g)
        .flatMap((run) => run.replace(/\S+@\S+/g, " ").split(/[.;:!?()"“”—]/))
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter((t) => t.replace(KEEP, "").replace(/[^A-Za-z]/g, "").length >= 14)
    ),
  ];

  for (const lang of LANGS) {
    test(`${page}.${lang}.html: the same document, in ${lang}`, () => {
      const file = `${page}.${lang}.html`;
      assert.ok(existsSync(new URL(file, STATIC)), `${file} missing`);
      const html = read(file);
      const body = noComments(html);

      // clean text: no hidden control characters (a mangled escape once
      // slipped one in) and no replacement characters (broken encoding)
      assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/.test(html), "hidden or broken characters");
      assert.match(html, /^<!doctype html>\n/);
      assert.match(html, /<meta charset="utf-8" \/>/);
      const htmlTag = html.match(/<html([^>]*)>/)[1];
      assert.match(htmlTag, new RegExp(`\\slang="${lang}"`), "html lang");
      assert.equal(/\sdir="rtl"/.test(htmlTag), RTL.includes(lang), "right to left exactly for Arabic, Hebrew, Urdu");
      assert.match(html, /<link rel="stylesheet" href="privacy\.css" \/>/);

      // translated from the English page as it is now
      const from = html.match(/<meta name="translation-of" content="([0-9a-f]{16})" \/>/);
      assert.ok(from, "names the English page it was translated from");
      assert.equal(from[1], fingerprint(en), `${file} was translated from an older English ${page}.html — translate it again`);

      // the same effective date
      assert.equal((html.match(/data-effective="([\d-]+)"/) || [])[1], enDate, "the effective date");

      // the note: once, right after the date, linking to the English page
      const notes = all(body, /<p class="translation-note">([\s\S]*?)<\/p>/g);
      assert.equal(notes.length, 1, "one translation note");
      assert.ok(notes[0].includes(`href="/${page}?lang=en"`), "the note links to the English version");
      assert.ok(text(notes[0]).length > 40, "the note says it in words");
      assert.match(body, /data-effective="[\d-]+">[^<]*<\/p>\s*<p class="translation-note">/, "the note right after the date");

      // the same structure
      for (const tag of ["h1", "h2", "ul", "li", "table", "tr", "th", "td", "p"])
        assert.equal(count(body, tag) - (tag === "p" ? 1 : 0), count(enBody, tag), `<${tag}> count`);
      assert.deepEqual(all(body, /\sid="([^"]*)"/g).sort(), enIds, "the section anchors (a sign-in provider links to #delete-account)");
      assert.deepEqual(all(body, /href="([^"]*)"/g).filter((h) => h !== `/${page}?lang=en`).sort(), enHrefs, "the same links");

      // nothing left in English
      const left = enTexts.filter((t) => text(body).includes(t));
      assert.deepEqual(left, [], "English sentences left untranslated");

      // the Terms' US-law damages (s. 13 b) have no exact match elsewhere:
      // the English beside the translation, once, marked as English (owner,
      // 2026-11-05 — legal translators keep the source term for such terms)
      if (page === "terms") {
        const gloss = '<span lang="en" dir="ltr">(indirect, incidental, special, consequential or punitive damages)</span>';
        assert.equal(body.split(gloss).length - 1, 1, "the damages in English beside the translation, once");
        const s13 = body.match(/<h2>13\.[\s\S]*?<\/p>/)[0];
        assert.ok(s13.includes(gloss), "in section 13");
      }

      // "Do Not Track" (owner, 2026-11-05 — the Termly style): the language's
      // own term first, the standard's name in brackets, marked English; the
      // name alone where Firefox's own translation keeps it in English
      if (page === "privacy") {
        const heads = all(body, /<h2>([^\n]*?Do Not Track[^\n]*?)<\/h2>/g);
        assert.equal(heads.length, 1, "one Do Not Track heading");
        if (DNT_ENGLISH.includes(lang)) assert.equal(heads[0], "Do Not Track", "kept as the standard's name (as Firefox does here)");
        else {
          const m = heads[0].match(/^(.+) <span lang="en" dir="ltr">\(Do Not Track\)<\/span>$/);
          assert.ok(m && !/Do Not Track/.test(m[1]) && m[1].trim().length > 1, `the local term first, then (Do Not Track): ${heads[0]}`);
        }
      }

      // the app's buttons by their own names in this language
      for (const msgid of LABELS[page]) {
        const own = label(lang, msgid);
        assert.ok(text(body).includes(own), `the app's "${msgid}" by its ${lang} name "${own}"`);
      }
    });
  }
}
