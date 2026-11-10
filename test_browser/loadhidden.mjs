// The app LOADED while hidden starts (owner, 2026-11-10 — a reviewer found
// it didn't: a line run at load used a helper defined below it, which
// throws only when the page loads hidden). A page loads hidden when:
//   * the silent update reload — designed to happen while the app is in
//     the background, after every deploy (checkForUpdate → HoodUpdate);
//   * a link opened in a background tab, the installed app restored in the
//     background, a page the browser preloads.
// Both are shown: the real update path (a new build, the app hidden — it
// reloads itself hidden), and the demo opened hidden. Each must start (no
// error — any page error fails the journey) and come back normally.
import { journey, step, check, BASE, server } from "./cdp.mjs";

// "hidden" from the very first line of every page this person opens
const HIDDEN = `Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true });`;
// shown again (this page)
const show = (p) => p.eval(`(Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }), Object.defineProperty(document, "hidden", { configurable: true, get: () => false }), document.dispatchEvent(new Event("visibilitychange")), true)`);

await journey("loadhidden: the app loaded while hidden starts — the silent update reload, and a page opened in the background", async (browser) => {
  step("a new version deployed while the app is in the background: it reloads itself, hidden — and starts (signed in, live)");
  const p = await browser.person("BT-Hidden");
  await p.phone(390, 844);
  await p.open();
  await p.waitFor(`typeof liveNow === "function" && liveNow()`, "the app live", 15000);
  const before = await p.eval(`LOADED_BUILD`);
  await server("new_build");
  // (the app hears of it on reconnecting — as account.mjs)
  await p.drop();
  await p.restore();
  await p.waitFor(`serverBuild === "journey-new-build" && liveNow()`, "the app knows of the new version", 15000);
  // from now on every page this phone opens is hidden from its first line
  await p.onEveryPage(HIDDEN);
  // the app goes to the background: it checks for an update — and reloads
  await p.eval(`(() => { ${HIDDEN} document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
  await p.waitFor(`typeof LOADED_BUILD !== "undefined" && LOADED_BUILD === "journey-new-build"`, "reloaded into the new version", 20000);
  check(before !== "journey-new-build", "(another version before)", before);
  // (the boot ran: signed in — any error on the way fails the journey)
  await p.waitFor(`document.visibilityState === "hidden" && !!state.realUser`, "the reloaded app started, hidden, signed in", 15000);
  await show(p);
  await p.waitFor(`liveNow() && !!map && map.loaded()`, "shown: back, live, the map up", 15000);
  await p.close();

  step("the demo opened in a background tab: it starts; shown, it's the map as usual");
  const d = await browser.visitor("BT-HiddenDemo");
  await d.phone(390, 844);
  await d.onEveryPage(HIDDEN);
  await d.goto(`${BASE}/?demo=1`);
  await d.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && map.loaded() && drivers.length >= 2`, "the demo started (hidden)", 20000);
  check(await d.eval(`document.visibilityState === "hidden"`), "(hidden from the start)");
  await show(d);
  await d.waitFor(`document.visibilityState === "visible" && !!map && map.loaded()`, "shown: the map as usual", 5000);
  await d.close();
});
