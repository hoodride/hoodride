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
import { readdirSync } from "node:fs";
import { journey, step, check, BASE } from "./cdp.mjs";

// her pick, as the language switch keeps it (HoodrideWeb.Lang)
const PICK = `(document.cookie = "hoodride_lang=en-XA; path=/; SameSite=Lax", true)`;

// plain English on screen: words, labels and box hints of what's shown.
// Allowed: names (people, places, brands, the map's credits) — `allow`
const ENGLISH = `((allow) => {
  // (the map's credits are its data's required credit, as given: not ours)
  const seen = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true], .maplibregl-ctrl-attrib-inner, .hidden");
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

// cut off or spilling out: a shown button or banner whose words are wider
// than its box — or a box grown past the screen's edge by a long word (it
// never overflows itself then: the first version missed exactly that)
// nothing on screen still moving (the menu slides in for 0.2 s: measured
// mid-slide it "stuck out"); endless ones (a pulsing pin) don't count
const SETTLED = `document.getAnimations().every((a) => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity)`;

const SPILLS = `(() => [...document.querySelectorAll("button, .btn, .banner, .drawer-row, label")]
  .filter((el) => el.getClientRects().length > 0 && !el.closest(".hidden, .drawer[inert]"))
  .map((el) => { const r = el.getBoundingClientRect(); return { el, over: Math.max(el.scrollWidth - el.clientWidth, Math.round(r.right - Math.min(innerWidth, screen.width)), Math.round(-r.left)) }; })
  .filter((x) => x.over > 1)
  .map(({ el, over }) => ({ in: el.id || el.className, text: el.textContent.trim().slice(0, 60), over })))()`;

// EVERY language through the real screens on one demo page — the
// language switched in place (its catalog script), each screen set up
// directly, then measured as it stands: every label beside its real
// neighbours ("Decline" next to "Accept ride" in the chat header — a label
// measured alone in a phone-wide box fit even when absurdly long; the
// first version of this check missed exactly that). → [{ lang, screen, … }]
const FITS_ALL = (langs) => `(async () => {
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      if (document.getAnimations().every((a) => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity)) return;
    }
  };
  const spills = () => [...document.querySelectorAll("button, .btn, .banner, .drawer-row, label")]
    .filter((el) => el.getClientRects().length > 0 && !el.closest(".hidden, .drawer[inert]"))
    .map((el) => { const r = el.getBoundingClientRect(); return { el, over: Math.max(el.scrollWidth - el.clientWidth, Math.round(r.right - Math.min(innerWidth, screen.width)), Math.round(-r.left)) }; })
    .filter((x) => x.over > 1)
    .map(({ el, over }) => ({ in: el.id || el.className, text: el.textContent.trim().slice(0, 50), over }))
    // and the chat's name stays readable: who you're talking to (a long
    // pair of buttons once squeezed it to nothing)
    .concat((() => { const n = document.querySelector("#chat:not(.hidden) .chat-title"); const w = n ? Math.round(n.getBoundingClientRect().width) : null; return n && w < 70 ? [{ in: "chat-title (the name)", text: n.textContent.trim().slice(0, 30), over: 70 - w }] : []; })());
  const out = [];
  const look = async (lang, screen) => { await settle(); for (const s of spills()) out.push({ lang, screen, ...s }); };
  const mode = (m) => { if (state.mode !== m) document.getElementById("btn-mode").click(); };
  for (const lang of ${JSON.stringify(langs)}) {
    await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "/i18n-" + lang + ".js";
      s.onload = ok;
      s.onerror = () => fail(new Error("no catalog for " + lang));
      document.head.appendChild(s);
    });
    if (HoodI18n.lang() !== lang) { out.push({ lang, screen: "catalog", in: HoodI18n.lang(), over: -1 }); continue; }
    // the rider's map, a car's card, the chat with it
    mode("rider");
    refreshControls();
    await look(lang, "the map");
    openMarkerCard(drivers[0], "driver");
    await look(lang, "a car's card");
    closePeerCard();
    openChat(drivers[0]);
    refreshControls();
    await look(lang, "the chat");
    closeChat();
    // the driver: online, a rider asking — Decline and Accept ride side by side
    mode("driver");
    if (!state.online) document.getElementById("btn-online").click();
    await settle();
    if (mockHand) {
      mockHand.pending = true;
      openChat(mockHand);
      refreshControls();
      await look(lang, "the driver's chat, a rider asking");
      mockHand.pending = false;
      closeChat();
    } else out.push({ lang, screen: "the driver's chat", in: "no pretend rider", over: -1 });
    refreshControls();
    await look(lang, "driving");
    if (state.online) document.getElementById("btn-online").click();
    mode("rider");
    // the menu, the car form, deleting the account
    openSettings();
    await look(lang, "the menu");
    showDeleteConfirm();
    await look(lang, "delete your account?");
    hideDeleteConfirm();
    closeSettings();
    openCarSheet();
    await look(lang, "the car form");
    closeCarSheet();
    await settle();
  }
  return out;
})()`;

// the screens both languages are walked through: the demo's map, a car's
// card, a chat, a ride, driving, the menu, the car form, the map-app box —
// `look` checks each
async function walk(p, look, colorStart) {
    step("the demo in it: the map, a car's card, a chat, a ride; driving");
    await p.goto(`${BASE}/?demo=1`);
    await p.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 0`, "the demo's pretend drivers", 15000);
    await look(p, "the map");
    await p.eval(`openMarkerCard(drivers[0], "driver"), true`);
    await p.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "a car's card");
    await look(p, "a car's card");
    await p.click("btn-msg");
    await p.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat");
    await look(p, "the chat");
    await p.click("btn-ride-action");
    await p.waitFor(`state.ride && state.ride.status === "connected"`, "the ride, accepted", 5000);
    await p.click("chat-close");
    await look(p, "in a ride");
    await p.click("btn-endride");
    await p.waitFor(`!state.ride`, "the ride ended");
    await p.click("btn-mode");
    await p.waitFor(`state.mode === "driver"`, "Drive");
    await p.click("btn-online");
    await p.waitFor(`state.online`, "online");
    await look(p, "driving");

    step("the menu, the car form, the map-app box");
    await p.click("btn-account");
    await p.waitFor(`settingsOpen()`, "the menu");
    await look(p, "the menu");
    await p.click("btn-car");
    await p.waitFor(`carSheetOpen()`, "the car form");
    check((await p.eval(`document.getElementById("car-color").options[1].text`)).startsWith(colorStart), "the colors, translated", await p.eval(`document.getElementById("car-color").options[1].text`));
    await look(p, "the car form");
    await p.click("car-cancel");
    await p.waitFor(`!carSheetOpen()`, "the car form closed");
    await p.eval(`openNavSheet({ lat: 40.71, lng: -74.0 }), true`);
    await p.waitFor(`!document.getElementById("nav-sheet").classList.contains("hidden")`, "the map-app box");
    await look(p, "the map-app box");
    await p.click("nav-cancel");
}

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

  step("Lia opens Hood Ride signed out, in the made-up language");
  const lia = await browser.visitor("BT-Lia");
  await lia.phone(390, 780, 2);
  await lia.goto(`${BASE}/`);
  await lia.eval(PICK);
  await lia.goto(`${BASE}/`);
  await lia.waitFor(`!!document.getElementById("auth-buttons") && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in buttons");
  check(await lia.eval(`HoodI18n.lang() === "en-XA" && document.documentElement.lang === "en-XA"`), "the page served in the made-up language", await lia.eval(`[HoodI18n.lang(), document.documentElement.lang]`));
  check((await lia.eval(`document.querySelector(".fineprint").textContent`)).startsWith("⟦"), "the agreement line translated", await lia.eval(`document.querySelector(".fineprint").textContent`));
  check(await lia.eval(`document.querySelector('.fineprint a[href="/privacy"]').textContent.startsWith("⟦")`), "its links, too, still links");
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

  // EVERY language, every label each button can show, in a copy of that
  // button: nothing spills (quick; the walk below covers whole screens for
  // the longest and widest)
  step("every language: every screen's labels fit, beside each other");
  const langs = readdirSync(new URL("../priv/static/", import.meta.url))
    .map((f) => (f.match(/^i18n-(.+)\.js$/) || [])[1])
    .filter((l) => l && l !== "en-XA");
  check(langs.length >= 42, "all the languages", langs.length);
  const pf = await browser.visitor("BT-Fit");
  await pf.phone(390, 780, 2);
  await pf.goto(`${BASE}/?demo=1`);
  await pf.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map`, "the demo");
  const spilled = await pf.eval(FITS_ALL(langs));
  check(spilled.length === 0, "every label fits, in every language", spilled);
  check(pf.errors.length === 0, "no page errors", pf.errors);
  await pf.close();

  // real languages, their own words as long (and as wide) as they really
  // are: everything fits. The longest short labels, measured against
  // English (French, Russian, Greek, German — "Terms" → "Nutzungsbedingungen"),
  // and wide scripts (Tamil, Japanese); if these fit, shorter ones do
  for (const lang of ["es", "fr", "ru", "el", "de", "ta", "ja"]) {
    step(`${lang}: the same screens, every word fits`);
    const p = await browser.visitor(`BT-${lang}`);
    await p.phone(390, 780, 2);
    await p.goto(`${BASE}/`);
    await p.eval(`(document.cookie = "hoodride_lang=${lang}; path=/; SameSite=Lax", true)`);
    await p.goto(`${BASE}/`);
    await p.waitFor(`!!document.getElementById("auth-buttons") && !document.getElementById("auth-buttons").classList.contains("hidden")`, `${lang}: the sign-in buttons`);
    check(await p.eval(`HoodI18n.lang() === ${JSON.stringify(lang)} && document.documentElement.lang === ${JSON.stringify(lang)}`), `${lang}: the page served in it`);
    const fits = async (q, where) => {
      await q.waitFor(SETTLED, `${where}: settled`);
      const spills = await q.eval(SPILLS);
      check(spills.length === 0, `${where} in ${lang}: every word fits`, spills);
    };
    await fits(p, "the sign-in screen");
    const white = await p.eval(`HoodCar.colorName("White")`);
    await walk(p, fits, white);
    check(p.errors.length === 0, `${lang}: no page errors`, p.errors);
    await p.close();
  }
});
