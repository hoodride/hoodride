// The Terms of Use (owner, 2026-10-31): once per account, before the map —
// "Before you start", "I agree". Until then the server gives no
// connection: no map. Agreed: the map, and not asked again; a new version
// of the terms: asked again. Offline: the tap says so and can be retried.
import { journey, step, check, server, BASE } from "./cdp.mjs";

const termsShown = `document.getElementById("screen-terms").classList.contains("active")`;
const connected = `typeof liveNow === "function" && liveNow() && !!state.realUser`;

await journey("terms: agreed once before the map; a new version asks again", async (browser) => {
  step("Tia signs in for the first time: 'Before you start', not the map");
  const tia = await browser.visitor("BT-Tia");
  await tia.goto(`${BASE}/privacy`);
  check(await tia.eval(`fetch("/api/dev_login", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: "BT-Tia"})}).then(r => r.ok)`), "dev sign-in");
  await tia.goto(`${BASE}/`);
  await tia.waitFor(termsShown, "the Terms screen", 15000);
  check(!(await tia.eval(`document.getElementById("screen-map").classList.contains("active")`)), "no map");
  check(await tia.eval(`!socket`), "no connection");
  check((await tia.eval(`fetch("/api/socket_token").then((r) => r.status)`)) === 403, "the server: no connection token yet");
  check((await tia.eval(`document.getElementById("btn-agree").textContent`)) === "I agree", "the button");
  check(await tia.eval(`(() => { const i = document.querySelector("#screen-terms img.terms-car"); return !!i && i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width === 120; })()`), "the car above it, 120 px");
  // tucked under the car exactly as on the sign-in screen (visitor journey)
  const gap = await tia.eval(`(() => { const i = document.querySelector("#screen-terms img.terms-car").getBoundingClientRect(); const h = document.querySelector("#screen-terms h1").getBoundingClientRect(); return Math.round(h.top - i.bottom); })()`);
  check(gap === -2, "the car right above the heading, as on the sign-in screen", gap);
  const links = await tia.eval(`[...document.querySelectorAll("#screen-terms a")].map((a) => a.getAttribute("href"))`);
  check(JSON.stringify(links) === JSON.stringify(["/terms", "/privacy"]), "links to the Terms and the Privacy Policy", links);
  check(await tia.eval(`fetch("/terms").then((r) => r.text()).then((t) => t.includes("Terms of Use") && t.includes("Effective"))`), "the Terms page opens");

  step("offline, the tap says so; back online, it goes through: the map");
  await tia.offline(true);
  await tia.click("btn-agree");
  await tia.waitFor(`(() => { const e = document.getElementById("terms-error"); return !e.classList.contains("hidden") && e.textContent === "Couldn't reach Hood Ride — try again"; })()`, "'Couldn't reach Hood Ride — try again'");
  check(await tia.eval(termsShown), "still on the Terms screen");
  await tia.offline(false);
  await tia.click("btn-agree");
  await tia.waitFor(connected, "the map, connected", 15000);

  step("reopened: straight to the map, not asked again");
  await tia.open();
  check(!(await tia.eval(termsShown)), "no Terms screen");

  step("a new version of the terms: asked again, then the map");
  await server("terms_new");
  await tia.goto(`${BASE}/`);
  await tia.waitFor(termsShown, "the Terms screen again", 15000);
  await tia.click("btn-agree");
  await tia.waitFor(connected, "the map, connected", 15000);
});
