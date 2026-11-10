// What covers the map, part 3 (owner, 2026-11-09 — "test it to death"):
// phones — small, sharp (3× pixels), sideways, an iPhone-style notch and
// home bar (a car under the status bar not seen), page zoom 150%, far
// north (Tromsø), right by the 180° line (Fiji: a car across it — in sight,
// watched, and "nobody nearby yet" cleared by it) — and a phone held
// sideways with its notch on one side only.
// On each: the marker where the maths says; under the locate button doesn't
// count, beside it does; a pixel into the banner doesn't, a pixel clear
// does; under a 3-line banner doesn't (each screen says whether it has room
// for that case — never skipped quietly). Helpers and the rule: cover.mjs.
// Part 3b: findnearestcover3b.mjs (laptops, desktops, big monitors).
import { journey, step, check } from "./cdp.mjs";
import {
  demo, freeze, riderLooking, box, mapSize, at, half, drawnWherePredicted, inside, leftOf, rightOf, above, below, stopsWhereExpected,
  longBanner, place, search, onlyTheSecondLook, allLooksBack, sleep, nobodyAround, looksFrom, clearsWithin,
} from "./cover.mjs";

// room3: room for a whole marker between a 3-line banner and the screen's
// middle (checked, not assumed — the short screen at the end has none)
const SCREENS = [
  { name: "a small phone (320×568)", w: 320, h: 568, scale: 2, room3: true },
  { name: "a sharp phone (390×844 at 3×)", w: 390, h: 844, scale: 3, room3: true },
  { name: "sideways (844×390)", w: 844, h: 390, scale: 3, room3: true }, // wide: the long banner stays at two lines
  { name: "an iPhone notch and home bar (47 px, 34 px)", w: 390, h: 844, scale: 3, notch: { top: 47, bottom: 34 }, room3: true },
  // page zoom 150% (iPhone's aA, Android's zoom): the page's width shrinks
  // to 2/3 — a 390×844 phone becomes 260×563 at 4.5×; every button and
  // banner 1.5× the size against the map (the app's text is in px: a
  // bigger root font alone changes nothing)
  { name: "page zoom 150% (390×844 → 260×563)", w: 260, h: 563, scale: 4.5, room3: true },
  { name: "far north (Tromsø, 69.6°N)", w: 390, h: 844, scale: 2, at: { latitude: 69.6492, longitude: 18.9553 }, room3: true },
  { name: "right by the 180° line (Fiji)", w: 390, h: 844, scale: 2, at: { latitude: -16.78, longitude: 179.9995 }, room3: true, across: true },
];

await journey("findnearestcover3: phones — small, sharp, sideways, a notch, page zoom, far north, the 180° line", async (browser) => {
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
      // a car under the phone's status bar (the strip above the page's own
      // things, drawn under the notch): not seen
      await place(p, { x: Math.round(s.w / 2) + 60, y: Math.round(s.notch.top / 2) + 24 });
      const ins = await p.eval(`safeInsets()`);
      check(Math.abs(ins.top - s.notch.top) < 0.5 && Math.abs(ins.bottom - s.notch.bottom) < 0.5, "(the app reads the phone's edges)", ins);
      const edgeOnly = await p.eval(`__o.stop(["car"], "phone-edge")`);
      const withEdge = await p.eval(`__o.stop(["car"])`);
      check(withEdge.stop !== withEdge.steps[0] && edgeOnly.stop === edgeOnly.steps[0], "(by the test's rule: hidden by the status bar strip alone)", { withEdge, edgeOnly });
      await stopsWhereExpected(p, "car", "a car under the phone's status bar", { mustBe: "further" });
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

  step("a phone held sideways (844×390), its notch on the LEFT only and its home bar along the bottom: a car under the notch, and one at the far right of the home bar — not seen; the app reads each side");
  const sw = await demo(browser, "BT-Sideways-notch", { w: 844, h: 390, scale: 3, notch: { left: 47, right: 0, top: 0, bottom: 21 } });
  await freeze(sw);
  await riderLooking(sw);
  const si = await sw.eval(`safeInsets()`);
  check(Math.abs(si.left - 47) < 0.5 && si.right === 0 && si.top === 0 && Math.abs(si.bottom - 21) < 0.5, "(the app reads each side: left 47, right 0, bottom 21)", si);
  // under the left notch (clear of the account button above, the bar below)
  await place(sw, { x: 30, y: 200 });
  const left = await sw.eval(`({ all: __o.stop(["car"]), without: __o.stop(["car"], "phone-edge") })`);
  check(left.all.stop !== left.all.steps[0] && left.without.stop === left.without.steps[0], "(by the test's rule: hidden by the notch strip alone)", left);
  await stopsWhereExpected(sw, "car", "a car under the left notch", { mustBe: "further" });
  // three-quarters across the home bar strip — past where a strip only as
  // wide as the screen is TALL would end (390) — the map's credits folded
  // first with a tap (open, they lie along the bottom right too)
  const ibw = await sw.eval(`(() => { const el = document.querySelector(".maplibregl-ctrl-attrib-button"); const b = el.getBoundingClientRect(); return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }; })()`);
  await sw.tapAt(ibw.x, ibw.y);
  await sw.waitFor(`!document.querySelector(".maplibregl-ctrl-attrib").classList.contains("maplibregl-compact-show")`, "the credits folded");
  // (its whole marker on the screen — 22 px each way — its bottom 20 px into
  // the 21 px home bar)
  await place(sw, { x: 633, y: 390 - 23 });
  const right = await sw.eval(`({ all: __o.stop(["car"]), without: __o.stop(["car"], "phone-edge") })`);
  check(right.all.stop !== right.all.steps[0] && right.without.stop === right.without.steps[0], "(by the test's rule: hidden by the home bar strip alone)", right);
  await stopsWhereExpected(sw, "car", "a car at the far right of the home bar", { mustBe: "further" });
  await sw.close();

  step("the phone turned the other way (844×390): its notch on the RIGHT — a car under it, not seen; the app reads that side");
  const sr = await demo(browser, "BT-Sideways-right", { w: 844, h: 390, scale: 3, notch: { left: 0, right: 47, top: 0, bottom: 21 } });
  await freeze(sr);
  await riderLooking(sr);
  const sri = await sr.eval(`safeInsets()`);
  check(Math.abs(sri.right - 47) < 0.5 && sri.left === 0, "(the app reads the right side: 47)", sri);
  await place(sr, { x: 844 - 30, y: 200 });
  const onRight = await sr.eval(`({ all: __o.stop(["car"]), without: __o.stop(["car"], "phone-edge") })`);
  check(onRight.all.stop !== onRight.all.steps[0] && onRight.without.stop === onRight.without.steps[0], "(by the test's rule: hidden by the right notch strip alone)", onRight);
  await stopsWhereExpected(sr, "car", "a car under the right notch", { mustBe: "further" });
  await sr.close();
});
