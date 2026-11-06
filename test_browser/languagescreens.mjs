// Real languages, their own words as long (and as wide) as they really
// are, walked through every screen: everything fits (split from
// languages.mjs, owner 2026-11-05). Which languages: MEASURED, not picked
// by hand — translators' guides name Finnish, German and Hungarian among
// the longest and say to measure your own strings. Every language's short
// labels (the button-sized ones) are measured in the page's own font
// against the English; the widest are walked, and the widest that reads
// right to left (its mirrored layout checked too). A new language longer
// than all of these is walked without anyone changing this file.
import { readFileSync, readdirSync } from "node:fs";
import { journey, step, check, BASE } from "./cdp.mjs";
import { SETTLED, SPILLS, walk } from "./langcheck.mjs";

// how many to walk: the widest left-to-right ones, one right-to-left, and
// the one with the single widest label (about 7 s each — nine keeps this
// journey well inside the time the test's database allows)
const WIDEST = 7;

// a short label: a button, a menu row, a tab (longer sentences wrap)
const SHORT = 24;

const DIR = new URL("../priv/static/", import.meta.url);

// every translation, read from its catalog: { lang, messages }
const catalogs = readdirSync(DIR)
  .map((f) => (f.match(/^i18n-(.+)\.js$/) || [])[1])
  .filter((l) => l && l !== "en-XA")
  .map((lang) => {
    // (its line `HoodI18n.load({...});` — other lines follow it)
    const line = readFileSync(new URL(`i18n-${lang}.js`, DIR), "utf8")
      .split("\n")
      .find((l) => l.startsWith("HoodI18n.load("));
    check(line && line.endsWith(");"), `${lang}: its catalog line`, line && line.slice(-40));
    return JSON.parse(line.slice("HoodI18n.load(".length, -");".length));
  });

// the short labels: English beside each language's own words (a message
// with forms for counts gives each form)
const shortPairs = (messages) =>
  Object.entries(messages)
    .filter(([en]) => en.length <= SHORT && !en.includes("{"))
    .flatMap(([en, t]) => (typeof t === "string" ? [t] : Object.values(t)).filter((s) => typeof s === "string" && s).map((s) => [en, s]));

// reads right to left: Hebrew or Arabic script (Arabic, Urdu, Persian…)
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

