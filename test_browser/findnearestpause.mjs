// Find the nearest behind a drawer or a form (owner, 2026-11-09 — "test it
// to death"; split from findnearestcover.mjs): a search started (or going)
// while Settings, the car form, the navigation choice, the language list or
// "Use here" hides the map waits where it is, and looks once it's fully gone
// — Settings sliding away included; reduce motion; and what ends a waiting
// search (✋ down, another search, going offline, switching to rider).
// Helpers and the rule: cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import {
  demo, freeze, riderLooking, box, place, at, half, moveTo, sleep, farAway, search, keepsLooking, looksNoMore, tapEl, tapLocate,
} from "./cover.mjs";

await journey("findnearestpause: a search behind a drawer waits, and looks once it's gone", async (browser) => {
  step("a search started behind a drawer or a form (as your first location arriving starts one) waits there — and looks once it's gone");
  const pz = await demo(browser, "BT-CoverPause", { w: 390, h: 844, scale: 2 });
  await freeze(pz);
  await riderLooking(pz);
  const PAUSE = [
    ["Settings", `openSettings()`, `closeSettings()`],
    ["the car form", `openCarSheet()`, `closeCarSheet()`],
    ["the navigation choice", `openNavSheet()`, `closeNavSheet()`],
    ["the language list", `openLangSheet()`, `closeLangSheet()`],
    ["'Use here'", `showSessionMoved()`, `document.getElementById("session-moved").remove()`],
  ];
  for (const [name, open, close] of PAUSE) {
    // a car in plain sight once the map shows again
    await place(pz, { x: 195, y: 330 });
    await pz.eval(`(${open}, true)`);
    check(await pz.eval(`mapOutOfSight()`), `(${name} open: the map out of sight)`);
    await pz.eval(`(__trace.length = 0, findNearest(state.me), true)`);
    await keepsLooking(pz, 1500, `${name} open`);
    // (and not too often: 4 times a second behind it — battery — not 10)
    const rate = await pz.eval(`(__looks = 0, new Promise((r) => setTimeout(() => r(__looks), 2000)))`);
    check(rate >= 5 && rate <= 11, `${name} open: it looks about 4 times a second, not 10 (battery)`, rate);
    const held = await pz.eval(`({ looking: nearLooking, trace: __trace.slice(), nobody: nobodyNear })`);
    check(held.looking && held.trace.length === 1 && !held.nobody, `${name} open: the search waits at its first step — nothing decided`, held);
    await pz.eval(`(${close}, true)`);
    await pz.waitFor(`!nearLooking && !map.isMoving()`, `${name} closed: the search over`, 10000);
    const done = await pz.eval(`({ z: map.getZoom(), nobody: nobodyNear, trace: __trace.slice(), found: foundWatch !== null })`);
    check(done.z === 14 && !done.nobody && done.trace.length === 1 && done.found, `${name} closed: it looks — the car found at once (watched: found, not merely stopped)`, done);
  }

  step("a drawer opened part-way through a search: it waits at that step, then carries on");
  await farAway(pz);
  await pz.eval(`(__trace.length = 0, window.__onStep = (n) => { if (n === 2) openSettings(); }, true)`);
  await pz.click("btn-locate");
  await pz.waitFor(`__trace.length >= 2 && mapOutOfSight()`, "Settings open at the second step");
  await keepsLooking(pz, 1500, "Settings open mid-search");
  const paused = await pz.eval(`({ looking: nearLooking, trace: __trace.slice(), nobody: nobodyNear })`);
  check(paused.looking && paused.trace.length === 2 && !paused.nobody, "Settings open: waiting at the second step", paused);
  // (closed with a finger on its ✕)
  await pz.eval(`(window.__onStep = null, true)`);
  await tapEl(pz, "settings-close");
  await pz.waitFor(`!document.getElementById("settings-sheet").classList.contains("open")`, "Settings closed by its ✕");
  await pz.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 20000);
  const all = await pz.eval(`({ trace: __trace.slice(), steps: __o.steps(), nobody: nobodyNear })`);
  check(all.nobody && all.trace.length === all.steps.length, "closed: it carried on through every step to 'nobody nearby yet'", all);

  step("the screen changing size while the search moves the map (a phone turned, a window resized): the search ends — its steps were for the old size");
  await farAway(pz);
  await pz.eval(`(__trace.length = 0, window.__onStep = (n) => { if (n === 2) setTimeout(() => { document.getElementById("map").style.width = "300px"; map.resize(); }, 100); }, true)`);
  await tapLocate(pz);
  await pz.waitFor(`__trace.length >= 2 && document.getElementById("map").style.width === "300px"`, "resized mid-move");
  await pz.waitFor(`!nearLooking`, "the search ended", 3000);
  await sleep(800);
  const rs = await pz.eval(`({ trace: __trace.slice(), nobody: nobodyNear, looking: nearLooking })`);
  check(rs.trace.length === 2 && !rs.nobody && !rs.looking, "ended on that step: no more steps, nothing said", rs);
  await pz.eval(`(window.__onStep = null, document.getElementById("map").style.width = "", map.resize(), true)`);
  await pz.waitFor(`!map.isMoving()`, "the map its own size again");
  // …and its HEIGHT alone (the address bar sliding, a phone turned)
  await farAway(pz);
  await pz.eval(`(__trace.length = 0, window.__onStep = (n) => { if (n === 2) setTimeout(() => { document.getElementById("map").style.height = "500px"; map.resize(); }, 100); }, true)`);
  await tapLocate(pz);
  await pz.waitFor(`__trace.length >= 2 && document.getElementById("map").style.height === "500px"`, "resized mid-move (height)");
  await pz.waitFor(`!nearLooking`, "the search ended", 3000);
  await sleep(800);
  const rh = await pz.eval(`({ trace: __trace.slice(), nobody: nobodyNear, looking: nearLooking })`);
  check(rh.trace.length === 2 && !rh.nobody && !rh.looking, "the height changed: ended on that step, nothing said", rh);
  await pz.eval(`(window.__onStep = null, document.getElementById("map").style.height = "", map.resize(), true)`);
  await pz.waitFor(`!map.isMoving()`, "the map its own size again");

  step("the screen changing size while the search waits behind Settings: it ends there — closing Settings takes no step, says nothing");
  await farAway(pz);
  await pz.eval(`(openSettings(), __trace.length = 0, findNearest(state.me), true)`);
  await keepsLooking(pz, 600, "Settings open");
  await pz.eval(`(document.getElementById("map").style.width = "300px", map.resize(), true)`);
  await pz.waitFor(`!nearLooking`, "the resize ended it", 2000);
  await pz.eval(`(closeSettings(), document.getElementById("map").style.width = "", map.resize(), true)`);
  await looksNoMore(pz, 1200, "resized while waiting");
  const rw = await pz.eval(`({ trace: __trace.slice(), nobody: nobodyNear })`);
  check(rw.trace.length === 1 && !rw.nobody, "no more steps, nothing said", rw);

  step("the search waits out Settings sliding away: it looks only once the drawer is off the car");
  await pz.eval(`(openSettings(), true)`);
  await pz.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().left) < 0.5`, "Settings all the way open");
  const dz = await pz.eval(`__o.rel(document.getElementById("settings-sheet").getBoundingClientRect())`);
  const hz = await half(pz);
  const carZ = { x: Math.round(dz.right - hz.x - 6), y: 330 };
  await pz.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: INTENT_ZOOM }), true)`);
  await moveTo(pz, carZ);
  await pz.eval(`(__trace.length = 0, findNearest(state.me), true)`);
  await sleep(600);
  check(await pz.eval(`nearLooking && __trace.length === 1`), "(Settings open: the search waits)");
  // the moment the search decides: where's the drawer?
  // (Settings' box at the very moment the map counted as in sight again — the
  // look that decided: recorded by the app's own check, not sampled after)
  await pz.eval(`(window.__lastInSight = null, closeSettings(), true)`);
  await pz.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 10000);
  const dec = await pz.eval(`({ at: __lastInSight, z: map.getZoom(), trace: __trace.slice(), nobody: nobodyNear })`);
  check(dec.at && dec.at.right <= carZ.x - hz.x + 0.5, "the drawer off the car when the search looked", { dec, carZ, hz });
  check(dec.z === 14 && dec.trace.length === 1 && !dec.nobody, "…and it found the car at once", dec);

  step("reduce motion (the phone's setting): Settings opens and goes AT ONCE — no slide, so nothing to wait out");
  await pz.reduceMotion(true);
  const rm = await pz.eval(`(() => { openSettings(); const el = document.getElementById("settings-sheet"); const r = el.getBoundingClientRect(); return { left: r.left, dur: getComputedStyle(el).transitionDuration }; })()`);
  await sleep(50);
  const rm2 = await pz.eval(`(() => { const el = document.getElementById("settings-sheet"); return { left: el.getBoundingClientRect().left, dur: getComputedStyle(el).transitionDuration }; })()`);
  check(rm2.dur.split(",").every((d) => parseFloat(d) === 0) && Math.abs(rm2.left) < 0.5, "open at once, no slide", { rm, rm2 });
  check(Math.abs(rm.left) < 0.5, "open the very moment it's asked (no frame in between)", rm);
  const gone = await pz.eval(`(() => { closeSettings(); return { out: mapOutOfSight(), right: document.getElementById("settings-sheet").getBoundingClientRect().right }; })()`);
  check(!gone.out && gone.right <= 0.5, "closed at once: the map back that very moment", gone);
  await pz.reduceMotion(false);

  step("while the search waits behind Settings: ✋ down ends it — closing then takes no step and says nothing");
  await farAway(pz);
  await pz.eval(`(openSettings(), __trace.length = 0, findNearest(state.me), true)`);
  await sleep(400);
  check(await pz.eval(`nearLooking`), "(waiting)");
  await pz.eval(`(setHand(false), true)`);
  await pz.waitFor(`!nearLooking`, "✋ down ended it", 1000);
  // (closed with a tap beside the drawer, on its backdrop)
  await tapEl(pz, "settings-backdrop", { x: 0.9, y: 0.5 });
  await pz.waitFor(`!document.getElementById("settings-sheet").classList.contains("open")`, "Settings closed by a tap beside it");
  await looksNoMore(pz, 1200, "✋ down");
  const down = await pz.eval(`({ trace: __trace.slice(), nobody: nobodyNear, looking: nearLooking })`);
  check(down.trace.length === 1 && !down.nobody && !down.looking, "no more steps, no 'nobody nearby yet'", down);
  await pz.eval(`(setHand(true), true)`);
  await pz.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "✋ up again, its search over", 20000);

  step("while it waits: a second search replaces the first — one run when the map's back, no doubled steps");
  await place(pz, { x: 195, y: 330 });
  await pz.eval(`(openSettings(), __trace.length = 0, findNearest(state.me), true)`);
  await sleep(300);
  await pz.eval(`(findNearest(state.me), true)`);
  await sleep(300);
  await pz.eval(`(closeSettings(), true)`);
  await pz.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 10000);
  await sleep(800);
  const twice = await pz.eval(`({ trace: __trace.slice(), z: map.getZoom(), nobody: nobodyNear, found: foundWatch !== null })`);
  check(twice.trace.length === 2 && twice.z === 14 && !twice.nobody && twice.found, "two starts at the usual view, then found at once — nothing more", twice);

  step("while it waits (a driver online): switching to rider, or going offline, ends it");
  await pz.eval(`(setHand(false), true)`);
  await pz.click("btn-mode");
  await pz.waitFor(`state.mode === "driver"`, "driver mode");
  await pz.click("btn-online");
  await pz.waitFor(`state.online && !!mockHand && mockHand.visible && !nearLooking && !map.isMoving()`, "online", 20000);
  await farAway(pz, "hand");
  await pz.eval(`(openSettings(), __trace.length = 0, findNearest(state.me), true)`);
  await sleep(400);
  check(await pz.eval(`nearLooking`), "(waiting)");
  await pz.eval(`(document.getElementById("btn-online").click(), true)`);
  await pz.waitFor(`!state.online && !nearLooking`, "offline ended it", 2000);
  await pz.eval(`(closeSettings(), true)`);
  await looksNoMore(pz, 1200, "offline");
  const offl = await pz.eval(`({ trace: __trace.slice(), nobody: nobodyNear })`);
  check(offl.trace.length === 1 && !offl.nobody, "offline: no more steps, nothing said", offl);
  await pz.click("btn-online");
  await pz.waitFor(`state.online && !nearLooking && !map.isMoving()`, "online again", 20000);
  await farAway(pz, "hand");
  await pz.eval(`(openSettings(), __trace.length = 0, findNearest(state.me), true)`);
  await sleep(400);
  check(await pz.eval(`nearLooking`), "(waiting)");
  await pz.eval(`(document.getElementById("btn-mode").click(), true)`);
  await pz.waitFor(`state.mode === "rider" && !nearLooking`, "switching to rider ended it", 2000);
  await pz.eval(`(closeSettings(), true)`);
  await looksNoMore(pz, 1200, "switched to rider");
  const sw = await pz.eval(`({ trace: __trace.slice(), nobody: nobodyNear })`);
  check(sw.trace.length === 1 && !sw.nobody, "rider now: no more steps, nothing said", sw);

  step("'nobody nearby yet' or a find being watched — then switching mode, or ✋ down: the line, or the watch, is over (nothing searched, the map left alone)");
  await pz.eval(`(setHand(true), true)`);
  await pz.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "✋ up again", 20000);
  // (searches counted as they start)
  await pz.eval(`(() => { window.__fn = 0; window.__fn0 = findNearest; findNearest = (...a) => (window.__fn++, window.__fn0(...a)); return true; })()`);
  await farAway(pz);
  await pz.eval(`(window.__fn = 0, findNearest(state.me), true)`);
  await pz.waitFor(`nobodyNear && !nearLooking && !map.isMoving()`, "'nobody nearby yet'", 20000);
  const v1 = await pz.eval(`(window.__fn = 0, { c: map.getCenter(), z: map.getZoom() })`);
  await pz.eval(`(document.getElementById("btn-mode").click(), true)`);
  await pz.waitFor(`state.mode === "driver" && !nobodyNear && nobodyCheck === null`, "the other mode: the line over", 1500);
  check((await pz.eval(`window.__fn`)) === 0, "(nothing searched)");
  await pz.click("btn-mode");
  await pz.waitFor(`state.mode === "rider"`, "rider again");
  await pz.eval(`(setHand(true), true)`);
  await pz.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "✋ up", 20000);
  await place(pz, { x: 195, y: 330 });
  await search(pz);
  check(await pz.eval(`foundCheck !== null`), "(a find: watched)");
  await pz.eval(`(window.__fn = 0, document.getElementById("btn-mode").click(), true)`);
  await pz.waitFor(`state.mode === "driver" && foundCheck === null && foundWatch === null`, "the other mode: the watch over", 1500);
  await pz.eval(`(drivers[0].pos = { lat: state.me.lat + 0.2, lng: state.me.lng }, drivers[0].marker.setLngLat([drivers[0].pos.lng, drivers[0].pos.lat]), true)`);
  await sleep(6500);
  check((await pz.eval(`window.__fn`)) === 0, "the car gone after: no search (nobody watched it)", await pz.eval(`window.__fn`));
  await pz.click("btn-mode");
  await pz.waitFor(`state.mode === "rider"`, "rider again");
  await pz.eval(`(setHand(true), true)`);
  await pz.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "✋ up", 20000);
  await place(pz, { x: 195, y: 330 });
  await search(pz);
  check(await pz.eval(`foundCheck !== null`), "(a find: watched)");
  await pz.eval(`(setHand(false), true)`);
  check(await pz.eval(`foundCheck === null && foundWatch === null`), "✋ down: the watch over at once");
  await pz.eval(`(findNearest = window.__fn0, true)`);
  await pz.close();
});
