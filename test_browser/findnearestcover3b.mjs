// What covers the map, part 3b (owner, 2026-11-09 — "test it to death";
// split from part 3): a laptop, a desktop (the chat a panel in the middle:
// beside it counts, under it doesn't), a big monitor (2560×1440 at 100%:
// the usual view shows counts — the search starts closer in), a screen that
// shows counts at every zoom (no search; the map still comes to you), and a
// screen so short nothing can be seen ("nobody nearby yet", and it stays).
// On each: the marker where the maths says; under the locate button doesn't
// count, beside it does; a pixel into the banner doesn't, a pixel clear
// does; under a 3-line banner doesn't (each screen says whether it has room
// for that case — never skipped quietly). Helpers and the rule: cover.mjs.
// Part 3: findnearestcover3.mjs (phones).
import { journey, step, check } from "./cdp.mjs";
import {
  demo, freeze, riderLooking, box, mapSize, at, half, drawnWherePredicted, inside, leftOf, rightOf, above, below, stopsWhereExpected,
  longBanner, place, search, onlyTheSecondLook, staysNobody, allLooksBack, tapLocate, sleep, nobodyAround, looksFrom, clearsWithin,
} from "./cover.mjs";

// room3: room for a whole marker between a 3-line banner and the screen's
// middle (checked, not assumed — the short screen at the end has none)
const SCREENS = [
  { name: "a laptop (1366×768)", w: 1366, h: 768, scale: 1, room3: true, desk: true },
  { name: "a desktop (1280×700)", w: 1280, h: 700, scale: 1, room3: true, desk: true },
  // so big the usual view shows counts, not cars one by one (the block
  // limit): the search starts closer in, where they do show
  { name: "a big monitor (2560×1440 at 100%)", w: 2560, h: 1440, scale: 1, room3: true, desk: true, big: true },
];

