// What the search said stays true over time, part 5 (owner, 2026-11-09 —
// "test it to death"): a fault inside a look, or in its first move, ends
// the search cleanly (and is reported); no timers left over after 200
// searches; another device taking over ("Use here") ends a search. Parts
// 1–4: findnearestovertime.mjs, findnearestbackoff.mjs,
// findnearestdriving.mjs, findnearestsettle.mjs. Helpers and the rule:
// cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { demo, freeze, riderLooking, place, farAway, tapLocate, looksNoMore, sleep } from "./cover.mjs";

await journey("findnearestfaults: a fault ends a search cleanly, no timers left, another device", async (browser) => {
  const p = await demo(browser, "BT-Overtime", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  step("something going wrong inside a look: the search ends cleanly — not left 'looking' for ever, nothing left running");
  await farAway(p);
  await p.eval(`(() => { const pom = peopleOnMap; window.__pom = pom; let once = true; peopleOnMap = (t) => { if (once) { once = false; throw new Error("a test's own fault"); } return pom(t); }; return true; })()`);
  const se = await p.eval(`(__trace.length = 0, nearSeq)`);
  await tapLocate(p);
  await p.waitFor(`nearSeq > ${se} && !nearLooking`, "the search ended", 5000);
  await p.eval(`(peopleOnMap = window.__pom, true)`);
  // ended THERE, at its first look — not carried on to an answer
  const fe = await p.eval(`({ n: __trace.length, nobody: nobodyNear, watch: foundWatch, seq: nearSeq })`);
  check(fe.n === 1 && !fe.nobody && fe.watch === null, "the fault ended it at its first look: no more steps, nothing said, nothing watched", fe);
  await looksNoMore(p, 2200, "after the fault in a look");
  check((await p.eval(`nearSeq`)) === fe.seq && (await p.eval(`__trace.length`)) === 1, "(nothing more after)");
  await p.expectError("a test's own fault");
  // …and in its very first move
  await farAway(p);
  await p.eval(`(() => { const ez = map.easeTo; window.__ez = ez; let once = true; map.easeTo = function (o, e) { if (once && e && e.nearSearch != null) { once = false; throw new Error("a test's own fault, first move"); } return ez.call(this, o, e); }; return true; })()`);
  const sf = await p.eval(`nearSeq`);
  await tapLocate(p);
  await p.waitFor(`nearSeq > ${sf} && !nearLooking`, "the search ended at its first move", 5000);
  await p.eval(`(map.easeTo = window.__ez, true)`);
  await looksNoMore(p, 2200, "after the first-move fault");
  await p.expectError("a test's own fault, first move");
  await looksNoMore(p, 2200, "after the fault");
  check(!(await p.eval(`nobodyNear`)) && (await p.eval(`foundWatch === null`)), "nothing said, nothing watched");

  step("200 searches, finds and look-agains: the app's repeating timers don't pile up (the search's one-off polls ending: looksNoMore, above)");
  await p.eval(`(() => {
    window.__live = new Set();
    const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
    window.setInterval = (f, ms, ...a) => { const id = si(f, ms, ...a); window.__live.add(id); return id; };
    window.clearInterval = (id) => { window.__live.delete(id); return ci(id); };
    return true;
  })()`);
  await place(p, { x: 195, y: 330 });
  const base = await p.eval(`__live.size`);
  for (let k = 0; k < 200; k++) {
    // a search that finds (the watch's timer started) — a "nobody" line
    // (its timer) — another search that finds… each replacing the last
    await p.eval(`(findNearest(state.me), true)`);
    await p.waitFor(`!nearLooking`, "found", 5000);
    if (k % 3 === 0) await p.eval(`(setNobodyNear(true), true)`);
  }
  await p.eval(`(stopFindNearest(), true)`);
  const left = await p.eval(`__live.size`);
  check(left <= base, "no timer left over (the watch's and the line's, all stopped)", { base, left });

  step("another device takes over ('Use here') mid-search: the search here ends — nothing looks on behind the cover");
  await farAway(p);
  await p.eval(`(openSettings(), __trace.length = 0, findNearest(state.me), true)`);
  await sleep(400);
  check(await p.eval(`nearLooking`), "(waiting behind Settings)");
  await p.eval(`(closeSettings(), onSessionMoved(), true)`);
  await p.waitFor(`!nearLooking && !!document.getElementById("session-moved")`, "the cover up, the search over", 3000);
  await looksNoMore(p, 2200, "Use here");
  await p.close();
});
