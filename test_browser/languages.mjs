// Every word the app shows comes from the translators' list (languages,
// stage 1e — owner, 2026-11-04). The standard check ("pseudo-localization"):
// a made-up language, en-XA, where every message is the English with each
// letter swapped for an accented one ("Need a ride" → "⟦Ñééð á ŕíðé ~~~~⟧")
// and made about a third longer, as Spanish runs (Hoodride.I18n.pseudo_text;
// switched on in tests only). Anything still in plain English was missed —
// a word not marked or not wrapped; anything cut off or spilling out
// wouldn't fit a longer language.
//
// Through the real loader (1f): Lia picks the language as the language
// switch will (its cookie), the server serves the page in it — <html lang>,
// the catalog right after i18n.js, before the app.
import { journey, step, check, BASE } from "./cdp.mjs";
import { SETTLED, SPILLS, walk } from "./langcheck.mjs";

// her pick, as the language switch keeps it (HoodrideWeb.Lang)
const PICK = `(document.cookie = "hoodride_lang=en-XA; path=/; SameSite=Lax", true)`;

// plain English on screen: words, labels and box hints of what's shown.
// Allowed: names (people, places, brands, the map's credits) — `allow`
const ENGLISH = `((allow) => {
  // (the map's credits are its data's required credit, as given: not ours)
  // (nor the languages' own names — "English", "日本語": each written in its
  // own language on purpose, like a person's name)
  const seen = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true], .maplibregl-ctrl-attrib-inner, .hidden, .lang-current, #lang-note, #lang-list");
  // the allowed names taken out whole first ("Hood Ride", never "Ride" alone)
  const english = (s) => allow.reduce((rest, a) => rest.replace(a, " "), s).match(/[A-Za-z][A-Za-z'’]+/g) || [];
  const found = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode()); ) {
    const el = n.parentElement;
    if (!seen(el) || el.closest("script, style")) continue;
    const words = english(n.nodeValue);
    if (words.length) found.push({ in: el.id || el.className || el.tagName, text: n.nodeValue.trim().slice(0, 90), words });
  }
  for (const el of document.querySelectorAll("[aria-label], [title], [placeholder]")) {
    if (!seen(el)) continue;
    for (const a of ["aria-label", "title", "placeholder"]) {
      const words = english(el.getAttribute(a) || "");
      if (words.length) found.push({ in: (el.id || el.tagName) + " " + a, text: el.getAttribute(a), words });
    }
  }
  return found;
})`;

