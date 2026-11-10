// What the search said stays true over time, part 4 (owner, 2026-11-09 —
// "test it to death"): the back-off coming back down. A car that came and
// went (looked for 5, then 10 s apart: the next wait 20 s) and then stays
// in sight a whole minute without a break: the back-off starts over — gone
// now, it looks again after 5 s. Under the minute: kept. The minute is
// broken by: a panel over the map, Settings, a short message, the app in
// the background, the car gone a moment, and a gap in the watch's looks (a
// phone locked — its timers frozen — or a laptop asleep: the wall clock
// jumps on, nobody watching). The server's resync and a drawing pending
// don't break it: findnearestdriving.mjs. Parts 1–3, 5:
// findnearestovertime/backoff/driving/faults.mjs. Helpers and the rule:
// cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, place, search, sleep } from "./cover.mjs";

// the car taken far away (20 km) at the current view — gone from sight
// (the moment, on the page's own clock: window.__goneAt)
const carAway = (p) => p.eval(`(() => { drivers[0].pos = { lat: state.me.lat + 0.2, lng: state.me.lng }; drivers[0].marker.setLngLat([drivers[0].pos.lng, drivers[0].pos.lat]); refreshWorldMarkers(); window.__goneAt = performance.now(); window.__firstStepAt = null; return true; })()`);
// …and back at screen point (x, y) (the view as it is)
const carBack = (p, x, y) => p.eval(`(() => { const ll = map.unproject([${x}, ${y}]); drivers[0].pos = { lat: ll.lat, lng: ll.lng }; drivers[0].marker.setLngLat([ll.lng, ll.lat]); refreshWorldMarkers(); return true; })()`);
const waited = (p) => p.eval(`window.__firstStepAt - window.__goneAt`);
const chosen = (p) => p.eval(`foundWatch && foundWatch.wait`);
const tookAbout = (w, took) => took >= w && took <= w + 2500;
// gone, looked again, back at once — found again (the back-off one up)
async function flicker(p, k) {
  const sq = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await p.waitFor(`nearSeq > ${sq} && window.__firstStepAt !== null`, `looked again (${k})`, 30000);
  await carBack(p, 195, 330);
  await p.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, `found again (${k})`, 20000);
}
// the minute in sight made exactly `ms` old, on both clocks (set on the
// page: no delay of the test's own in it)
const age = (p, ms) => p.eval(`(() => { const by = ${ms} - HoodNearby.elapsed(foundWatch.seenAt, clocks()); foundWatch.seenAt.p -= by; foundWatch.seenAt.d -= by; return true; })()`);

