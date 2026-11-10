// What the search said stays true over time, part 1 (owner, 2026-11-09 —
// "test it to death"): about where you are NOW, not where it once looked.
//
//   * it found someone, and they've gone (offline, drove off): 5 s with
//     nobody in sight and it looks again (the first wait of the back-off —
//     5 s exactly here: the jitter pinned to its middle, cover.mjs demo();
//     the back-off and jitter: findnearestbackoff.mjs) — not for a blip
//     shorter than that,
//     not while a panel you opened covers part of the map (the chat, a
//     card), not in a ride, never once you've moved the map yourself;
// More over time (a message, Settings, the background, a fault, "Use
// here"): findnearestovertime2.mjs. Back after a while away:
// findnearestaway.mjs.
// Parts 2–5: findnearestbackoff/driving/settle/faults.mjs (and dot.mjs). Helpers and
// the rule: cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, place, search, sleep, tapLocate } from "./cover.mjs";

// the car taken far away (20 km) at the current view — gone from sight
// (the moment, on the page's own clock: window.__goneAt)
const carAway = (p) => p.eval(`(() => { drivers[0].pos = { lat: state.me.lat + 0.2, lng: state.me.lng }; drivers[0].marker.setLngLat([drivers[0].pos.lng, drivers[0].pos.lat]); refreshWorldMarkers(); window.__goneAt = performance.now(); window.__firstStepAt = null; return true; })()`);
// from the car gone to the new search's first step, on the page's clock
const waited = (p) => p.eval(`window.__firstStepAt - window.__goneAt`);
// the wait the app chose for this watch (HoodNearby.researchWait)
const chosen = (p) => p.eval(`foundWatch && foundWatch.wait`);
// it took that wait — and no more than its once-a-second look adds (it
// notices within a second, then looks again within the next): wait..wait+2.5 s
const tookAbout = (w, took) => took >= w && took <= w + 2500;
// a new search started since `seq`?
const searchedSince = (p, seq) => p.eval(`nearSeq > ${seq} && __trace.length > 0`);

