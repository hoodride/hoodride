// A new version while the car form is open (U2, owner 2026-11-11): a
// driver filling in their car steps out of the app (to check the model on
// the papers, say) — the app, hidden, reloaded itself for the update and
// what they'd typed was gone. An open car form is "in progress": no silent
// reload; the update waits ("Update available") and the form stays.
import { journey, step, check, server } from "./cdp.mjs";

const HIDE = `(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`;
const SHOW = `(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`;

await journey("carformupdate: a new version while the car form is open — no reload, nothing typed lost", async (browser) => {
  step("Dan opens his car form and starts filling it in");
  const p = await browser.person("BT-Dan");
  await p.phone(390, 844);
  await p.open();
  await p.waitFor(`typeof liveNow === "function" && liveNow()`, "the app live", 15000);
  await p.eval(`(openCarSheet(), true)`);
  await p.waitFor(`carSheetOpen()`, "the car form open");
  await p.eval(`(() => { const c = document.getElementById("car-color"); c.value = c.options[1].value; document.getElementById("car-make").value = "Honda"; document.getElementById("car-model").value = "Civ"; return true; })()`);
  const typed = await p.eval(`[document.getElementById("car-color").value, document.getElementById("car-make").value, document.getElementById("car-model").value]`);

  step("a new version is deployed; he steps out of the app (it's hidden): no reload");
  await server("new_build");
  await p.drop();
  await p.restore();
  await p.waitFor(`serverBuild === "journey-new-build" && liveNow()`, "the app knows of the new version", 15000);
  const loads = await p.eval(`performance.getEntriesByType("navigation").length + ":" + performance.timeOrigin`);
  await p.eval(HIDE);
  // hidden and busy: the update offered at once, not reloaded (a reload
  // would have no "Update available" — the new build has nothing to offer)
  await p.waitFor(`!!document.getElementById("update-available")`, "'Update available' offered while hidden (no reload)", 3000);
  // (and still no reload a while later: the hidden journey's takes ~2 s)
  await new Promise((r) => setTimeout(r, 3000));
  check((await p.eval(`performance.getEntriesByType("navigation").length + ":" + performance.timeOrigin`)) === loads, "not reloaded while the form is open");

  step("back in the app: the form as he left it, and the update offered");
  await p.eval(SHOW);
  check(await p.eval(`carSheetOpen()`), "the car form still open");
  const kept = await p.eval(`[document.getElementById("car-color").value, document.getElementById("car-make").value, document.getElementById("car-model").value]`);
  check(JSON.stringify(kept) === JSON.stringify(typed), "everything he typed still there", { typed, kept });
  await p.waitFor(`!!document.getElementById("update-available")`, "'Update available' offered");

  step("the form closed, hidden again: now the silent update reload goes ahead");
  await p.eval(`(document.getElementById("car-cancel").click(), true)`);
  await p.waitFor(`!carSheetOpen()`, "the car form closed");
  await p.eval(HIDE);
  await p.waitFor(`typeof LOADED_BUILD !== "undefined" && LOADED_BUILD === "journey-new-build"`, "reloaded into the new version", 20000);
  await p.waitFor(`typeof liveNow === "function" && liveNow()`, "the new version live", 15000);

  // the other reload that comes on return (review, 2026-11-11): location
  // blocked, then away and back — likely from Settings, so the app reloads
  // once to pick up the change. The car form open: not then either
  step("location blocked, the car form half filled in: away and back — no reload, nothing lost");
  await p.locationPermission("denied");
  // (the app learns it when it needs location: his ✋ tap)
  await p.eval(`(document.getElementById("btn-hand").click(), true)`);
  await p.waitFor(`loc.status === "denied"`, "location blocked, as the app sees it");
  check(!(await p.eval(`state.handRaised`)), "(✋ not up: nothing in progress but the form, below)");
  await p.eval(`(openCarSheet(), true)`);
  await p.waitFor(`carSheetOpen()`, "the car form open");
  await p.eval(`(document.getElementById("car-model").value = "Acc", true)`);
  const before = await p.eval(`String(performance.timeOrigin)`);
  await p.eval(HIDE);
  await p.eval(SHOW);
  await new Promise((r) => setTimeout(r, 3000));
  check((await p.eval(`String(performance.timeOrigin)`)) === before, "not reloaded on return with the form open");
  check(await p.eval(`carSheetOpen() && document.getElementById("car-model").value === "Acc"`), "the form and what he typed still there");

  step("the form closed: away and back now reloads (the reload is real, only held for the form)");
  await p.eval(`(document.getElementById("car-cancel").click(), true)`);
  await p.waitFor(`!carSheetOpen()`, "the car form closed");
  await p.eval(HIDE);
  await p.eval(SHOW);
  await p.waitFor(`String(performance.timeOrigin) !== ${JSON.stringify(before)}`, "reloaded on return", 15000);
  await p.waitFor(`typeof liveNow === "function" && liveNow()`, "live again", 15000);

  // new Terms of Use published while the form is open (owner, 2026-11-11):
  // the app is refused ("Terms first") and reloads to ask — not while the
  // form is open; saving it still works, then the Terms are asked
  step("new Terms while the car form is open: no reload; Save works, then the Terms are asked");
  await p.eval(`(openCarSheet(), true)`);
  await p.waitFor(`carSheetOpen()`, "the car form open");
  await p.eval(`(() => { const c = document.getElementById("car-color"); c.value = c.options[2].value; document.getElementById("car-make").value = "Toyota"; document.getElementById("car-model").value = "Camry"; return true; })()`);
  const atTerms = await p.eval(`String(performance.timeOrigin)`);
  await server("terms_new");
  // (the app asks for a fresh pass, as after a failed connect: refused, "Terms first")
  await p.eval(`(window.__refused = refreshSocketToken().then(() => true), true)`);
  await p.waitFor(`reloadAfterCarForm === true`, "refused: the reload held for the form", 10000);
  await new Promise((r) => setTimeout(r, 2000));
  check((await p.eval(`String(performance.timeOrigin)`)) === atTerms, "not reloaded with the form open");
  check(await p.eval(`carSheetOpen() && document.getElementById("car-model").value === "Camry"`), "the form and what he typed still there");
  await p.eval(`(document.getElementById("car-save").click(), true)`);
  await p.waitFor(`document.getElementById("screen-terms") && document.getElementById("screen-terms").classList.contains("active")`, "saved, then the Terms asked", 20000);
  check((await p.eval(`String(performance.timeOrigin)`)) !== atTerms, "(reloaded to ask)");
  await p.click("btn-agree");
  await p.waitFor(`typeof liveNow === "function" && liveNow()`, "agreed: the app", 15000);
  // (the server's own record of his car)
  const car = await p.eval(`fetch("/api/car").then((r) => r.json()).then((b) => b.car)`);
  check(car.make === "Toyota" && car.model === "Camry", "the car he typed was saved", car);
  await p.close();
});
