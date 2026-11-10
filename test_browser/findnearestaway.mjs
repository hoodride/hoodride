// Back to the app after a while away (owner, 2026-11-10 — "test it to
// death"): the map never zooms in by itself — only your tap gives a fresh
// close-up. So coming back (from another app, the phone unlocked, back
// from memory) searches nothing, however long you were away; "nobody nearby
// yet" clears by itself once you're back if someone came into sight — just
// as while you watch; and while the app is in the background, it isn't
// looked at (battery). Parts 1–5: findnearestovertime/backoff/driving/
// settle/faults.mjs. Helpers and the rule: cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, nobodyAround, moveTo, sleep } from "./cover.mjs";

// the app hidden / shown (both of the page's signals, as a browser gives them)
const hide = (p) => p.eval(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
const shown = (p) => p.eval(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
// back from memory (an iPhone can skip the visibility signal then)
const fromMemory = (p) => p.eval(`(window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })), true)`);

await journey("findnearestaway: back to the app after a while — no search by itself; 'nobody nearby yet' clears itself if someone came into sight; not looked at in the background", async (browser) => {
  const p = await demo(browser, "BT-Away", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  // every search counted as it starts (the search number also moves when
  // something merely stops one)
  await p.eval(`(() => { window.__fn = 0; const f = findNearest; findNearest = (...a) => (window.__fn++, f(...a)); return true; })()`);

  step("'nobody nearby yet', nobody came: back after an hour (another app, the phone locked; back from memory too) — nothing searched, the line as it was, the map where it was");
  await nobodyAround(p);
  const view = await p.eval(`(window.__fn = 0, { c: map.getCenter(), z: map.getZoom() })`);
  await hide(p);
  // (an hour away, on both clocks — the steady one and the wall one — as a
  // phone locked all afternoon: any "a while away" rule would search now)
  await p.eval(`(() => { const pn = performance.now.bind(performance), dn = Date.now; window.__clocks0 = { pn, dn }; performance.now = () => pn() + 3600000; Date.now = () => dn() + 3600000; return true; })()`);
  await shown(p);
  await fromMemory(p);
  await sleep(2500);
  await p.eval(`(performance.now = window.__clocks0.pn, Date.now = window.__clocks0.dn, true)`);
  const after = await p.eval(`({ fn: window.__fn, nobody: nobodyNear, c: map.getCenter(), z: map.getZoom() })`);
  check(after.fn === 0 && after.nobody, "back: no search of its own — 'nobody nearby yet' still true, still said", after);
  check(Math.abs(after.c.lat - view.c.lat) < 1e-9 && Math.abs(after.c.lng - view.c.lng) < 1e-9 && Math.abs(after.z - view.z) < 1e-9, "the map where it was", { view, after });

  step("a car comes into sight while the app is in the background: not looked at there (battery) — back, the line clears by itself within a second, as while you watch; still no search, no zoom");
  await hide(p);
  const looks0 = await p.eval(`(__looks = 0, nearbyArrived(), __looks)`);
  check(looks0 === 0, "(in the background: 'nobody nearby yet' doesn't even look at the map)", looks0);
  await moveTo(p, { x: 195, y: 330 });
  check(await p.eval(`__o.seenNow("car")`), "(by the test's rule: the car in sight)");
  await sleep(2500);
  check(await p.eval(`nobodyNear`), "in the background: the line stays (nobody's looking)");
  const z1 = await p.eval(`map.getZoom()`);
  await shown(p);
  await p.waitFor(`!nobodyNear && foundWatch !== null`, "back: the line cleared by itself, the car watched", 2500);
  check((await p.eval(`window.__fn`)) === 0 && Math.abs((await p.eval(`map.getZoom()`)) - z1) < 1e-9, "no search, no zoom — the map stays", { fn: await p.eval(`window.__fn`) });

  step("'nobody nearby yet', the app in the background, and what you look for changes there (✋ down — say a ride): the line is over at once, even in the background — nothing stale kept");
  await nobodyAround(p);
  await hide(p);
  // (searches counted from here: nobodyAround's own search was before)
  await p.eval(`(window.__fn = 0, state.handRaised = false, true)`);
  await p.waitFor(`!nobodyNear && nobodyCheck === null`, "cleared in the background", 2500);
  check((await p.eval(`window.__fn`)) === 0, "(no search for it)", await p.eval(`window.__fn`));
  await shown(p);
  await p.close();
});