await journey("findnearestsettle: the back-off starts over once the found car has been in sight a whole minute", async (browser) => {
  const p = await demo(browser, "BT-Overtime", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);

  step("a car coming and going: looked for after 5 s, then 10 s — the next wait 20 s");
  await place(p, { x: 195, y: 330 });
  await search(p);
  await flicker(p, 1);
  await flicker(p, 2);
  check((await chosen(p)) === 20000 && (await p.eval(`researches`)) === 2, "(the next wait: 20 s)", await chosen(p));

  step("in sight 55 s (and a look or two after): the back-off kept");
  await p.waitFor(`foundWatch && foundWatch.seenAt !== null`, "the car seen (the minute running)", 3000);
  await age(p, 55000);
  await sleep(1500);
  check((await chosen(p)) === 20000 && (await p.eval(`researches`)) === 2, "under a minute: still 20 s", await chosen(p));

  step("a panel over the map breaks the minute: counted afresh after it (not added up)");
  await p.eval(`(document.getElementById("pile-sheet").classList.remove("hidden"), true)`);
  await p.waitFor(`foundWatch.seenAt === null`, "a panel over it: the minute over", 3000);
  await p.eval(`(document.getElementById("pile-sheet").classList.add("hidden"), true)`);
  await p.waitFor(`foundWatch.seenAt !== null`, "seen again: a new minute", 3000);
  for (const id of ["chat", "peer-card"]) {
    await p.eval(`(document.getElementById("${id}").classList.remove("hidden"), true)`);
    await p.waitFor(`foundWatch.seenAt === null`, `${id} open: the minute over`, 3000);
    await p.eval(`(document.getElementById("${id}").classList.add("hidden"), true)`);
    await p.waitFor(`foundWatch.seenAt !== null`, `${id} closed: a new minute`, 3000);
  }
  await age(p, 55000);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "after the panel: 55 s and on, not two minutes — kept", await p.eval(`researches`));

  step("a short message up over the map breaks it too");
  await p.eval(`(transientBanner("a message, up for a while", 9000), true)`);
  await p.waitFor(`foundWatch.seenAt === null`, "a message up: the minute over", 3000);
  await p.eval(`(clearTimeout(bannerTimer), bannerTimer = null, setBanner(contextBanner()), true)`);
  await p.waitFor(`foundWatch.seenAt !== null`, "the message gone: a new minute", 3000);
  await age(p, 55000);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "after the message: counted afresh — kept", await p.eval(`researches`));

  step("the app in the background breaks it too");
  await p.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => true }), true)`);
  await p.waitFor(`foundWatch.seenAt === null`, "in the background: the minute over", 3000);
  await p.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => false }), true)`);
  await p.waitFor(`foundWatch.seenAt !== null`, "shown: a new minute", 3000);
  await age(p, 55000);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "after the background: counted afresh — kept", await p.eval(`researches`));

  step("…and gone for a moment breaks it (the count of 'gone' starts, the minute ends)");
  const sg = await p.eval(`nearSeq`);
  await carAway(p);
  await p.waitFor(`foundWatch.seenAt === null && foundWatch.goneAt !== null`, "gone: the minute over", 3000);
  await carBack(p, 195, 330);
  await p.waitFor(`foundWatch.seenAt !== null && foundWatch.goneAt === null`, "back before the wait: a new minute", 3000);
  check((await p.eval(`researches`)) === 2 && (await p.eval(`nearSeq`)) === sg, "(no look again: back in time)");
  await age(p, 55000);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "after the gap: counted afresh — kept", await p.eval(`researches`));

  step("Settings over the map breaks it too");
  await p.eval(`(openSettings(), true)`);
  await p.waitFor(`foundWatch.seenAt === null`, "Settings up: the minute over", 3000);
  await p.eval(`(closeSettings(), true)`);
  await p.waitFor(`foundWatch.seenAt !== null`, "Settings closed: a new minute", 5000);
  await age(p, 55000);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "after Settings: counted afresh — kept", await p.eval(`researches`));

  step("a laptop asleep (the app still on screen): the wall clock jumps 10 minutes, the watch didn't look meanwhile — not a minute in sight");
  // (the watch's timer stopped as asleep; the wall clock moved on 10 min
  // past everything it had noted; then it wakes)
  await p.eval(`(clearInterval(foundCheck), foundWatch.seenAt.d -= 600000, foundWatch.lookedAt && (foundWatch.lookedAt.d -= 600000), foundCheck = setInterval(watchLook, 1000), true)`);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2 && (await chosen(p)) === 20000, "woke: the back-off kept (20 s)", await chosen(p));
  check(await p.eval(`foundWatch.seenAt !== null && HoodNearby.elapsed(foundWatch.seenAt, clocks()) < 3000`), "(…and a new minute from waking)", await p.eval(`foundWatch.seenAt`));

  step("a phone locked (its timers frozen 4 s, no background event): the gap breaks the minute too");
  await p.eval(`(clearInterval(foundCheck), foundWatch.seenAt.p -= 61000, foundWatch.seenAt.d -= 61000, true)`);
  await sleep(4000);
  await p.eval(`(foundCheck = setInterval(watchLook, 1000), true)`);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "unfrozen: the back-off kept", await p.eval(`researches`));
  // (a gap ends only the minute in sight: the car gone, frozen 4 s mid
  // count — the count of "gone" kept, not started over)
  await carAway(p);
  await p.waitFor(`foundWatch.goneAt !== null`, "gone: the count running", 3000);
  const gone = await p.eval(`foundWatch.goneAt.p`);
  await p.eval(`(clearInterval(foundCheck), true)`);
  await sleep(4000);
  await p.eval(`(foundCheck = setInterval(watchLook, 1000), true)`);
  await sleep(1500);
  check((await p.eval(`foundWatch && foundWatch.goneAt && foundWatch.goneAt.p`)) === gone, "a gap mid-count: the count of 'gone' kept", gone);
  await carBack(p, 195, 330);
  await p.waitFor(`foundWatch.seenAt !== null && foundWatch.goneAt === null`, "back (before the 20 s): seen again", 3000);
  // (looking every second again: no gap — counted on)
  await age(p, 55000);
  await sleep(1500);
  check((await p.eval(`researches`)) === 2, "(looking every second again: counted on — kept at 55 s and on)", await p.eval(`researches`));

  step("the gap's line: 2.6 s between two looks (a busy phone) keeps the minute; 3.4 s breaks it");
  // (the last look made exactly that long ago, and the next look made at
  // once — on the page: exact)
  const gapLook = (ms) => p.eval(`(() => { clearInterval(foundCheck); const by = ${ms} - HoodNearby.elapsed(foundWatch.lookedAt, clocks()); foundWatch.lookedAt.p -= by; foundWatch.lookedAt.d -= by; const before = foundWatch.seenAt && foundWatch.seenAt.p; stillSeen(); const after = foundWatch.seenAt && foundWatch.seenAt.p; foundCheck = setInterval(watchLook, 1000); return { before, after }; })()`);
  await p.waitFor(`foundWatch.seenAt !== null && foundWatch.lookedAt !== null`, "(seen, looked)", 3000);
  const g1 = await gapLook(2600);
  check(g1.before !== null && g1.after === g1.before, "2.6 s between looks: the minute kept", g1);
  const g2 = await gapLook(3400);
  check(g2.before !== null && g2.after !== g2.before, "3.4 s between looks: the minute started over", g2);

  step("a whole minute in sight without a break: the back-off starts over — 5 s with its jitter (here 5.8 s); gone now, it looks again after that; from there it backs off again");
  // (the jitter's random at 0.9 for the new wait: 5 s +16% — the jitter
  // kept on a reset too)
  await p.eval(`(nearRand = () => 0.9, true)`);
  await age(p, 60200);
  await p.waitFor(`researches === 0 && Math.abs(foundWatch.wait - 5800) < 1`, "in sight a whole minute (just over): back to 5 s, jittered (5.8 s)", 2500);
  await p.eval(`(nearRand = () => 0.5, true)`);
  const ss = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await p.waitFor(`nearSeq > ${ss} && window.__firstStepAt !== null`, "looked again", 30000);
  check(tookAbout(5800, await waited(p)), "…and so it took: 5.8 s", await waited(p));
  await carBack(p, 195, 330);
  await p.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "found again", 20000);
  check((await chosen(p)) === 10000, "(and from there it backs off again: 10 s)", await chosen(p));

  step("with the back-off at its start already, a minute in sight changes nothing (no look, the wait as chosen)");
  await p.eval(`(researches = 0, foundWatch.wait = 4321, true)`);
  await p.waitFor(`foundWatch.seenAt !== null`, "the car seen (the minute running)", 3000);
  await age(p, 61000);
  await sleep(1500);
  check((await chosen(p)) === 4321, "nothing to start over: the wait untouched", await chosen(p));

  step("'nobody nearby yet' with the back-off up, then the car comes into sight: watched with the longer wait (20 s) — and a minute in sight starts it over there too");
  await p.eval(`(stopFindNearest(), researches = 2, setNobodyNear(true), true)`);
  await p.waitFor(`!nobodyNear && foundWatch !== null`, "the car in sight: the line cleared, watched", 3000);
  check((await chosen(p)) === 20000, "watched with the wait it had: 20 s", await chosen(p));
  await p.waitFor(`foundWatch.seenAt !== null`, "the car seen (the minute running)", 3000);
  await age(p, 55000);
  await sleep(1500);
  check((await chosen(p)) === 20000, "(55 s: kept)", await chosen(p));
  await age(p, 60200);
  await p.waitFor(`researches === 0 && foundWatch.wait === 5000`, "a minute in sight: back to 5 s", 2500);
  await p.close();
});
