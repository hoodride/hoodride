// What covers the map, part 2 (owner, 2026-11-09 — "if you can see it on
// the map, it counts"; "test it to death"): the other covers — a person's
// card, the share-location prompt, "Update available" — the driver's side
// (a ✋), a right-to-left language (the locate button on the left), and the
// search ending part-way (a swipe, ✋ down). Each expected answer comes from
// the test's own rule (cover.mjs).
// The others: findnearestcover/2/3/3b/4/5/6.mjs, findnearestpause.mjs,
// findnearestnobody.mjs, findnearestovertime/backoff/driving/
// settle/faults/away/dot.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, box, mapSize, at, half, drawnWherePredicted, place, inside, leftOf, rightOf, above, farAway, onlyUnder, moveTo, tapLocate, looksNoMore, nobodyAround, onlyTheSecondLook, allLooksBack, staysNobody, clearsWithin, sleep } from "./cover.mjs";

await journey("findnearestcover2: a card, the share prompt, Update available, the driver's side, right-to-left, a search ended part-way", async (browser) => {
  const p = await demo(browser, "BT-Card", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  const hc = await half(p);

  step("a person's card open: under it doesn't count; above it does; the card stays open");
  await p.eval(`(openPeerCard(drivers[1]), true)`);
  await p.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "the card open");
  const card = await box(p, "#peer-card");
  await at(p, inside(card, 0.3), "further", "under the card", "car", "#peer-card");
  await at(p, above(card, hc.y, 2, 195), "usual", "just above the card");
  check(await p.eval(`!document.getElementById("peer-card").classList.contains("hidden")`), "the card still open");
  await p.eval(`(closeMapOverlays(), true)`);

  step("the share-location prompt: under it doesn't count; beside it does");
  await p.eval(`(showSharePrompt("Tap to share your location"), true)`);
  const share = await box(p, "#share-location");
  await at(p, inside(share), "further", "under the share prompt", "car", "#share-location");
  const { w } = await mapSize(p);
  if (share.left > 2 * hc.x + 4) await at(p, leftOf(share, hc.x, 2), "usual", "beside the share prompt");
  else check(share.right + 2 * hc.x + 4 < w, "(room beside the share prompt on one side)", share);
  if (share.left <= 2 * hc.x + 4) await at(p, rightOf(share, hc.x, 2), "usual", "beside the share prompt");
  await p.eval(`(hideSharePrompt(), true)`);

  step("'Update available': under it doesn't count");
  await p.eval(`(showUpdateAvailable(), true)`);
  const upd = await box(p, "#update-available");
  await at(p, await onlyUnder(p, "#update-available"), "further", "under 'Update available'", "car", "#update-available");
  await p.eval(`(document.getElementById("update-available").remove(), true)`);

  step("a search ended part-way by a swipe: it stops on that step — no more steps, no 'nobody'");
  await farAway(p);
  // (a finger's drag the moment the search takes its second step: wherever
  // it lands, the search ends there — no step more, nothing said)
  const all = await p.eval(`__o.steps().length`);
  check(all >= 4, "(nobody in reach: every step would be taken)", all);
  // (its camera slowed — each step's move 6 s — so the drag lands mid-move,
  // however busy the machine)
  const before = await p.eval(`(__trace.length = 0, window.__slowSteps = 6000, nearSeq)`);
  await tapLocate(p);
  // (20 s: the first step's move alone is the 6 s set above, then the map
  // settles — 10 s left ~4 s spare, and a busy full run ran out, 2026-11-12)
  await p.waitFor(`nearSeq > ${before} && __trace.length >= 2`, "the second step", 20000);
  await p.drag(120, 420, 260, 420);
  await p.eval(`(window.__slowSteps = 0, true)`);
  await p.waitFor(`!nearLooking`, "the drag ended it", 5000);
  const n0 = await p.eval(`__trace.length`);
  await looksNoMore(p, 2200, "dragged");
  const sw = await p.eval(`({ trace: __trace.slice(), nobody: nobodyNear, looking: nearLooking })`);
  check(n0 < all && sw.trace.length === n0 && !sw.nobody && !sw.looking, "a finger's drag ends it where it was: no step more, nothing said", { sw, n0, all });

  // the race behind a flaky drag (owner, 2026-11-10): a finger put down on
  // the map STOPS the search's moving step at once — the search saw a still
  // map and took its next step straight away, its own move then overriding
  // the finger's drag before it began. A press on the bare map while the
  // search is stepping ends it — before any move
  step("a finger put down on the map mid-step (not moved yet): the search ends there — no next step, no 'nobody'");
  await farAway(p);
  const pb = await p.eval(`(__trace.length = 0, window.__slowSteps = 6000, nearSeq)`);
  await tapLocate(p);
  // (20 s: the first step's move alone is the 6 s set above, then the map
  // settles — 10 s left ~4 s spare, and a busy full run ran out, 2026-11-12)
  await p.waitFor(`nearSeq > ${pb} && __trace.length >= 2`, "the second step", 20000);
  await p.press(120, 420);
  await p.eval(`(window.__slowSteps = 0, true)`);
  await new Promise((r) => setTimeout(r, 1500));
  const pr = await p.eval(`({ looking: nearLooking, trace: __trace.slice(), nobody: nobodyNear })`);
  await p.release(120, 420);
  check(!pr.looking && pr.trace.length === 2 && !pr.nobody, "the press ended it: no next step, nothing said", pr);

  step("a search ended part-way by ✋ down: no more steps, no 'nobody'");
  await farAway(p);
  await p.eval(`(window.__onStep = (n) => { if (n === 2) document.getElementById("btn-hand").click(); }, true)`);
  await p.eval(`(__trace.length = 0, true)`);
  await p.click("btn-locate");
  await p.waitFor(`!state.handRaised && !nearLooking && !map.isMoving()`, "✋ down, the search ended", 20000);
  await new Promise((r) => setTimeout(r, 1000));
  const hd = await p.eval(`({ trace: __trace.slice(), nobody: nobodyNear })`);
  check(hd.trace.length === 2 && !hd.nobody, "✋ down ends it on that step", hd);
  await p.eval(`(window.__onStep = null, true)`);

  step("driver, online: the ✋'s marker where the maths says; under the locate button doesn't count, beside it does; under the bottom bar's button doesn't");
  await p.click("btn-mode");
  await p.waitFor(`state.mode === "driver"`, "driver mode");
  await p.click("btn-online");
  await p.waitFor(`state.online && !!mockHand && mockHand.visible && !nearLooking && !map.isMoving()`, "online, the pretend ✋ there", 20000);
  const hh = await half(p, "hand");
  await place(p, { x: 120, y: 300 }, "hand");
  await drawnWherePredicted(p, "hand");
  const dloc = await box(p, "#btn-locate");
  await at(p, inside(dloc), "further", "a ✋ under the locate button", "hand", "#btn-locate");
  await at(p, leftOf(dloc, hh.x, 2), "usual", "a ✋ beside the locate button", "hand");
  await at(p, await onlyUnder(p, "#bottom-controls > *", "hand"), "further", "a ✋ under the GO ONLINE button", "hand", "#bottom-controls > *");
  await p.close();

  step("a driver on a small phone (320×568): a ✋ under GO OFFLINE doesn't count; beside it does");
  const sm = await demo(browser, "BT-SmallDriver", { w: 320, h: 568, scale: 2 });
  await freeze(sm);
  await sm.click("btn-mode");
  await sm.waitFor(`state.mode === "driver"`, "driver mode");
  await sm.click("btn-online");
  await sm.waitFor(`state.online && !!mockHand && mockHand.visible && !nearLooking && !map.isMoving()`, "online, the pretend ✋ there", 20000);
  const hs = await half(sm, "hand");
  await at(sm, await onlyUnder(sm, "#bottom-controls > *", "hand"), "further", "a ✋ under GO OFFLINE (small phone)", "hand", "#bottom-controls > *");
  const off = await box(sm, "#btn-online");
  const sms = await mapSize(sm);
  const besideOff = off.left > 2 * hs.x + 4 ? leftOf(off, hs.x, 2, Math.round(off.top - hs.y - 40)) : rightOf(off, hs.x, 2, Math.round(off.top - hs.y - 40));
  check(besideOff.x - hs.x >= 0 && besideOff.x + hs.x <= sms.w, "(room beside GO OFFLINE)", { off, besideOff });
  await at(sm, besideOff, "usual", "a ✋ beside GO OFFLINE, just above its row (small phone)", "hand");
  await sm.close();

  step("right-to-left (Arabic): the locate button on the left — under it doesn't count, beside it (to its right) does");
  const ar = await demo(browser, "BT-Arabic", { w: 390, h: 844, scale: 2, lang: "ar" });
  check((await ar.eval(`document.documentElement.dir`)) === "rtl", "the page right-to-left", await ar.eval(`document.documentElement.dir`));
  await freeze(ar);
  await riderLooking(ar);
  const ha = await half(ar);
  const aloc = await box(ar, "#btn-locate");
  const as = await mapSize(ar);
  check(aloc.left < as.w / 2, "(the locate button on the left in Arabic)", aloc);
  await at(ar, inside(aloc), "further", "under the locate button (Arabic)", "car", "#btn-locate");
  await at(ar, rightOf(aloc, ha.x, 2), "usual", "beside the locate button, to its right (Arabic)");
  await at(ar, rightOf(aloc, ha.x, -1), "further", "a pixel into its right side (Arabic)", "car", "#btn-locate");
  const aban = await box(ar, "#banner");
  await at(ar, { x: Math.round(as.w / 2), y: Math.round(aban.bottom - 4) }, "further", "under the banner (Arabic)", "car", "#banner");

  step("right-to-left: Settings slides in from the RIGHT — the search, and 'nobody nearby yet', wait until it's off the car");
  await ar.eval(`(openSettings(), true)`);
  await ar.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().right - window.innerWidth) < 0.5`, "Settings all the way open (from the right)");
  const ad = await ar.eval(`__o.rel(document.getElementById("settings-sheet").getBoundingClientRect())`);
  check(ad.left > 2 * ha.x + 20, "(the drawer on the right side)", ad);
  const carA = { x: Math.round(ad.left + ha.x + 6), y: 330 };
  await ar.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: INTENT_ZOOM }), true)`);
  await moveTo(ar, carA);
  await ar.eval(`(__trace.length = 0, findNearest(state.me), true)`);
  await sleep(600);
  check(await ar.eval(`nearLooking && __trace.length === 1`), "(Settings open: the search waits)");
  // (Settings' box at the very moment the map counted as in sight again — the
  // look that decided: recorded by the app's own check, not sampled after)
  await ar.eval(`(window.__lastInSight = null, closeSettings(), true)`);
  await ar.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 10000);
  const decA = await ar.eval(`({ at: __lastInSight, z: map.getZoom(), trace: __trace.slice(), nobody: nobodyNear })`);
  check(decA.at && decA.at.left >= carA.x + ha.x - 0.5, "the drawer off the car (to its right) when the search looked", { decA, carA, ha });
  check(decA.z === (await ar.eval(`__o.steps()[0]`)) && decA.trace.length === 1 && !decA.nobody, "…and it found the car at once", decA);
  // "nobody nearby yet" the same
  await nobodyAround(ar);
  await onlyTheSecondLook(ar);
  await ar.eval(`(openSettings(), true)`);
  await ar.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().right - window.innerWidth) < 0.5`, "Settings all the way open");
  await moveTo(ar, carA);
  await staysNobody(ar, 2500, "Settings open over the car (right-to-left)");
  await ar.eval(`(window.__seqFrom = nearSeq, window.__lastInSight = null, closeSettings(), window.__nearbyArrived(), setTimeout(() => window.__nearbyArrived(), 60), setTimeout(() => window.__nearbyArrived(), 120), true)`);
  await clearsWithin(ar, 2500, "Settings gone (right-to-left)", Infinity);
  const clA = await ar.eval(`__lastInSight`);
  check(clA && clA.left >= carA.x + ha.x - 0.5, "the drawer no longer over the car when the line cleared", { clA, carA });
  await allLooksBack(ar);
  await ar.close();
});