await journey("findnearestcover3b: laptops, desktops, a big monitor, a counts-only screen, a screen too short", async (browser) => {
  for (const s of SCREENS) {
    // hidden at the usual view: found further out — or, on a screen so big
    // the search has just the one step (wider shows counts), never seen
    const HIDDEN = s.big ? "nobody" : "further";
    step(`${s.name}: the marker where the maths says; the locate button, the banner (and a 3-line one) — beside and clear count, under doesn't${s.desk ? "; the chat panel: beside counts, under doesn't" : ""}`);
    const p = await demo(browser, `BT-${s.w}x${s.h}`, s);
    await freeze(p);
    await riderLooking(p);
    const size = await mapSize(p);
    check(Math.abs(size.w - s.w) < 1 && Math.abs(size.h - s.h) < 1, "(the map fills the screen)", size);
    if (s.notch) {
      const b = await box(p, "#banner");
      check(b.top >= s.notch.top, "(the banner pushed below the notch)", b);
      const l = await box(p, "#btn-locate");
      check(size.h - l.bottom >= s.notch.bottom, "(the locate button pushed above the home bar)", l);
    }
    if (s.big) {
      const zs = await p.eval(`__o.steps()`);
      check(zs[0] > 14, "(the usual view shows counts here: the search starts closer in)", zs);
      check(await p.eval(`!HoodNearby.showsMarkers(HoodViewport, h3, HoodNearby.screenAt(state.me, 14, __o.size()), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS)`), "(at the usual view: counts, by the map's own rule)");
    }
    await place(p, { x: Math.round(size.w / 3), y: Math.round(size.h / 2) + 30 });
    await drawnWherePredicted(p);
    const hc = await half(p);
    if (s.across) {
      // a car a little east — on the far side of the line (its longitude
      // the other sign): drawn beside you, found at once
      await place(p, { x: Math.round(size.w / 2) + 80, y: Math.round(size.h / 2) + 40 });
      const lng = await p.eval(`(() => { let l = drivers[0].pos.lng; while (l > 180) l -= 360; return l; })()`);
      check(lng < 0, "(the car across the 180° line)", lng);
      await p.eval(`(drivers[0].pos = { lat: drivers[0].pos.lat, lng: ${lng} }, drivers[0].marker.setLngLat([${lng}, drivers[0].pos.lat]), refreshWorldMarkers(), true)`);
      await drawnWherePredicted(p);
      await stopsWhereExpected(p, "car", "a car across the 180° line", { mustBe: "usual" });
      // "nobody nearby yet" there: a car coming into sight across the line
      // clears it (its own once-a-second look, as the map draws it)
      await nobodyAround(p);
      await onlyTheSecondLook(p);
      await looksFrom(p);
      await p.eval(`(() => { const ll = map.unproject([${Math.round(size.w / 2) + 80}, ${Math.round(size.h / 2) + 40}]); let lng = ll.lng; while (lng > 180) lng -= 360; drivers[0].pos = { lat: ll.lat, lng }; drivers[0].marker.setLngLat([lng, ll.lat]); refreshWorldMarkers(); return true; })()`);
      check((await p.eval(`drivers[0].pos.lng`)) < 0, "(the car across the line)");
      await clearsWithin(p, 1300, "a car across the 180° line, in sight");
      await allLooksBack(p);
      // found across the line: while it stays in sight there, all quiet (the
      // watch sees it where the map draws it — not a world away)…
      const fz = await search(p);
      check(!fz.nobody, "(found across the line)", fz);
      const sq = await p.eval(`(__trace.length = 0, nearSeq)`);
      await sleep(7000);
      check((await p.eval(`nearSeq`)) === sq, "in sight across the line for 7 s: no new search", await p.eval(`({ seq: nearSeq })`));
      // …gone: looked again — after 5 s, on the page's own clock
      await p.eval(`(drivers[0].pos = { lat: state.me.lat + 0.2, lng: state.me.lng }, drivers[0].marker.setLngLat([drivers[0].pos.lng, drivers[0].pos.lat]), refreshWorldMarkers(), window.__goneAt = performance.now(), window.__firstStepAt = null, true)`);
      await p.waitFor(`nearSeq > ${sq} && window.__firstStepAt !== null`, "gone across the line: looked again", 30000);
      const w180 = await p.eval(`window.__firstStepAt - window.__goneAt`);
      check(w180 >= 5000 && w180 <= 7500, "after 5 s (the watch notices within a second, then looks again within the next)", w180);
      await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);
    }

    const loc = await box(p, "#btn-locate");
    await at(p, inside(loc), HIDDEN, "under the locate button", "car", "#btn-locate");
    const besideLoc = loc.left > size.w / 2 ? leftOf(loc, hc.x, 2) : rightOf(loc, hc.x, 2);
    await at(p, besideLoc, "usual", "beside the locate button");

    const ban = await box(p, "#banner");
    const x = Math.round((ban.left + ban.right) / 2);
    await at(p, below(ban, hc.y, -1, x), HIDDEN, "a pixel into the banner", "car", "#banner");
    await at(p, below(ban, hc.y, 1, x), "usual", "a pixel clear of the banner");

    const long = await longBanner(p);
    const b3 = await box(p, "#banner");
    const room = b3.bottom + 2 * hc.y + 2 < size.h / 2;
    check(room === s.room3, `(room for the 3-line banner's cases: ${s.room3 ? "yes" : "no"}, as this screen says)`, { b3, h: size.h });
    if (s.room3) {
      await at(p, { x, y: Math.round(b3.bottom - 6) }, HIDDEN, "under the 3-line banner's last line", "car", "#banner");
      await at(p, below(b3, hc.y, 1, x), "usual", "a pixel clear of the 3-line banner");
    }
    await long.off();

    if (s.desk) {
      await p.eval(`(openChat(drivers[1]), true)`);
      await p.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat open");
      const chat = await box(p, "#chat");
      check(chat.right - chat.left < size.w - 4 * hc.x, "(the chat a panel, with map beside it)", chat);
      await at(p, leftOf(chat, hc.x, 2, Math.round(chat.bottom - hc.y - 30)), "usual", "beside the chat panel");
      await at(p, inside(chat, 0.4), "nobody", "under the chat panel, close by: never seen");
      await p.eval(`(closeChat(), true)`);
    }
    await p.close();
  }

  step("a screen that shows counts even fully zoomed in (no real one is that big — the map's ladder made to say so): the locate button still brings the map to you, closer in; no search, nothing said");
  const cz = await demo(browser, "BT-CountsOnly", { w: 390, h: 844, scale: 2 });
  await freeze(cz);
  await riderLooking(cz);
  await cz.eval(`(() => { const pw = HoodViewport.planWatch; HoodViewport.planWatch = (h, rect, rungs, budget) => { const p = pw(h, rect, rungs, budget); return p && { ...p, res: rungs[1] }; }; return true; })()`);
  check(await cz.eval(`!HoodNearby.showsMarkers(HoodViewport, h3, HoodNearby.screenAt(state.me, 18, __o.size()), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS)`), "(counts even at 18, by the map's rule)");
  await cz.eval(`(map.jumpTo({ center: [state.me.lng + 0.02, state.me.lat], zoom: 12 }), true)`);
  await cz.waitFor(`!map.isMoving()`, "moved off");
  const s0 = await cz.eval(`(__trace.length = 0, nearSeq)`);
  await tapLocate(cz);
  await cz.waitFor(`!map.isMoving() && Math.abs(map.getCenter().lng - state.me.lng) < 1e-6`, "the map back on you", 10000);
  await sleep(600);
  const co = await cz.eval(`({ z: map.getZoom(), trace: __trace.slice(), looking: nearLooking, nobody: nobodyNear, seq: nearSeq })`);
  check(Math.abs(co.z - 18) < 1e-6 && co.trace.length === 0 && !co.looking && !co.nobody, "on you, as close as it goes; no search taken, nothing said", co);
  // a LOOK-AGAIN (not a tap) on such a screen: never closer in than the map
  // is (owner, 2026-11-10: only a tap gives a close-up)
  await cz.eval(`(map.jumpTo({ center: [state.me.lng + 0.02, state.me.lat], zoom: 12 }), true)`);
  await cz.waitFor(`!map.isMoving()`, "moved off again");
  await cz.eval(`(findNearest(state.me, { outFrom: map.getZoom() }), true)`);
  await sleep(1500);
  await cz.waitFor(`!map.isMoving()`, "settled");
  const la = await cz.eval(`({ z: map.getZoom() })`);
  check(la.z <= 12 + 1e-6, "a look-again: never zoomed in", la);
  await cz.close();

  step("a look-again from WIDER than the widest step (the map zoomed out past it): nowhere further out — it stays, never zooms in");
  const wd = await demo(browser, "BT-WideOut", { w: 390, h: 844, scale: 2 });
  await freeze(wd);
  await riderLooking(wd);
  await wd.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 8 }), true)`);
  await wd.waitFor(`!map.isMoving()`, "zoomed far out");
  await wd.eval(`(__trace.length = 0, findNearest(state.me, { outFrom: map.getZoom() }), true)`);
  await sleep(1500);
  await wd.waitFor(`!map.isMoving()`, "settled");
  const wz = await wd.eval(`({ z: map.getZoom(), looking: nearLooking, nobody: nobodyNear, steps: __trace.length })`);
  check(wz.z <= 8 + 1e-6, "never zoomed in from wider than the widest", wz);
  // and it ENDED: no search left looking, nothing said, not a step taken
  check(!wz.looking && !wz.nobody && wz.steps === 0, "ended quietly: not looking, nothing said, no step", wz);
  await wd.close();

  step("a screen so short the covers leave no room (390×260, a 3-line banner): nobody can be seen — 'nobody nearby yet', and it stays");
  const p = await demo(browser, "BT-short", { w: 390, h: 260, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  await longBanner(p);
  const { w, h } = await mapSize(p);
  await place(p, { x: Math.round(w / 2), y: Math.round(h / 2) });
  const want = await p.eval(`__o.stop(["car"])`);
  check(want.stop === null, "(by the test's rule: never in sight, not even right where you are)", { want, covers: await p.eval(`__o.covers()`) });
  const got = await search(p);
  check(got.nobody, "'nobody nearby yet'", got);
  await onlyTheSecondLook(p);
  await staysNobody(p, 2500, "the once-a-second look");
  await allLooksBack(p);
  await p.close();
});