await journey("language screens: the widest languages, every screen, every word fits", async (browser) => {
  step("every language's short labels measured against English, in the page's own font");
  check(catalogs.length >= 42, "all the languages", catalogs.length);
  const m = await browser.visitor("BT-Measure");
  await m.phone(390, 780, 2);
  await m.goto(`${BASE}/?demo=1`);
  await m.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map`, "the demo");
  const pairs = Object.fromEntries(catalogs.map((c) => [c.lang, shortPairs(c.messages)]));
  const ratios = await m.eval(`document.fonts.ready.then(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = getComputedStyle(document.getElementById("btn-mode")).font;
    const w = (s) => ctx.measureText(s).width;
    const out = {};
    for (const [lang, list] of Object.entries(${JSON.stringify(pairs)})) {
      const en = list.reduce((s, [e]) => s + w(e), 0);
      // and its single widest label (one long word — "Nutzungsbedingungen"
      // — can spill out of a button in a language narrower on average)
      const widest = list.reduce((b, [e, t]) => (w(t) > b.px ? { px: w(t), text: t, en: e } : b), { px: 0 });
      out[lang] = { ratio: en > 0 ? list.reduce((s, [, t]) => s + w(t), 0) / en : 0, labels: list.length, widest: { ...widest, px: Math.round(widest.px) } };
    }
    return out;
  })`);
  await m.close();

  for (const c of catalogs) check(ratios[c.lang] && ratios[c.lang].labels >= 20, `${c.lang}: its short labels measured`, ratios[c.lang]);
  const rtl = (lang) => RTL.test(pairs[lang].map(([, t]) => t).join(""));
  const byWidth = catalogs.map((c) => c.lang).sort((a, b) => ratios[b].ratio - ratios[a].ratio);
  const ltrs = byWidth.filter((l) => !rtl(l)).slice(0, WIDEST);
  const rtls = byWidth.filter(rtl).slice(0, 1);
  check(ltrs.length === WIDEST && rtls.length === 1, "the widest found, both ways", { ltrs, rtls });
  // the one with the single widest label, if not already among them
  const longest = byWidth.reduce((a, b) => (ratios[b].widest.px > ratios[a].widest.px ? b : a));
  const extra = [...ltrs, ...rtls].includes(longest) ? [] : [longest];
  // the ones walked are the widest: every language left out is narrower
  const narrowest = Math.min(...ltrs.map((l) => ratios[l].ratio));
  const wider = byWidth.filter((l) => !rtl(l) && !ltrs.includes(l) && ratios[l].ratio > narrowest);
  check(wider.length === 0, "nothing wider left out", wider.map((l) => [l, ratios[l].ratio]));
  // (the measure means something: German's labels run longer than English)
  check(ratios.de.ratio > 1.1, "German measured wider than English", ratios.de);
  step(`the widest: ${[...ltrs, ...rtls].map((l) => `${l} ${ratios[l].ratio.toFixed(2)}×`).join(", ")}; the widest single label: ${longest} "${ratios[longest].widest.text}" (${ratios[longest].widest.px}px)`);

  for (const lang of [...ltrs, ...extra, ...rtls]) {
    const mirrored = rtls.includes(lang);
    step(`${lang}: the same screens, every word fits`);
    const p = await browser.visitor(`BT-${lang}`);
    await p.phone(390, 780, 2);
    await p.goto(`${BASE}/`);
    await p.eval(`(document.cookie = "hoodride_lang=${lang}; path=/; SameSite=Lax", true)`);
    await p.goto(`${BASE}/`);
    await p.waitFor(`!!document.getElementById("auth-buttons") && !document.getElementById("auth-buttons").classList.contains("hidden")`, `${lang}: the sign-in buttons`);
    check(await p.eval(`HoodI18n.lang() === ${JSON.stringify(lang)} && document.documentElement.lang === ${JSON.stringify(lang)}`), `${lang}: the page served in it`);
    if (mirrored) {
      // right to left: the page mirrors (styles.css: start/end, never left/right)
      check(await p.eval(`document.documentElement.dir === "rtl"`), `${lang}: served right to left`);
      // the language list lines up with the page: every name on the right
      // (English too), the ✓ on the left (it once lined each name up by its
      // own script — English on the left of an Arabic list)
      const rows = await p.eval(`(async () => {
        openLangSheet(document.getElementById("btn-lang-login"));
        await new Promise((ok) => setTimeout(ok, 300));
        const at = (tag) => {
          const b = [...document.querySelectorAll("#lang-list button")].find((x) => x.lang === tag);
          b.scrollIntoView({ block: "nearest" });
          const n = b.querySelector("span").getBoundingClientRect(), r = b.getBoundingClientRect();
          return { gapEnd: Math.round(r.right - n.right), gapStart: Math.round(n.left - r.left) };
        };
        const out = { en: at("en"), own: at(${JSON.stringify(lang)}) };
        closeLangSheet();
        return out;
      })()`);
      check(rows.en.gapEnd < rows.en.gapStart && rows.own.gapEnd < rows.own.gapStart, `${lang}: the language list on the right — English as well as its own name`, rows);
    }
    const fits = async (q, where) => {
      await q.waitFor(SETTLED, `${where}: settled`);
      const spills = await q.eval(SPILLS);
      check(spills.length === 0, `${where} in ${lang}: every word fits`, spills);
    };
    await fits(p, "the sign-in screen");
    const white = await p.eval(`HoodCar.colorName("White")`);
    await walk(p, fits, white);
    if (mirrored) {
      // mirrored: the profile picture top right, the locate button bottom
      // left, the menu sliding in from the right
      const sides = await p.eval(`(async () => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const out = { account: r("btn-account").left > innerWidth / 2, locate: r("btn-locate").right < innerWidth / 2 };
        openSettings();
        await new Promise((ok) => setTimeout(ok, 400));
        const d = document.getElementById("settings-sheet").getBoundingClientRect();
        out.menu = Math.round(d.right) === innerWidth && d.left > 0;
        closeSettings();
        return out;
      })()`);
      check(sides.account && sides.locate && sides.menu, `${lang}: mirrored — profile top right, locate bottom left, menu from the right`, sides);
    }
    check(p.errors.length === 0, `${lang}: no page errors`, p.errors);
    await p.close();
  }
});
