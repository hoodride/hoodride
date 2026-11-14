// A quiet update that finishes after you're back (review 2026-11-14). The
// app, hidden, starts its quiet update reload — but first asks the browser
// to fetch the new offline worker, and a hidden phone freezes the page
// mid-fetch. When you came back and started something, the fetch finished
// and the page reloaded under you: what you'd typed, gone. Now it decides
// again when the fetch is done — in use: the "Update available" offer.
import { journey, step, check, server } from "./cdp.mjs";

const HIDE = `(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`;
const SHOW = `(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`;
const LOAD = `String(performance.timeOrigin)`;

await journey("updatereturn: a quiet update finishing once you're back — offered, never reloaded under you", async (browser) => {
  step("Dan's app is open; a new version is deployed");
  const p = await browser.person("BT-Dan");
  await p.open();
  await p.waitFor(`typeof liveNow === "function" && liveNow()`, "the app live", 15000);
  // the browser's fetch of the new offline worker: held until we say
  await p.eval(`(() => {
    navigator.serviceWorker.getRegistration = () => new Promise((done) => (window.__workerFetched = () => done({ update: async () => {} })));
    return true;
  })()`);
  await server("new_build");
  await p.drop();
  await p.restore();
  await p.waitFor(`serverBuild === "journey-new-build" && liveNow()`, "the app knows of the new version", 15000);
  const before = await p.eval(LOAD);

  step("he steps out (hidden, nothing in progress): the quiet update starts — its worker fetch frozen");
  await p.eval(HIDE);
  await p.waitFor(`typeof window.__workerFetched === "function"`, "the quiet update under way");

  step("he comes back and starts filling in his car — then the fetch finishes");
  await p.eval(SHOW);
  await p.eval(`(openCarSheet(), true)`);
  await p.waitFor(`carSheetOpen()`, "the car form open");
  await p.eval(`(document.getElementById("car-make").value = "Honda", true)`);
  await p.eval(`(window.__workerFetched(), true)`);

  await p.waitFor(`!!document.getElementById("update-available")`, "'Update available' offered instead", 5000);
  await new Promise((r) => setTimeout(r, 1500));
  check((await p.eval(LOAD)) === before, "not reloaded under him");
  check(await p.eval(`carSheetOpen() && document.getElementById("car-make").value === "Honda"`), "what he typed still there");
  await p.close();
});
