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
// than its box
const SPILLS = `(() => [...document.querySelectorAll("button, .btn, .banner, .drawer-row, label")]
  .filter((el) => el.getClientRects().length > 0 && !el.closest(".hidden") && el.scrollWidth > el.clientWidth + 1)
  .map((el) => ({ in: el.id || el.className, text: el.textContent.trim().slice(0, 60), over: el.scrollWidth - el.clientWidth })))()`;

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
    const found = await p.eval(`${ENGLISH}(${allow})`);
    check(found.length === 0, `${where}: no English left`, found);
    // (a third longer fits everywhere — checked 2026-11-04; words 4× longer
    // were reported, so the check sees it)
    const spills = await p.eval(SPILLS);
    check(spills.length === 0, `${where}: longer words fit, nothing spills out`, spills);
  };

  step("Lia opens Hood Ride signed out, in the made-up language");
  const lia = await browser.visitor("BT-Lia");
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
  step("Sol picks Spanish: the same screens, every word fits");
  const sol = await browser.visitor("BT-Sol");
  await sol.goto(`${BASE}/`);
  await sol.eval(`(document.cookie = "hoodride_lang=es; path=/; SameSite=Lax", true)`);
  await sol.goto(`${BASE}/`);
  await sol.waitFor(`!!document.getElementById("auth-buttons") && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in buttons");
  check(await sol.eval(`HoodI18n.lang() === "es" && document.documentElement.lang === "es"`), "the page served in Spanish");
  const fine = await sol.eval(`document.querySelector(".fineprint").textContent`);
  check(fine === "Al continuar, aceptas nuestros Términos y nuestra Política de privacidad.", "the agreement line in Spanish, its links in place", fine);
  const fits = async (p, where) => {
    const spills = await p.eval(SPILLS);
    check(spills.length === 0, `${where} in Spanish: every word fits`, spills);
  };
  await fits(sol, "the sign-in screen");
  await walk(sol, fits, "Blanco");
  check((await sol.eval(`document.getElementById("btn-online").textContent`)).includes("DESCONECTARSE"), "Spanish on the buttons", await sol.eval(`document.getElementById("btn-online").textContent`));
  check(sol.errors.length === 0, "no page errors", sol.errors);
});
