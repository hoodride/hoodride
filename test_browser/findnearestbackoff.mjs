// What the search said stays true over time, part 2 (owner, 2026-11-09 —
// "test it to death"): when it looks again, it steps out from where the map
// is (never zooming back in); a car that keeps coming and going is looked
// for 5, 10, 20… s apart, each ±20% at random (as the location heartbeat),
// afresh after a move of yours or a tap (or a minute in sight:
// findnearestsettle.mjs); someone coming into sight under
// "nobody nearby yet" is watched as a find. Part 1:
// findnearestovertime.mjs; parts 3–5: findnearestdriving.mjs,
// findnearestsettle/faults/away/dot.mjs. Helpers and the rule:
// cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, place, search, nobodyAround, tapLocate } from "./cover.mjs";

// the car taken far away (20 km) at the current view — gone from sight
// (the moment, on the page's own clock: window.__goneAt)
const carAway = (p) => p.eval(`(() => { drivers[0].pos = { lat: state.me.lat + 0.2, lng: state.me.lng }; drivers[0].marker.setLngLat([drivers[0].pos.lng, drivers[0].pos.lat]); refreshWorldMarkers(); window.__goneAt = performance.now(); window.__firstStepAt = null; return true; })()`);
// …and back at screen point (x, y) (the view as it is)
const carBack = (p, x, y) => p.eval(`(() => { const ll = map.unproject([${x}, ${y}]); drivers[0].pos = { lat: ll.lat, lng: ll.lng }; drivers[0].marker.setLngLat([ll.lng, ll.lat]); refreshWorldMarkers(); return true; })()`);
// from the car gone to the new search's first step, on the page's clock
const waited = (p) => p.eval(`window.__firstStepAt - window.__goneAt`);
// the wait the app chose for this watch (HoodNearby.researchWait)
const chosen = (p) => p.eval(`foundWatch && foundWatch.wait`);
// it took that wait — and no more than its once-a-second look adds (it
// notices within a second, then looks again within the next): wait..wait+2.5 s
const tookAbout = (w, took) => took >= w && took <= w + 2500;

await journey("findnearestbackoff: looking again outward, longer each time (with jitter), someone appearing", async (browser) => {
  const p = await demo(browser, "BT-Overtime", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  step("found at a wider step; it goes: it looks again from THAT zoom outward — never zooming back in");
  // (a car found only at the second step: just off the screen at the first)
  const zs = await p.eval(`__o.steps()`);
  await place(p, { x: 195, y: -60 });
  const f2 = await search(p);
  check(!f2.nobody && f2.z < zs[0], "(found further out)", f2);
  const seqZ = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await p.waitFor(`nearSeq > ${seqZ} && __trace.length > 0`, "looked again", 30000);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);
  const tz = await p.eval(`__trace.slice()`);
  check(tz.length > 0 && tz.every((z) => z <= f2.z + 1e-6), "every step as wide as where it was, or wider", { tz, from: f2.z });

  step("a car at the edge, gone and back again and again: it looks again after 5 s, then 10, then 20 — not every 5 s for ever");
  await place(p, { x: 195, y: 330 });
  await search(p);
  const waits = [];
  const chose = [];
  for (let k = 0; k < 3; k++) {
    chose.push(await chosen(p));
    const sq = await p.eval(`(__trace.length = 0, nearSeq)`);
    await carAway(p);
    await p.waitFor(`nearSeq > ${sq} && window.__firstStepAt !== null`, `looked again (${k + 1})`, 40000);
    waits.push(await waited(p));
    // back at once: the search finds it again (where the map is)
    await carBack(p, 195, 330);
    await p.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, `found again (${k + 1})`, 20000);
  }
  check(chose[0] === 5000 && chose[1] === 10000 && chose[2] === 20000, "the waits chosen: 5, 10, 20 s — each time longer", chose);
  check(waits.every((w, k) => tookAbout(chose[k], w)), "…and so they took", { waits, chose });
  // a move of yours: back to 5 s
  await p.drag(200, 500, 230, 510);
  await p.waitFor(`!map.isMoving() && researches === 0`, "your move: afresh");
  await search(p);
  check((await chosen(p)) === 5000, "after your move: 5 s again", await chosen(p));
  const sq4 = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await p.waitFor(`nearSeq > ${sq4} && window.__firstStepAt !== null`, "looked again", 30000);
  check(tookAbout(5000, await waited(p)), "…and so it took", await waited(p));
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);

  step("the jitter: phones losing the same car don't all look at once — at either end of the ±20%, 4 s and 6 s");
  for (const [rand, want] of [[0, 4000], [0.999, 5998]]) {
    await p.eval(`(nearRand = () => ${rand}, true)`);
    await place(p, { x: 195, y: 330 });
    await search(p);
    const wc = await chosen(p);
    check(Math.abs(wc - want) < 1, `the random at ${rand}: the wait ${want / 1000} s`, wc);
    const sj = await p.eval(`(__trace.length = 0, nearSeq)`);
    await carAway(p);
    await p.waitFor(`nearSeq > ${sj} && window.__firstStepAt !== null`, "looked again", 30000);
    const wj = await waited(p);
    check(tookAbout(wc, wj), "…and so it took", wj);
    await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);
  }
  await p.eval(`(nearRand = () => 0.5, true)`);

  step("'nobody nearby yet', then a car comes into sight: the line clears — and it's watched: gone again 5 s, it looks again");
  await nobodyAround(p);
  await carBack(p, 195, 330);
  await p.waitFor(`!nobodyNear && foundWatch !== null`, "the line cleared, the car watched", 5000);
  check((await chosen(p)) === 5000, "(the wait: 5 s)", await chosen(p));
  const sa = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await p.waitFor(`nearSeq > ${sa} && window.__firstStepAt !== null`, "looked again", 30000);
  check(tookAbout(5000, await waited(p)), "after 5 s", await waited(p));
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);

  step("…that look-again found nobody; then a car comes into sight again: watched with the NEXT wait — 10 s (the back-off carries on)");
  await p.waitFor(`nobodyNear`, "(nobody: 'nobody nearby yet')", 5000);
  await carBack(p, 195, 330);
  await p.waitFor(`!nobodyNear && foundWatch !== null`, "the line cleared, the car watched", 5000);
  check((await chosen(p)) === 10000, "the wait: 10 s", await chosen(p));

  step("…and a tap on the locate button starts afresh: 5 s again");
  await tapLocate(p);
  await p.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "found", 20000);
  check((await chosen(p)) === 5000, "after your tap: 5 s", await chosen(p));

  await p.close();
});