await journey("languages: no English left in a made-up language, nothing cut off", async (browser) => {
  // names and words that are no language's: people, brands, places, the
  // demo's pretend people and cars (the car description is put together by
  // the server, in English — stage 2), the map's own credits
  // (whole phrases, each a regex taken out of the text before the check)
  const NAMES = [
    /Hood Ride|Google Maps|Apple Maps|Samsung Internet|\b(Google|Facebook|GitHub|Discord|Waze|Safari|Chrome|Firefox|Edge|Brave|Instagram)\b/g,
    /\b(DeShawn|Maria|Tony|Keisha|Jaylen|Aaliyah|BT-\w+)\b/g,
    // the demo's cars: the car description is the server's, in English
    // (stage 2) — whole, before the makes alone
    /Gray Honda Civic|Red Toyota Corolla|Black Ford F-150|White Nissan Altima/g,
    // the car form's examples (a make and model are names)
    /\b(Honda|Civic)\b/g,
    // distances: miles and feet as the US writes them (stage 2: Intl)
    /\d+(\.\d+)? (mi|ft)\b/g,
  ];
  const allow = `[${NAMES.map(String).join(", ")}]`;
  const leftEnglish = async (p, where) => {
    await p.waitFor(SETTLED, `${where}: settled`);
    const found = await p.eval(`${ENGLISH}(${allow})`);
    check(found.length === 0, `${where}: no English left`, found);
    // (a third longer fits everywhere — checked 2026-11-04; words 4× longer
    // were reported, so the check sees it)
    const spills = await p.eval(SPILLS);
    check(spills.length === 0, `${where}: longer words fit, nothing spills out`, spills);
  };

  // the language switch (owner, 2026-11-05): 文A and the language's own
  // name on the sign-in screen; the list, each in its own words; a pick
  // comes back in that language and is kept — only then a cookie
  step("Ken opens Hood Ride signed out: English, 文A at the top; picks Español, then back to English");
  const ken = await browser.visitor("BT-Ken");
  await ken.phone(390, 780, 2);
  await ken.goto(`${BASE}/`);
  await ken.waitFor(`!document.getElementById("btn-lang-login").classList.contains("hidden")`, "the language button");
  check(await ken.eval(`document.querySelector("#btn-lang-login .lang-current").textContent`) === "English", "it says English");
  check(!(await ken.eval(`document.cookie.includes("hoodride_lang")`)), "nothing kept before a choice");
  await ken.click("btn-lang-login");
  await ken.waitFor(`!document.getElementById("lang-sheet").classList.contains("hidden")`, "the list");
  const listed = await ken.eval(`[...document.querySelectorAll("#lang-list button")].map((b) => ({ name: b.textContent, lang: b.lang, current: b.getAttribute("aria-current") === "true" }))`);
  const names = listed.map((x) => x.name);
  check(listed.length >= 46, "every language switched on", listed.length);
  check(["Español", "日本語", "العربية", "Deutsch", "Bahasa Indonesia"].every((n) => names.includes(n)), "each in its own words", names.slice(0, 12));
  check(JSON.stringify(listed.filter((x) => x.current).map((x) => x.lang)) === JSON.stringify(["en"]), "English marked as the one now", listed.filter((x) => x.current));
  await ken.eval(`[...document.querySelectorAll("#lang-list button")].find((b) => b.lang === "es").click(), true`);
  // (the app fills the button once it runs — after the language loads:
  // checked the moment between, the label was still empty)
  await ken.waitFor(`document.documentElement.lang === "es" && typeof HoodI18n !== "undefined" && HoodI18n.lang() === "es" && document.querySelector("#btn-lang-login .lang-current").textContent !== ""`, "back in Spanish", 15000);
  check(await ken.eval(`document.querySelector("#btn-lang-login .lang-current").textContent`) === "Español", "the button says Español", await ken.eval(`({ text: document.querySelector("#btn-lang-login").textContent, html: document.querySelector("#btn-lang-login").innerHTML.slice(0, 200), now: HoodI18n.lang(), errors: ${JSON.stringify(ken.errors)} })`));
  check(await ken.eval(`document.cookie.includes("hoodride_lang=es")`), "the choice kept");
  // what the BROWSER keeps (its own store): the server's cookie, a year from
  // now — not the page's own, which Safari caps at 7 days; not a session one
  // (owner, 2026-11-05: WebKit ITP 2.1 — set it from the server)
  const kept = (await ken.cookies()).find((c) => c.name === "hoodride_lang");
  const daysLeft = kept && (kept.expires * 1000 - Date.now()) / 86_400_000;
  check(kept && kept.value === "es" && !kept.session && daysLeft > 364 && daysLeft <= 366 && kept.path === "/" && kept.domain === "localhost", "the browser keeps the choice for a year (the server's cookie)", { ...kept, daysLeft });
  await ken.click("btn-lang-login");
  await ken.waitFor(`!document.getElementById("lang-sheet").classList.contains("hidden")`, "the list again");
  // opened on the language now, in the middle of the list (owner,
  // 2026-11-05: the W3C — the selected option shown on opening)
  const mid = await ken.eval(`(() => {
    const list = document.getElementById("lang-list"), b = list.querySelector('[aria-current="true"]');
    const l = list.getBoundingClientRect(), r = b.getBoundingClientRect();
    return { lang: b.lang, scrolled: list.scrollTop, off: Math.round((r.top + r.bottom) / 2 - (l.top + l.bottom) / 2), half: l.height / 2 };
  })()`);
  check(mid.lang === "es" && mid.scrolled > 0 && Math.abs(mid.off) < 30, "Español in the middle of the list", mid);
  check(await ken.eval(`document.activeElement.id !== "lang-search"`), "the search not focused (no keyboard by itself)");
  // the search: in Spanish, typing the English name finds it; an exact
  // own name first; nothing — said so
  const shown = () => ken.eval(`document.getElementById("lang-list").classList.contains("hidden") ? [] : [...document.querySelectorAll("#lang-list button")].map((b) => b.lang)`);
  check(await ken.eval(`document.getElementById("lang-search").placeholder`) === "Buscar idiomas", "the hint in Spanish");
  await ken.eval(`(document.getElementById("lang-search").focus(), true)`);
  await ken.type("japan");
  check(JSON.stringify(await shown()) === JSON.stringify(["ja"]), "typed 'japan': 日本語 alone", await shown());
  await ken.eval(`(document.getElementById("lang-search").select(), true)`);
  await ken.type("english");
  check((await shown())[0] === "en", "typed 'english': English first", await shown());
  await ken.eval(`(document.getElementById("lang-search").select(), true)`);
  await ken.type("zzqx");
  check((await shown()).length === 0, "nothing matches: no list", await shown());
  check(await ken.eval(`!document.getElementById("lang-none").classList.contains("hidden") && document.getElementById("lang-none").textContent`) === "No se encontraron idiomas", "and it says so, in Spanish");
  // the × (our own — the browser's is off in Firefox): a real tap on it
  // empties the field, every language back, the cursor still there
  const x = await ken.eval(`(() => { const r = document.getElementById("lang-clear").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, label: document.getElementById("lang-clear").getAttribute("aria-label") }; })()`);
  check(x.w >= 40 && x.label === "Borrar búsqueda", "the × shown, a full tap wide, named in Spanish", x);
  // (Chrome can't report a style for its own × — getComputedStyle gives the
  // field's: the rule, read from the page's loaded styles)
  check(await ken.eval(`[...document.styleSheets].flatMap((s) => [...s.cssRules]).some((r) => /lang-search input::-webkit-search-cancel-button/.test(r.selectorText || "") && r.style.display === "none")`), "the browser's own × hidden (no two)");
  await ken.tapAt(x.x, x.y);
  await ken.waitFor(`document.getElementById("lang-search").value === ""`, "the field emptied by ×");
  check((await shown()).length === listed.length, "every language back", (await shown()).length);
  check(await ken.eval(`document.activeElement.id === "lang-search" && document.getElementById("lang-clear").classList.contains("hidden")`), "the cursor in the field, the × gone with the text");
  await ken.eval(`(document.getElementById("lang-search").select(), true)`);
  await ken.type("engl");
  await ken.eval(`[...document.querySelectorAll("#lang-list button")].find((b) => b.lang === "en").click(), true`);
  await ken.waitFor(`document.documentElement.lang === "en" && HoodI18n.lang() === "en" && document.querySelector("#btn-lang-login .lang-current").textContent === "English"`, "back in English", 15000);
  // and in the menu: the row with the language now
  await ken.goto(`${BASE}/?demo=1`);
  await ken.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map`, "the demo");
  await ken.eval(`(openSettings(), true)`);
  await ken.waitFor(`settingsOpen() && !document.getElementById("btn-lang").classList.contains("hidden")`, "the menu's Language row");
  check(await ken.eval(`document.getElementById("lang-note").textContent`) === "English", "it says English");
  check(ken.errors.length === 0, "no page errors", ken.errors);
  await ken.close();

  // the legal pages in every language (owner, 2026-11-05): each at its own
  // address (/es/privacy); /privacy is the English one for everyone (Google:
  // no redirect between language versions) and lists the others; the Spanish
  // app links to its own; a translation notes the English applies, links to it
  step("Pia, in Spanish: the app at /es links to /es/terms; /privacy is English and lists Español; the English originals; Ali in Arabic");
  const pia = await browser.visitor("BT-Pia");
  await pia.phone(390, 780, 2);
  await pia.goto(`${BASE}/`);
  await pia.eval(`(document.cookie = "hoodride_lang=es; path=/; SameSite=Lax", true)`);
  await pia.goto(`${BASE}/`);
  check(await pia.eval(`location.pathname`) === "/es", "/ sent her to /es", await pia.eval(`location.pathname`));
  const appLinks = await pia.eval(`[...document.querySelectorAll(".fineprint a")].map((a) => a.getAttribute("href"))`);
  check(JSON.stringify(appLinks) === JSON.stringify(["/es/terms", "/es/privacy"]), "the Spanish app links to the Spanish terms and policy", appLinks);
  await pia.goto(`${BASE}/privacy`);
  const plain = await pia.eval(`(() => { const d = document.querySelector("details.lang-row"); const es = d && d.querySelector('a[lang="es"]'); return { lang: document.documentElement.lang, list: !!d && d.querySelectorAll("a").length, es: es && es.getAttribute("href"), label: d && d.querySelector("summary").textContent, wide: document.documentElement.scrollWidth <= innerWidth }; })()`);
  check(plain.lang === "en", "/privacy: English, even with Spanish chosen (no redirect)", plain);
  check(plain.list >= 46 && plain.es === "/es/privacy" && plain.label === "Language: English" && plain.wide, "/privacy lists every language, Español → /es/privacy", plain);
  for (const [page, title] of [["privacy", "Política de privacidad"], ["terms", "Términos de uso"]]) {
    await pia.goto(`${BASE}/es/${page}`);
    const es = await pia.eval(`(() => {
      const n = document.querySelector(".translation-note"), a = n && n.querySelector("a");
      const r = n && n.getBoundingClientRect();
      return { lang: document.documentElement.lang, h1: document.querySelector("h1").textContent, note: !!n && r.height > 0 && r.right <= innerWidth, link: a && a.getAttribute("href"), styled: !!n && getComputedStyle(n).borderInlineStartWidth === "3px", wide: document.documentElement.scrollWidth <= innerWidth };
    })()`);
    check(es.lang === "es" && es.h1 === title, `${page}: in Spanish`, es);
    check(es.note && es.styled && es.link === `/${page}?lang=en`, `${page}: the note under the date, linking to English`, es);
    check(es.wide, `${page}: fits the phone`, es);
    await pia.goto(`${BASE}${es.link}`);
    check(await pia.eval(`document.documentElement.lang === "en" && !document.querySelector(".translation-note")`), `${page}: the English original, from the note's link`);
    check(await pia.eval(`document.cookie.includes("hoodride_lang=es")`), `${page}: the Spanish choice still kept`);
  }
  check(pia.errors.length === 0, "no page errors", pia.errors);
  await pia.close();
  const ali = await browser.visitor("BT-Ali");
  await ali.phone(390, 780, 2);
  await ali.goto(`${BASE}/ar/privacy`);
  const ar = await ali.eval(`(() => {
    const n = document.querySelector(".translation-note").getBoundingClientRect(), b = document.querySelector("main").getBoundingClientRect();
    const td = document.querySelector("td");
    return { dir: document.documentElement.dir, align: getComputedStyle(td).textAlign, noteRight: Math.round(b.right - n.right), noteLeft: Math.round(n.left - b.left), border: getComputedStyle(document.querySelector(".translation-note")).borderRightWidth };
  })()`);
  check(ar.dir === "rtl" && ar.border === "3px", "ar: right to left, the note's bar on the right", ar);
  check(ar.align === "start", "ar: the tables from the right (start, not left)", ar);
  check(ali.errors.length === 0, "ar: no page errors", ali.errors);
  await ali.close();

  // the Ethiopic font (owner, 2026-11-05): downloaded only by a device
  // without an Ethiopic font of its own — Windows always has Ebrima, so
  // there, never; the letters still shown (in Ebrima)
  step("Abe, in Amharic on Windows: his own Ethiopic font, no download");
  const abe = await browser.visitor("BT-Abe");
  await abe.phone(390, 780, 2);
  await abe.goto(`${BASE}/am/privacy`);
  const am = await abe.eval(`document.fonts.ready.then(() => ({
    windows: navigator.userAgent.includes("Windows"),
    downloaded: performance.getEntriesByType("resource").filter((e) => e.name.includes("NotoSansEthiopic")).map((e) => e.name),
    // an Ethiopic letter drawn with real width, not an empty box
    width: (() => { const s = document.createElement("span"); s.textContent = "ሀሁሂ"; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; })(),
  }))`);
  check(am.width > 20, "am: the Ethiopic letters shown", am);
  if (am.windows) check(am.downloaded.length === 0, "am: Windows' own Ebrima used — the font not downloaded", am);
  check(abe.errors.length === 0, "am: no page errors", abe.errors);
  await abe.close();

  // signed in, a language change reloads the page — it used to show the
  // sign-in screen for a moment (owner, 2026-11-05: "is it like logging me
  // back in?"). Now it starts on the car alone (PageController.resuming):
  // every frame before it's painted, the sign-in screen's words never seen;
  // "Connecting…" not in the first second; then the map, in Spanish
  step("Uma, signed in, switches to Español: the sign-in screen never flashes");
  const uma = await browser.person("BT-Uma");
  await uma.phone(390, 780, 2);
  // (in its own scope: a global "tick" here broke the app's own — app.js
  // never ran)
  await uma.onEveryPage(`(() => {
    window.__seen = { login: [], early: [] };
    const t0 = performance.now();
    const tick = () => {
      const screen = document.getElementById("screen-login");
      const on = (sel) => { const el = document.querySelector(sel); return el && screen.classList.contains("active") && getComputedStyle(el).visibility === "visible" && el.getBoundingClientRect().height > 0; };
      if (screen) {
        const ms = Math.round(performance.now() - t0);
        for (const sel of ["#screen-login .tagline", "#screen-login .about", "#screen-login .fineprint", "#btn-lang-login"]) if (on(sel)) window.__seen.login.push([sel, ms]);
        if (on("#boot-status") && ms < 900) window.__seen.early.push(ms);
        window.__seen.started = window.__seen.started ?? document.documentElement.className;
      }
      if (!document.getElementById("screen-map")?.classList.contains("active")) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();`);
  await uma.waitFor(`document.getElementById("screen-map").classList.contains("active")`, "the map");
  await uma.eval(`document.getElementById("btn-lang").click(), true`);
  await uma.waitFor(`!document.getElementById("lang-sheet").classList.contains("hidden")`, "the list");
  await uma.eval(`[...document.querySelectorAll("#lang-list button")].find((b) => b.lang === "es").click(), true`);
  await uma.waitFor(`document.documentElement.lang === "es" && document.getElementById("screen-map").classList.contains("active")`, "the map, in Spanish", 20000);
  const seen = await uma.eval(`window.__seen`);
  check(seen.started === "resuming", "the page started neutral (the server knew)", seen);
  check(seen.login.length === 0, "not one frame of the sign-in screen", seen.login.slice(0, 6));
  check(seen.early.length === 0, "no Connecting… flashing in the first second", seen.early.slice(0, 6));
  check(!(await uma.eval(`document.documentElement.classList.contains("resuming")`)), "the neutral start over");
  check(uma.errors.length === 0, "no page errors", uma.errors);
  // signed out (here or elsewhere) with that page: the whole sign-in screen
  await uma.eval(`fetch("/api/logout", { method: "POST" }).then(() => true)`);
  await uma.goto(`${BASE}/es`);
  await uma.waitFor(`!document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in buttons");
  check(await uma.eval(`!document.documentElement.classList.contains("resuming") && getComputedStyle(document.querySelector("#screen-login .tagline")).visibility === "visible"`), "signed out: the sign-in screen, whole");
  await uma.close();

  // offline (owner, 2026-11-05): "/" sends a Japanese phone to /ja — a
  // saved redirect can't be shown offline, so the worker keeps the home he
  // opened as "/" (sw.js): with no signal, "/" opens in Japanese
  step("Oto, in Japanese: / → /ja; then no signal: / still opens, in Japanese");
  const oto = await browser.visitor("BT-Oto");
  await oto.phone(390, 780, 2);
  await oto.goto(`${BASE}/`);
  await oto.eval(`(document.cookie = "hoodride_lang=ja; path=/; SameSite=Lax", true)`);
  await oto.goto(`${BASE}/`);
  check(await oto.eval(`location.pathname`) === "/ja", "/ sent him to /ja", await oto.eval(`location.pathname`));
  await oto.waitFor(`navigator.serviceWorker.ready.then(() => true)`, "the offline copy installed", 20000);
  // opened again, now through the worker: the home is saved
  await oto.goto(`${BASE}/ja`);
  await oto.waitFor(`!!navigator.serviceWorker.controller`, "the worker in charge", 20000);
  await oto.waitFor(`caches.match("/").then((r) => r ? r.text() : "").then((t) => t.includes('<html lang="ja">'))`, "the Japanese home saved as /", 20000);
  await oto.offline(true);
  await oto.goto(`${BASE}/`);
  const off = await oto.eval(`({ lang: document.documentElement.lang, title: !!document.getElementById("screen-login") })`);
  check(off.lang === "ja" && off.title, "no signal: / opened, in Japanese", off);
  await oto.offline(false);
  await oto.close();

  step("Lia opens Hood Ride signed out, in the made-up language");
  const lia = await browser.visitor("BT-Lia");
  await lia.phone(390, 780, 2);
  await lia.goto(`${BASE}/`);
  await lia.eval(PICK);
  await lia.goto(`${BASE}/`);
  await lia.waitFor(`!!document.getElementById("auth-buttons") && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in buttons");
  check(await lia.eval(`HoodI18n.lang() === "en-XA" && document.documentElement.lang === "en-XA"`), "the page served in the made-up language", await lia.eval(`[HoodI18n.lang(), document.documentElement.lang]`));
  check((await lia.eval(`document.querySelector(".fineprint").textContent`)).startsWith("⟦"), "the agreement line translated", await lia.eval(`document.querySelector(".fineprint").textContent`));
  check(await lia.eval(`document.querySelector('.fineprint a[href$="/privacy"]').textContent.startsWith("⟦")`), "its links, too, still links");
  await leftEnglish(lia, "the sign-in screen");

  await walk(lia, leftEnglish, "⟦");

  step("an address that doesn't exist: its page in the language too");
  await lia.goto(`${BASE}/no/such/page`);
  await lia.waitFor(`document.readyState === "complete"`, "the not-found page");
  const page404 = `({ title: document.title, lang: document.documentElement.lang, loaded: typeof HoodI18n === "undefined" ? "no HoodI18n" : HoodI18n.lang(), scripts: [...document.scripts].map((s) => s.getAttribute("src")), h1: document.querySelector("h1").textContent })`;
  check((await lia.eval(`document.title`)).startsWith("⟦"), "its title translated", await lia.eval(page404));
  await leftEnglish(lia, "the not-found page");
  check(lia.errors.length === 0, "no page errors", lia.errors);

  // real Spanish (stage 2): its own words, as long as they really are —
  // everything fits, nothing spills out or is cut off
  step("Sol picks Spanish: the agreement line in Spanish, its links in place");
  const sol = await browser.visitor("BT-Sol");
  await sol.phone(390, 780, 2);
  await sol.goto(`${BASE}/`);
  await sol.eval(`(document.cookie = "hoodride_lang=es; path=/; SameSite=Lax", true)`);
  await sol.goto(`${BASE}/`);
  await sol.waitFor(`!!document.getElementById("auth-buttons") && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in buttons");
  const fine = await sol.eval(`document.querySelector(".fineprint").textContent`);
  check(fine === "Al continuar, aceptas nuestros Términos y nuestra Política de privacidad.", "the agreement line in Spanish, its links in place", fine);
  await sol.close();
});
