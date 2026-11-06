// What the language journeys share (languages.mjs, languagelabels.mjs,
// languagescreens.mjs — one journey split in three, owner 2026-11-05: at
// 2½ minutes it outgrew the test's database time). Runs no journey itself.
import { step, check, BASE } from "./cdp.mjs";

// cut off or spilling out: a shown button or banner whose words are wider
// than its box — or a box grown past the screen's edge by a long word (it
// never overflows itself then: the first version missed exactly that)
// nothing on screen still moving (the menu slides in for 0.2 s: measured
// mid-slide it "stuck out"); endless ones (a pulsing pin) don't count
export const SETTLED = `document.getAnimations().every((a) => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity)`;

export const SPILLS = `(() => [...document.querySelectorAll("button, .btn, .banner, .drawer-row, label")]
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
export const FITS_ALL = (langs) => `(async () => {
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
    // (as the server serves it: Arabic, Hebrew, Urdu mirrored)
    document.documentElement.dir = ["ar", "he", "ur"].includes(lang) ? "rtl" : "ltr";
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
export async function walk(p, look, colorStart) {
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

