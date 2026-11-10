// What the search said stays true over time, part 1b (owner, 2026-11-09 —
// "test it to death"; split from findnearestovertime.mjs to keep each
// journey well under its time limit): a found car gone while a short
// message, Settings, the car form or the background is over the map — the
// watch waits, then looks again; the background part-way through the count
// keeps it; a fault in the watch's own look ends it cleanly; "Use here" on
// another device ends it. Helpers and the rule: cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, place, search, sleep, looksNoMore } from "./cover.mjs";

// the car taken far away (20 km) at the current view — gone from sight
// (the moment, on the page's own clock: window.__goneAt)
const carAway = (p) => p.eval(`(() => { drivers[0].pos = { lat: state.me.lat + 0.2, lng: state.me.lng }; drivers[0].marker.setLngLat([drivers[0].pos.lng, drivers[0].pos.lat]); refreshWorldMarkers(); window.__goneAt = performance.now(); window.__firstStepAt = null; return true; })()`);
// a new search started since `seq`?
const searchedSince = (p, seq) => p.eval(`nearSeq > ${seq} && __trace.length > 0`);

await journey("findnearestovertime2: the found car gone under a message, a drawer, the background; a fault; another device", async (browser) => {
  const p = await demo(browser, "BT-Overtime2", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);

  step("found a car; it goes while a short message is up over the map, or Settings, or the car form, or the app is in the background: the watch waits — then it looks again");
  for (const [name, open, close] of [
    ["a message", `transientBanner("a message, up for a while", 9000)`, `(clearTimeout(bannerTimer), bannerTimer = null, setBanner(contextBanner()))`],
    ["Settings", `openSettings()`, `closeSettings()`],
    ["the car form", `openCarSheet()`, `closeCarSheet()`],
    ["the background", `Object.defineProperty(document, "hidden", { configurable: true, get: () => true })`, `Object.defineProperty(document, "hidden", { configurable: true, get: () => false })`],
  ]) {
    await place(p, { x: 195, y: 330 });
    await search(p);
    const sw = await p.eval(`(__trace.length = 0, nearSeq)`);
    await p.eval(`(${open}, true)`);
    await carAway(p);
    await sleep(8000);
    check(!(await searchedSince(p, sw)), `${name}: no new search meanwhile`, await p.eval(`({ seq: nearSeq })`));
    await p.eval(`(${close}, true)`);
    await p.waitFor(`nearSeq > ${sw}`, `${name} gone: looked again`, 15000);
    await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);
  }

  // coming back to the app NEVER searches at once (owner, 2026-11-10): the
  // wait for a car already gone starts over from the return — told by the
  // page's own "hidden" event (the watch's timer may not run at all in the
  // background), or else by the watch's first look while hidden
  for (const how of ["the hidden event", "only the watch's own look"]) {
    step(`found a car; it goes; the app in the background part-way through the count (${how}): back, the wait starts over — no search at once, then one a full 5 s later`);
    await place(p, { x: 195, y: 330 });
    await search(p);
    check((await p.eval(`foundWatch.wait`)) === 5000, "(the wait: 5 s)");
    const sh = await p.eval(`(__trace.length = 0, nearSeq)`);
    await carAway(p);
    // 2 s into the count: hidden for 4 s, then shown — started over: looks
    // again 5 s after being shown (11 s from gone); kept: ~1 s after
    // the event alone: hidden and shown again in ONE moment — the watch
    // never looks while hidden (as when the phone froze its timers), so only
    // the event can tell it. The watch's own look: hidden 4 s, no event.
    const hidden = (v) => `Object.defineProperty(document, "hidden", { configurable: true, get: () => ${v} });`;
    const fire = `document.dispatchEvent(new Event("visibilitychange"));`;
    if (how === "the hidden event")
      await p.eval(`(setTimeout(() => { ${hidden(true)} ${fire} ${hidden(false)} ${fire} window.__shownAt = performance.now(); }, 2000), true)`);
    else await p.eval(`(setTimeout(() => { ${hidden(true)} setTimeout(() => { ${hidden(false)} window.__shownAt = performance.now(); }, 4000); }, 2000), true)`);
    await p.waitFor(`nearSeq > ${sh} && window.__firstStepAt !== null`, "looked again", 30000);
    const tb = await p.eval(`({ fromGone: window.__firstStepAt - window.__goneAt, fromShown: window.__firstStepAt - window.__shownAt })`);
    check(tb.fromShown >= 4500 && tb.fromShown <= 8000 && tb.fromGone >= (how === "the hidden event" ? 6500 : 10000), `${how}: back from the background, the wait started over (no search at once)`, tb);
    await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);
  }

  step("something going wrong in the watch's own look: it ends cleanly (reported), not failing once a second for ever");
  await place(p, { x: 195, y: 330 });
  await search(p);
  await p.eval(`(() => { const ss = stillSeen; window.__ss = ss; stillSeen = () => { throw new Error("a test's own fault, in the watch"); }; return true; })()`);
  await p.waitFor(`foundWatch === null`, "the watch ended", 5000);
  await p.eval(`(stillSeen = window.__ss, true)`);
  await looksNoMore(p, 1500, "after the watch's fault");
  await p.expectError("a test's own fault, in the watch");

  step("another device takes over ('Use here') while a find is watched: the watch ends — nothing looks on behind the cover");
  await place(p, { x: 195, y: 330 });
  await search(p);
  check(await p.eval(`foundWatch !== null`), "(watched)");
  await p.eval(`(onSessionMoved(), true)`);
  await p.waitFor(`foundWatch === null && !!document.getElementById("session-moved")`, "the cover up, the watch over", 3000);
  await carAway(p);
  await looksNoMore(p, 2500, "Use here, a find watched");
  await p.close();
});