await journey("findnearestovertime: the found car gone (not a blip, not under a panel, not in a ride, not once you've moved the map)", async (browser) => {
  const p = await demo(browser, "BT-Overtime", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);

  step("found a car; it goes away: after 5 s with nobody in sight, it looks again (not before)");
  await place(p, { x: 195, y: 330 });
  const f1 = await search(p);
  check(f1.z === 14 && !f1.nobody, "(found at once)", f1);
  const w1 = await chosen(p);
  check(w1 === 5000, "(the wait: 5 s)", w1);
  const seq1 = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await p.waitFor(`nearSeq > ${seq1} && window.__firstStepAt !== null`, "looked again", 30000);
  const took = await waited(p);
  check(tookAbout(w1, took), "after 5 s with nobody in sight (the page's own clock)", took);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);
  check(await p.eval(`nobodyNear`), "(nobody now: 'nobody nearby yet')");
  check((await p.eval(`document.getElementById("banner").textContent`)).includes("nobody nearby yet"), "'nobody nearby yet' on the screen");
  // …and then quiet: no search again and again (nothing found to watch)
  const seqQ = await p.eval(`nearSeq`);
  await sleep(7000);
  check((await p.eval(`nearSeq`)) === seqQ && (await p.eval(`foundWatch === null`)), "quiet after: no more searches", await p.eval(`({ seq: nearSeq })`));

  step("found a car; it's gone for 2 s, then back: no new search");
  await place(p, { x: 195, y: 330 });
  await search(p);
  const seq2 = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  // (back 2 s later on the page's own clock)
  await p.eval(`(setTimeout(() => { const ll = map.unproject([195, 330]); drivers[0].pos = { lat: ll.lat, lng: ll.lng }; drivers[0].marker.setLngLat([ll.lng, ll.lat]); refreshWorldMarkers(); window.__backAt = performance.now(); }, 2000), true)`);
  await p.waitFor(`!!window.__backAt`, "back", 10000);
  check((await p.eval(`window.__backAt - window.__goneAt`)) < 4500, "(gone for less than 5 s, on the page's clock)");
  await sleep(6000);
  check(!(await searchedSince(p, seq2)), "a blip shorter than 5 s: nothing", await p.eval(`({ seq: nearSeq, trace: __trace.slice() })`));

  step("found a car; it goes — 3 s later the chat opens a while, then closes: the count starts over (5 s after it closes, not at once)");
  await place(p, { x: 195, y: 330 });
  await search(p);
  const seqP = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await sleep(3000);
  await p.eval(`(openChat(drivers[1]), true)`);
  await p.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat open");
  await sleep(6000);
  check(!(await searchedSince(p, seqP)), "(the chat open: no new search)", await p.eval(`({ seq: nearSeq })`));
  await p.eval(`(closeChat(), true)`);
  await sleep(4000);
  check(!(await searchedSince(p, seqP)), "closed: not at once — the count started over (5 s)", await p.eval(`({ seq: nearSeq })`));
  await p.waitFor(`nearSeq > ${seqP}`, "then it looked again", 8000);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);

  step("found a car; the chat open over the map while it goes: the watch waits — closed, then 5 s, it looks again");
  await place(p, { x: 195, y: 330 });
  await search(p);
  const seq3 = await p.eval(`(__trace.length = 0, nearSeq)`);
  await p.eval(`(openChat(drivers[1]), true)`);
  await p.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat open");
  await carAway(p);
  await sleep(7000);
  check(!(await searchedSince(p, seq3)), "the chat open: no new search", await p.eval(`({ seq: nearSeq })`));
  await p.eval(`(closeChat(), true)`);
  const t3 = Date.now();
  await p.waitFor(`nearSeq > ${seq3}`, "looked again once the chat closed", 12000);
  check(Date.now() - t3 >= 4500, "5 s after it closed, not at once", Date.now() - t3);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);

  step("found a car; a person's card open over the map while it goes: the watch waits too");
  await place(p, { x: 195, y: 330 });
  await search(p);
  const seqC = await p.eval(`(__trace.length = 0, nearSeq)`);
  await p.eval(`(openPeerCard(drivers[1]), true)`);
  await p.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "the card open");
  await carAway(p);
  await sleep(7000);
  check(!(await searchedSince(p, seqC)), "the card open: no new search", await p.eval(`({ seq: nearSeq })`));
  await p.eval(`(closeMapOverlays(), true)`);
  await p.waitFor(`nearSeq > ${seqC}`, "looked again once the card closed", 12000);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);

  step("found a car; a ride requested (you're not looking any more); then it goes: no new search");
  await place(p, { x: 195, y: 330 });
  await search(p);
  await p.eval(`(openChat(drivers[0]), true)`);
  await p.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await p.click("btn-ride-action");
  await p.waitFor(`!!state.ride`, "requested");
  await p.eval(`(closeChat(), true)`);
  // (in a ride you look for nobody: the locate button centres on you, close
  // up, as before — no search)
  const seqL = await p.eval(`(__trace.length = 0, nearSeq)`);
  await p.eval(`(map.jumpTo({ center: [state.me.lng + 0.01, state.me.lat], zoom: 12 }), true)`);
  await p.waitFor(`!map.isMoving()`, "moved off");
  await tapLocate(p);
  await p.waitFor(`!map.isMoving() && Math.abs(map.getCenter().lng - state.me.lng) < 1e-6`, "the locate button: back on you", 5000);
  const inRide = await p.eval(`({ z: map.getZoom(), trace: __trace.length, looking: nearLooking })`);
  check(inRide.z >= 15 && inRide.trace === 0 && !inRide.looking, "in a ride, the locate button: on you, zoom 15 or closer — no search", inRide);
  const seqR = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await sleep(7000);
  check(!(await searchedSince(p, seqR)) && (await p.eval(`foundWatch === null`)), "in a ride: no new search, the watch over", await p.eval(`({ seq: nearSeq, ride: state.ride && state.ride.status })`));
  await p.eval(`(state.ride && state.ride.status === "connected" ? document.getElementById("btn-endride").click() : (state.ride = null), true)`);
  await p.waitFor(`!state.ride`, "the ride over");
  if (!(await p.eval(`state.handRaised`))) {
    await p.click("btn-hand");
    await p.waitFor(`state.handRaised`, "✋ up again");
  }
  await p.waitFor(`!nearLooking && !map.isMoving()`, "still", 20000);

  step("found a car; you drag the map; then it goes: no new search — the map is yours");
  await place(p, { x: 195, y: 330 });
  await search(p);
  await p.drag(200, 500, 240, 520);
  await p.waitFor(`!map.isMoving()`, "dragged");
  const seq4 = await p.eval(`(__trace.length = 0, nearSeq)`);
  await carAway(p);
  await sleep(7000);
  check(!(await searchedSince(p, seq4)), "moved by you: nothing", await p.eval(`({ seq: nearSeq })`));

  await p.close();
});
