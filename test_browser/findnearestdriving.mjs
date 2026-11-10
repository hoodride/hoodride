// What the search said stays true over time, part 3 (owner, 2026-11-09 —
// "test it to death"), with real accounts: a driver who found a ✋ — or
// found nobody — driving off: 300 m on nothing, 600 m from where it looked
// and it looks again from where she is; a good reading arriving mid-search
// far from where it looks starts it again from there; and only ROUGH
// location readings (indoors): it never looks from the app's starting
// placeholder (New York); the server unanswered a while (its resync), or a
// drawing pending, doesn't break the minute in sight that starts the
// back-off over — not even past the watch's 3 s gap. Parts 1, 2, 4, 5:
// findnearestovertime/backoff/settle/faults/away/dot.mjs. Helpers and the rule:
// cover.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline } from "./app.mjs";
import { oracle, tapLocate, sleep } from "./cover.mjs";

// a new search started since `seq`?
const searchedSince = (p, seq) => p.eval(`nearSeq > ${seq} && __trace.length > 0`);

await journey("findnearestdriving: a driver driving off (found, or nobody), and rough readings only (never the app's placeholder)", async (browser) => {
  step("a driver online who FOUND a ✋, driving off: 450 m on — nothing; 550 m from where it looked — it looks again from there (a new place: the back-off afresh)");
  const rae = await browser.person("BT-Rae", { latitude: HOME.latitude + 0.002, longitude: HOME.longitude });
  await rae.phone(390, 844);
  await rae.open();
  await rae.click("btn-hand");
  await rae.waitFor(`state.handRaised`, "Rae's ✋ up");
  const dora = await browser.person("BT-Dora", HOME);
  await dora.phone(390, 844);
  await goOnline(dora);
  await dora.waitFor(`state.online && state.haveFix && !nearLooking && !map.isMoving()`, "Dora online, her first search over", 30000);
  await oracle(dora);
  // (the jitter of "look again" at its middle: exact waits — 5, 10, 20… s;
  // her search again with it pinned)
  await dora.eval(`(nearRand = () => 0.5, true)`);
  await tapLocate(dora);
  await dora.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "Dora's search, found again", 30000);
  check(await dora.eval(`!nobodyNear && foundWatch !== null`), "(Dora's search found Rae's ✋)", await dora.eval(`({ nobody: nobodyNear })`));
  // the server not answered (as while reconnecting: the markers come back
  // after it) — Rae's ✋ gone meanwhile isn't "gone": the watch waits
  await dora.eval(`(window.__settled = worldSync.settled, worldSync.settled = () => false, true)`);
  const seqW = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await rae.click("btn-hand");
  await rae.waitFor(`!state.handRaised`, "Rae's ✋ down");
  await dora.waitFor(`![...pileMarkers.values()].some((pm) => pm.type === "hand")`, "Rae's ✋ gone from Dora's map", 15000);
  await sleep(8000);
  check(!(await searchedSince(dora, seqW)), "not answered yet: no new search", await dora.eval(`({ seq: nearSeq })`));
  await rae.click("btn-hand");
  await rae.waitFor(`state.handRaised`, "Rae's ✋ up again");
  await dora.waitFor(`[...pileMarkers.values()].some((pm) => pm.type === "hand")`, "Rae's ✋ back on Dora's map", 15000);
  await dora.eval(`(worldSync.settled = window.__settled, true)`);
  await sleep(1500);
  check(!(await searchedSince(dora, seqW)) && (await dora.eval(`foundWatch !== null`)), "answered again, Rae in sight: still watched, no search", await dora.eval(`({ seq: nearSeq })`));

  // Rae in sight, the back-off up (as after a ✋ coming and going): the
  // server unanswered a while (its resync every minute), a drawing pending,
  // or its answer as another role (mid-switch) — the watch's looks are
  // skipped (not "Rae in sight"), but the minute in sight that starts the
  // back-off over isn't broken either (else it never could): the minute
  // put at 59 s as the skip starts — a look not skipped would complete it
  // there; kept, it completes once answered
  for (const [what, on, off] of [
    ["the server unanswered 4.5 s", `worldSync.settled = () => false`, `worldSync.settled = window.__settled`],
    ["a drawing pending 4.5 s", `(window.__pend = renderMarkersSoon.pending, renderMarkersSoon.pending = () => true)`, `renderMarkersSoon.pending = window.__pend`],
    ["answered as another role 4.5 s", `(window.__sr = serverRole, serverRole = "viewer")`, `serverRole = window.__sr`],
  ]) {
    await dora.eval(`(researches = 2, foundWatch.wait = HoodNearby.researchWait(2, nearRand()), true)`);
    await dora.waitFor(`foundWatch.seenAt !== null`, "Rae seen (the minute running)", 3000);
    const seqK = await dora.eval(`nearSeq`);
    // (4.5 s: longer than the watch's gap — its looks went on all along)
    await dora.eval(`(() => { ${on}; const by = 59000 - HoodNearby.elapsed(foundWatch.seenAt, clocks()); foundWatch.seenAt.p -= by; foundWatch.seenAt.d -= by; return true; })()`);
    const kept = await dora.eval(`foundWatch.seenAt.p`);
    await sleep(4500);
    const mid = await dora.eval(`({ researches, wait: foundWatch && foundWatch.wait, seen: foundWatch && foundWatch.seenAt && foundWatch.seenAt.p, seq: nearSeq })`);
    await dora.eval(`(${off}, true)`);
    check(mid.researches === 2 && mid.wait === 20000 && mid.seen === kept && mid.seq === seqK, `${what}: looks skipped — the minute neither completed nor broken meanwhile, no search`, mid);
    await dora.waitFor(`researches === 0 && foundWatch.wait === 5000`, `${what}, then answered: the minute (kept through it) completes — 5 s`, 3000);
  }

  // the server's regular resync landing mid-count (not answered for a
  // moment): the count goes on — the look again comes on time, not started
  // over (it would be 9.5 s or more)
  await dora.eval(`(() => {
    window.__goneAt = null; window.__firstStepAt = null; __trace.length = 0;
    const iv = setInterval(() => { if (![...pileMarkers.values()].some((pm) => pm.type === "hand")) { window.__goneAt = performance.now(); clearInterval(iv);
      setTimeout(() => { worldSync.settled = () => false; setTimeout(() => { worldSync.settled = window.__settled; }, 1500); }, 3000); } }, 20);
    return true;
  })()`);
  check((await dora.eval(`foundWatch && foundWatch.wait`)) === 5000, "(the wait: 5 s)");
  const seqS = await dora.eval(`nearSeq`);
  await rae.click("btn-hand");
  await rae.waitFor(`!state.handRaised`, "Rae's ✋ down");
  await dora.waitFor(`nearSeq > ${seqS} && window.__firstStepAt !== null && window.__goneAt !== null`, "looked again", 30000);
  const took = await dora.eval(`window.__firstStepAt - window.__goneAt`);
  check(took >= 5000 && took <= 8500, "a resync mid-count: on time (the count went on)", took);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 30000);
  await rae.click("btn-hand");
  await rae.waitFor(`state.handRaised`, "Rae's ✋ up again");
  await tapLocate(dora);
  await dora.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "Dora's search found Rae again", 30000);

  // a view refused for good while watched: the watch ends (never waits for
  // an answer that won't come)
  await dora.eval(`(window.__refused = worldSync.refused, worldSync.refused = () => true, true)`);
  await dora.waitFor(`foundWatch === null`, "refused: the watch ended", 3000);
  await dora.eval(`(worldSync.refused = window.__refused, true)`);
  await tapLocate(dora);
  await dora.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "Dora's search found Rae again", 30000);
  // …and refused for good while a search waits for its answer: the search
  // ends — never left "looking" for ever; nothing said, nothing watched
  await dora.eval(`(worldSync.settled = () => false, __trace.length = 0, true)`);
  const seqRf = await dora.eval(`nearSeq`);
  await tapLocate(dora);
  await dora.waitFor(`nearSeq > ${seqRf} && nearLooking && __trace.length >= 1 && !map.isMoving()`, "a search waiting for its answer", 5000);
  await sleep(600);
  check(await dora.eval(`nearLooking`), "(still waiting: not answered)");
  await dora.eval(`(worldSync.refused = () => true, true)`);
  await dora.waitFor(`!nearLooking`, "refused: the search ended", 1500);
  const rf = await dora.eval(`({ nobody: nobodyNear, watch: foundWatch, n: __trace.length })`);
  await dora.eval(`(worldSync.refused = window.__refused, worldSync.settled = window.__settled, true)`);
  check(!rf.nobody && rf.watch === null && rf.n === 1, "refused mid-search: ended at its first step — nothing said, nothing watched", rf);
  await tapLocate(dora);
  await dora.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "Dora's search found Rae again", 30000);
  // …and the server not yet answering as the role she looks as (a driver
  // just gone online: its "you're a driver" can come after the map's
  // answer — then only cars are on her map): the search waits at its first
  // step — never "nobody" for want of the ✋ layer; once it has, found
  await dora.eval(`(window.__sr = serverRole, serverRole = "viewer", __trace.length = 0, true)`);
  const seqRole = await dora.eval(`nearSeq`);
  await tapLocate(dora);
  await dora.waitFor(`nearSeq > ${seqRole} && nearLooking && __trace.length >= 1 && !map.isMoving()`, "a search under way", 5000);
  await sleep(2500);
  const wr = await dora.eval(`({ looking: nearLooking, n: __trace.length, nobody: nobodyNear, watch: foundWatch })`);
  check(wr.looking && wr.n === 1 && !wr.nobody && wr.watch === null, "answered as another role: the search waits at its first step — nothing decided", wr);
  await dora.eval(`(serverRole = window.__sr, true)`);
  await dora.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "her role answered: Rae found", 10000);
  check((await dora.eval(`__trace.length`)) === 1, "(found at the first step — not further out)", await dora.eval(`__trace.slice()`));

  // the server saying "slow down" mid-search (its allowance spent — as when
  // a group's list has just asked for 20 names): the search waits and
  // carries on — it never ends without an answer
  await dora.eval(`(() => {
    window.__slow = [];
    const push = worldChannel.push.bind(worldChannel);
    window.__push0 = push;
    worldChannel.push = (ev, ...rest) => { const r = push(ev, ...rest); if (ev === "sync") r.receive("error", (e) => window.__slow.push(e && e.reason)); return r; };
    return true;
  })()`);
  await dora.eval(`(map.jumpTo({ center: [state.me.lng + 0.02, state.me.lat], zoom: 14 }), true)`);
  await dora.waitFor(`!map.isMoving() && worldSync.settled()`, "moved off, answered", 15000);
  // (the allowance spent: names asked for, as a group's list does)
  await dora.eval(`(() => { const ids = Array.from({ length: 20 }, (_, i) => 900000 + i); for (let k = 0; k < 2; k++) worldChannel.push("reveal", { ids }); return true; })()`);
  const seqSlow = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await tapLocate(dora);
  await dora.waitFor(`nearSeq > ${seqSlow} && !nearLooking && !map.isMoving()`, "the search answered in the end", 30000);
  const slow = await dora.eval(`({ slow: window.__slow.slice(), found: foundWatch !== null, nobody: nobodyNear })`);
  check(slow.slow.includes("rate_limited"), "(the server said 'slow down' during the search)", slow);
  check(slow.found && !slow.nobody, "slowed down: the search waited and found Rae — never ended without an answer", slow);
  await dora.eval(`(worldChannel.push = window.__push0, true)`);

  // everyone gone and the count past its wait — while a newcomer's ✋ is
  // known but not drawn yet (the drawing held back, as on a slow phone): no
  // look again on what isn't drawn; drawn, the newcomer is in sight
  const seqN = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await rae.click("btn-hand");
  await rae.waitFor(`!state.handRaised`, "Rae's ✋ down");
  await dora.waitFor(`![...pileMarkers.values()].some((pm) => pm.type === "hand") && foundWatch && foundWatch.goneAt`, "Rae's ✋ gone from Dora's map, the count running", 15000);
  // (from now on the markers' drawing is held back — learned by asking for
  // one draw and seeing what comes; a draw already on its way would ask for
  // no frame (and teach nothing): waited out first, and the hold checked)
  const holding = await dora.eval(`(async () => {
    for (let k = 0; k < 100 && renderMarkersSoon.pending(); k++) await new Promise((r) => setTimeout(r, 20));
    const raf = window.requestAnimationFrame.bind(window);
    let sig = null;
    window.requestAnimationFrame = (f) => { sig = String(f); return raf(f); };
    renderMarkersSoon();
    window.__held = [];
    window.requestAnimationFrame = (f) => (sig !== null && String(f) === sig ? window.__held.push(f) : raf(f));
    window.__rafBack = () => { window.requestAnimationFrame = raf; window.__held.splice(0).forEach((f) => raf(f)); };
    return sig !== null;
  })()`);
  check(holding, "(the markers' drawing really held back from here on)");
  // (the watch's wait made long while Ty is set up — starting his browser
  // can take more than 5 s, and with nothing yet held the watch would rightly
  // look again; the wait is put back once his ✋ is known and held)
  await dora.eval(`(foundWatch.wait = 3600000, true)`);
  // (every search started from here noted, with what started it — should
  // the check below ever fail, it says why)
  await dora.eval(`(() => { window.__fnLog = []; window.__fnOrig = findNearest; findNearest = (...a) => { window.__fnLog.push({ stack: String(new Error().stack).split(String.fromCharCode(10)).slice(1, 6).map((l) => l.trim()).join(" < "), pending: renderMarkersSoon.pending(), held: (window.__held || []).length, settled: worldSync.settled(), role: serverRole }); return window.__fnOrig(...a); }; return true; })()`);
  const ty = await browser.person("BT-Ty", { latitude: HOME.latitude + 0.0025, longitude: HOME.longitude + 0.001 });
  await ty.phone(390, 844);
  await ty.open();
  await ty.click("btn-hand");
  await ty.waitFor(`state.handRaised`, "Ty's ✋ up");
  const tyId = await ty.id();
  await dora.waitFor(`realEntries.has(${tyId}) && renderMarkersSoon.pending()`, "Ty's ✋ known to Dora's app, not drawn yet", 15000);
  // (now the count's real wait — gone since long before: past it already)
  await dora.eval(`(foundWatch.wait = 5000, true)`);
  // past the count's wait (5 s) with nobody DRAWN in sight
  await sleep(8000);
  check(!(await searchedSince(dora, seqN)), "a ✋ known but not drawn yet: no look again", await dora.eval(`({ seq: nearSeq, trace: __trace.slice(), started: window.__fnLog })`));
  await dora.eval(`(findNearest = window.__fnOrig, true)`);
  await dora.eval(`(__rafBack(), true)`);
  await dora.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.includes(${tyId}))`, "Ty's ✋ drawn", 5000);
  await sleep(1500);
  check(!(await searchedSince(dora, seqN)) && (await dora.eval(`foundWatch && foundWatch.goneAt === null`)), "drawn: Ty in sight — the watch content, no search", await dora.eval(`({ seq: nearSeq })`));
  await ty.click("btn-hand");
  await ty.waitFor(`!state.handRaised`, "Ty's ✋ down");
  await ty.close();
  await rae.click("btn-hand");
  await rae.waitFor(`state.handRaised`, "Rae's ✋ up again");
  await tapLocate(dora);
  await dora.waitFor(`!nearLooking && !map.isMoving() && foundWatch !== null`, "Dora's search found Rae again", 30000);

  const fa = await dora.eval(`nearAt`);
  // (the back-off up, as after a ✋ coming and going here)
  const seqF = await dora.eval(`(__trace.length = 0, researches = 3, nearSeq)`);
  const east = (m) => ({ latitude: fa.lat, longitude: fa.lng + m / (111320 * Math.cos((fa.lat * Math.PI) / 180)) });
  await dora.locate(east(450));
  await dora.waitFor(`Math.abs(state.me.lng - ${east(450).longitude}) < 1e-7`, "Dora 450 m on", 15000);
  await sleep(1500);
  check(!(await searchedSince(dora, seqF)), "450 m: nothing", await dora.eval(`({ seq: nearSeq })`));
  await dora.locate(east(550));
  await dora.waitFor(`Math.abs(state.me.lng - ${east(550).longitude}) < 1e-7`, "Dora 550 m on", 15000);
  await dora.waitFor(`nearSeq > ${seqF} && __trace.length > 0`, "550 m: it looked again", 5000);
  check(Math.abs((await dora.eval(`nearAt.lng`)) - east(550).longitude) < 1e-7, "…from where Dora is now");
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 30000);
  const fw = await dora.eval(`({ watch: !!foundWatch, wait: foundWatch && foundWatch.wait, researches })`);
  check(fw.watch && fw.wait === 5000 && fw.researches === 0, "found from the new place: watched with the first wait (5 s) — not the back-off of the old place", fw);
  // 200 m further on (under 500 m: no search), then Rae's ✋ goes: the look
  // again is from where Dora IS now, not where the search once looked
  await dora.locate(east(750));
  await dora.waitFor(`Math.abs(state.me.lng - ${east(750).longitude}) < 1e-7`, "Dora 200 m further", 15000);
  const seqU = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await sleep(1500);
  check(!(await searchedSince(dora, seqU)), "(200 m: no search)", await dora.eval(`({ seq: nearSeq })`));
  await rae.click("btn-hand");
  await rae.waitFor(`!state.handRaised`, "Rae's ✋ down");
  // (a short message is up a while as her ✋ goes: by design the watch
  // counts nobody "gone" under it — so it's waited out first)
  await dora.waitFor(`!bannerTimer`, "the message gone", 20000);
  await dora.waitFor(`nearSeq > ${seqU} && __trace.length > 0`, "Rae gone: it looked again", 15000);
  check(Math.abs((await dora.eval(`nearAt.lng`)) - east(750).longitude) < 1e-7, "…from where Dora is now (her last good reading) — not where it once looked", await dora.eval(`nearAt`));
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 30000);
  await rae.close();

  step("a driver online, 'nobody nearby yet' (the map at its widest), driving: 450 m on — nothing; 550 m from where it looked — it looks again from there, at the zoom the map is at: never zooming in by itself (owner, 2026-11-10)");
  await dora.locate(HOME);
  await dora.waitFor(`Math.abs(state.me.lat - ${HOME.latitude}) < 1e-7 && Math.abs(state.me.lng - ${HOME.longitude}) < 1e-7`, "Dora back home", 15000);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "still", 30000);
  await tapLocate(dora);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "her search over", 30000);
  check(await dora.eval(`nobodyNear`), "(nobody around Dora: 'nobody nearby yet')");
  const at0 = await dora.eval(`nobodyAt`);
  const z6 = await dora.eval(`map.getZoom()`);
  check(z6 < 14, "(the map zoomed out to its widest)", z6);
  const seq6 = await dora.eval(`(__trace.length = 0, nearSeq)`);
  const north = (m) => ({ latitude: at0.lat + m / 111320, longitude: at0.lng });
  await dora.locate(north(450));
  await dora.waitFor(`Math.abs(state.me.lat - ${north(450).latitude}) < 1e-7`, "Dora 450 m on", 15000);
  await sleep(1500);
  check(!(await searchedSince(dora, seq6)), "450 m: nothing", await dora.eval(`({ seq: nearSeq })`));
  await dora.locate(north(550));
  await dora.waitFor(`Math.abs(state.me.lat - ${north(550).latitude}) < 1e-7`, "Dora 550 m on", 15000);
  await dora.waitFor(`nearSeq > ${seq6} && __trace.length > 0`, "550 m: it looked again", 5000);
  const from = await dora.eval(`({ at: nearAt, me: state.me })`);
  check(Math.abs(from.at.lat - north(550).latitude) < 1e-7, "…from where Dora is now", from);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 30000);
  check(await dora.eval(`nobodyNear && Math.abs(nobodyAt.lat - ${north(550).latitude}) < 1e-7`), "'nobody nearby yet' — about here now");
  const t6 = await dora.eval(`__trace.slice()`);
  check(t6.length > 0 && t6.every((z) => z <= z6 + 1e-6), "every step as wide as the map was, or wider — no zooming in", { t6, z6 });

  // a ROUGH reading 1.5 km off (indoors, a 3 km circle): not where she is —
  // no search; a good reading there: it looks again
  const seqRough = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await dora.locate({ ...north(1500), accuracy: 3000 });
  // (it arrived: the blue dot shows it — only a good reading moves the search)
  await dora.waitFor(`Math.abs(meMarker.getLngLat().lat - ${north(1500).latitude}) < 1e-7`, "the rough reading arrived", 15000);
  await sleep(2500);
  check(!(await searchedSince(dora, seqRough)) && (await dora.eval(`nobodyNear && Math.abs(nobodyAt.lat - ${north(550).latitude}) < 1e-7`)), "a rough reading 1.5 km off: no search, 'nobody nearby yet' still about here", await dora.eval(`({ seq: nearSeq, at: nobodyAt })`));
  await dora.locate(north(1500));
  await dora.waitFor(`nearSeq > ${seqRough} && __trace.length > 0`, "a good reading there: it looked again", 10000);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 30000);

  // the map showing COUNTS at a step (tipped over anyway): nobody can be
  // told from counts — the search ends there, saying nothing (never "nobody
  // nearby yet" over count bubbles that show people)
  await dora.eval(`(window.__wa = worldSync.wantedAggSize, window.__wg = worldSync.wantedGeoSize, worldSync.wantedAggSize = () => 3, worldSync.wantedGeoSize = () => 0, true)`);
  const seqCount = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await tapLocate(dora);
  await dora.waitFor(`nearSeq > ${seqCount} && __trace.length > 0 && !nearLooking && !map.isMoving()`, "the search ended", 15000);
  const cnt = await dora.eval(`({ nobody: nobodyNear, watch: foundWatch, n: __trace.length, banner: document.getElementById("banner").textContent })`);
  await dora.eval(`(worldSync.wantedAggSize = window.__wa, worldSync.wantedGeoSize = window.__wg, true)`);
  check(!cnt.nobody && cnt.watch === null && cnt.n === 1 && !cnt.banner.includes("nobody"), "counts on the map: ended at that step — no 'nobody nearby yet', nothing watched", cnt);

  // a ROUGH reading after a good one (indoors), then ◎: the search looks
  // from the last GOOD reading — never from kilometres off
  const good = await dora.eval(`({ lat: state.me.lat, lng: state.me.lng })`);
  await dora.locate({ ...north(4500), accuracy: 3000 });
  await dora.waitFor(`Math.abs(meMarker.getLngLat().lat - ${north(4500).latitude}) < 1e-7`, "the rough reading arrived (the dot moved)", 15000);
  check(await dora.eval(`Math.abs(state.me.lat - ${good.lat}) < 1e-9`), "(where she is: still her last good reading)");
  const seqG = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await tapLocate(dora);
  await dora.waitFor(`nearSeq > ${seqG} && !nearLooking && !map.isMoving()`, "her search over", 30000);
  const fromG = await dora.eval(`({ at: nearAt, c: map.getCenter() })`);
  check(Math.abs(fromG.at.lat - good.lat) < 1e-9 && Math.abs(fromG.at.lng - good.lng) < 1e-9, "◎ after a rough reading: searched from her last good reading", { fromG, good });

  // looking for NOBODY (offline): ◎ just centres — where her blue dot is
  // (the latest reading, rough or not): the map always shows the dot
  await dora.click("btn-online");
  await dora.waitFor(`!state.online && !nearLooking`, "Dora offline", 10000);
  await dora.waitFor(`!map.isMoving()`, "still", 10000);
  // (her latest reading a rough one, 9 km off — given to the app's locator
  // as its latest: offline no GPS runs, and the browser would hand a ◎ tap
  // its cached last fix for a minute)
  const rough2 = north(9000);
  await dora.eval(`(() => { const r = { lat: ${rough2.latitude}, lng: ${rough2.longitude}, accuracy: 3000 }; window.__bestDesc = Object.getOwnPropertyDescriptor(loc, "best"); Object.defineProperty(loc, "best", { configurable: true, get: () => r }); return true; })()`);
  const seqO = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await tapLocate(dora);
  await dora.waitFor(`!map.isMoving() && Math.abs(map.getCenter().lat - ${rough2.latitude}) < 1e-6`, "◎, looking for nobody: the map on her latest reading (where her dot goes)", 10000);
  check((await dora.eval(`__trace.length`)) === 0, "(no search: looking for nobody)", { trace: await dora.eval(`__trace.slice()`), seq: await dora.eval(`nearSeq`), was: seqO });
  // (the locator's own latest reading back)
  await dora.eval(`(Object.defineProperty(loc, "best", window.__bestDesc), true)`);
  check(await dora.eval(`Object.getOwnPropertyDescriptor(loc, "best") === undefined || typeof Object.getOwnPropertyDescriptor(loc, "best").get === "function"`), "(restored)");
  // (back on duty for what follows — with a good fix again: going online
  // rightly refuses a rough one)
  await dora.locate(north(1500));
  await dora.click("btn-online");
  await dora.waitFor(`state.online && !nearLooking && !map.isMoving()`, "Dora online again", 30000);

  step("a good reading 3 km off arriving while Dora's search is still looking (its first reading was off): it starts again, from where she really is");
  // (her search kept looking: its camera slowed — each step's move 6 s)
  const sg = await dora.eval(`(__trace.length = 0, window.__slowSteps = 6000, nearSeq)`);
  await tapLocate(dora);
  await dora.waitFor(`nearLooking && __trace.length >= 1`, "her search looking", 5000);
  const real = north(550 + 3000);
  await dora.locate(real);
  await dora.waitFor(`nearSeq > ${sg} + 1 && Math.abs(nearAt.lat - ${real.latitude}) < 1e-7`, "a good reading 3 km off: the search again, from there", 15000);
  await dora.eval(`(window.__slowSteps = 0, true)`);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 60000);
  check(Math.abs((await dora.eval(`map.getCenter().lat`)) - real.latitude) < 1e-6, "the map on where she really is");
  const st = await dora.eval(`__trace.slice()`);
  check(st.filter((z) => Math.abs(z - 14) < 1e-6).length >= 2, "(a search she started: the restart begins again at the usual view, 14)", st);

  // a good reading 600 m on arriving while the app is in the BACKGROUND:
  // one search, from there, done by the time she's back
  const bg = north(550 + 3000 + 600);
  const seqBg = await dora.eval(`(__trace.length = 0, nearSeq)`);
  await dora.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => true }), Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }), document.dispatchEvent(new Event("visibilitychange")), true)`);
  await dora.locate(bg);
  await dora.waitFor(`Math.abs(state.me.lat - ${bg.latitude}) < 1e-7`, "the reading in, in the background", 15000);
  await dora.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => false }), Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }), document.dispatchEvent(new Event("visibilitychange")), true)`);
  await dora.waitFor(`nearSeq > ${seqBg} && !nearLooking && !map.isMoving()`, "back: that search done", 15000);
  check(Math.abs((await dora.eval(`nearAt.lat`)) - bg.latitude) < 1e-7, "a reading 600 m on in the background: searched from there", await dora.eval(`nearAt`));
  await dora.close();

  step("in Chicago, with only ROUGH location readings (indoors — never a good one): a search found Max; Max goes; it looks again from where it looked — never from the app's starting placeholder (New York)");
  const CHI = { latitude: 41.8818, longitude: -87.6231 };
  const max = await browser.person("BT-Max", { latitude: CHI.latitude + 0.002, longitude: CHI.longitude });
  await max.phone(390, 844);
  await goOnline(max, { color: "Black", make: "Ford", model: "Focus" });
  const lia = await browser.person("BT-Lia", CHI);
  await lia.phone(390, 844);
  await lia.open();
  await lia.click("btn-hand");
  await lia.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "Lia's ✋ up", 30000);
  // her app opened again, its only reading a rough one
  await lia.locate({ ...CHI, accuracy: 3000 });
  await lia.open();
  await oracle(lia);
  await lia.waitFor(`state.handRaised && !state.haveFix && !nearLooking && !map.isMoving() && nearAt && Math.abs(nearAt.lat - ${CHI.latitude}) < 0.01`, "Lia's search, from her rough reading in Chicago", 30000);
  const placeholder = await lia.eval(`state.me`);
  check(Math.abs(placeholder.lat - CHI.latitude) > 0.5, "(the app's own idea of where she is: still its starting placeholder)", placeholder);
  check(await lia.eval(`foundWatch !== null`), "(it found Max)");
  const seqL = await lia.eval(`(__trace.length = 0, nearSeq)`);
  await max.click("btn-online");
  await max.waitFor(`!state.online`, "Max offline");
  await lia.waitFor(`nearSeq > ${seqL}`, "Max gone: Lia's app looked again", 15000);
  await lia.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 30000);
  const after = await lia.eval(`({ at: nearAt, centre: map.getCenter() })`);
  check(Math.abs(after.at.lat - CHI.latitude) < 0.01 && Math.abs(after.centre.lat - CHI.latitude) < 0.05, "it looked from Chicago — the map still there, not New York", after);

  await lia.close();
  await max.close();
});
