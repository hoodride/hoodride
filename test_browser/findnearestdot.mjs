// Find the nearest: odds and ends that each broke "what you see is what
// counts" (owner, 2026-11-09/10 — "test it to death"):
//   * your blue dot is drawn UNDER everyone (real accounts): your first
//     location comes after a car is already drawn there — the car stays on
//     top, in plain sight;
//   * a driver's shift resumed with no location yet, the map moved by hand:
//     her first location starts no search, the map stays put;
//   * the raised ✋ button's yellow ring covers the map too: a car 2 px off
//     the button (under its 3 px ring) is hidden; 4 px off, in sight;
//   * the on-screen keyboard while typing: a car behind it found only
//     further out, a found car going behind it gone for the watch — and,
//     nothing typed in, a keyboard area still reported (iOS 26) isn't one;
//   * a found car gone while the wall clock jumps an hour: looked again at
//     once;
//   * "nobody nearby yet" and moved 600 m: looked again from where you are,
//     at the zoom the map is at — never zooming in by itself;
//   * "nobody nearby yet" said while looking for cars never shows in a
//     driver's banner (a reconnect can make a rider an online driver).
// Helpers and the rule: cover.mjs. The others: findnearestcover*.mjs,
// findnearestpause/nobody/overtime/backoff/driving/settle/faults/away.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees } from "./app.mjs";
import { oracle, demo, freeze, riderLooking, box, half, place, above, at, search, moveTo, stopsWhereExpected, nobodyAround, typing } from "./cover.mjs";

const BLOCK = { latitude: HOME.latitude + 0.004, longitude: HOME.longitude + 0.003 };

await journey("findnearestdot: your blue dot under the cars, the ✋ button's ring, 'nobody' after a role change", async (browser) => {
  step("real accounts: Kim opens the app with no location yet, Dora's car on her map; THEN Kim raises ✋ and her first location lands right on that car — her dot goes under it: the car in plain sight");
  const dora = await browser.person("BT-Dora", BLOCK);
  await dora.phone(390, 844);
  await goOnline(dora);
  const doraId = await dora.id();
  const kim = await browser.person("BT-Kim");
  await kim.phone(390, 844);
  await kim.noSignal();
  await kim.open();
  await kim.waitFor(`worldChannel && worldChannel.state === "joined" && !state.haveFix`, "Kim's map, no location yet", 15000);
  await kim.eval(`(map.jumpTo({ center: [${BLOCK.longitude}, ${BLOCK.latitude}], zoom: INTENT_ZOOM }), true)`);
  await sees(kim, doraId);
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.includes(${doraId}))`, "Dora's car drawn on Kim's map", 15000);
  // the car's element, kept: the very one must still be on top afterwards
  // (redrawn, it would be on top whatever the order — and prove nothing)
  const spot = await kim.eval(`(() => { for (const pm of pileMarkers.values()) if (pm.ids.includes(${doraId})) { window.__carEl = pm.el; const a = pm.marker.getLngLat(); return { lat: a.lat, lng: a.lng }; } })()`);
  check(await kim.eval(`!meMarker.getElement().isConnected`), "(no blue dot yet: no location)");
  await kim.locate({ latitude: spot.lat, longitude: spot.lng });
  await kim.click("btn-hand");
  await kim.waitFor(`state.haveFix && meMarker.getElement().isConnected && state.handRaised`, "Kim's first location: her dot drawn", 15000);
  await kim.waitFor(`!nearLooking && !map.isMoving()`, "her search over", 30000);
  const r = await kim.eval(`(() => {
    const car = window.__carEl, dot = meMarker.getElement();
    const same = [...pileMarkers.values()].some((pm) => pm.el === car && pm.ids.includes(${doraId}));
    const c = car.getBoundingClientRect(), d = dot.getBoundingClientRect();
    const top = document.elementFromPoint((c.left + c.right) / 2, (c.top + c.bottom) / 2);
    const overlap = d.left < c.right && d.right > c.left && d.top < c.bottom && d.bottom > c.top;
    return { same, overlap, onTop: !!top && car.contains(top), top: top && (top.className || top.tagName), order: !!(dot.compareDocumentPosition(car) & Node.DOCUMENT_POSITION_FOLLOWING) };
  })()`);
  check(r.same && r.overlap, "(the same car, drawn before the dot, and the dot right on it)", r);
  check(r.onTop && r.order, "the car is on top of Kim's blue dot — in plain sight", r);
  await oracle(kim);
  const found = await kim.eval(`({ nobody: nobodyNear, seen: __o.seenNow(${doraId}), hit: __o.hitCheck([${doraId}]) })`);
  check(!found.nobody && found.seen && found.hit.ok, "Kim's search found Dora's car — and nothing over it (the browser's own hit test; the dot is no excuse)", found);
  await kim.close();

  step("Dora's app opened afresh with no location yet (her shift resumes); she moves the map herself; THEN her first location comes: no search, the map stays where she put it");
  await dora.noSignal();
  await dora.open();
  await dora.waitFor(`state.online && worldChannel && worldChannel.state === "joined" && !state.haveFix && !map.isMoving()`, "Dora's shift resumed, no location yet", 15000);
  await oracle(dora);
  await dora.drag(200, 500, 120, 380);
  await dora.waitFor(`!map.isMoving() && movedByYou`, "Dora moved the map herself");
  const view = await dora.eval(`(__trace.length = 0, window.__seq0 = nearSeq, { c: map.getCenter(), z: map.getZoom() })`);
  await dora.locate(BLOCK);
  await dora.waitFor(`state.haveFix`, "Dora's first location", 15000);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await dora.eval(`({ n: __trace.length, seq: nearSeq, seq0: window.__seq0, looking: nearLooking, c: map.getCenter(), z: map.getZoom() })`);
  check(after.n === 0 && after.seq === after.seq0 && !after.looking, "moved by her first: no search on her first location", after);
  check(Math.abs(after.c.lat - view.c.lat) < 1e-9 && Math.abs(after.c.lng - view.c.lng) < 1e-9 && Math.abs(after.z - view.z) < 1e-9, "the map where she put it", { view, after });
  await dora.close();

  step("the demo, a rider with ✋ up: the button's yellow ring covers the map — a car 2 px above the button (under the 3 px ring): hidden, found further out; 4 px above: in sight");
  const p = await demo(browser, "BT-Ring", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  check(await p.eval(`document.getElementById("btn-hand").classList.contains("on") && getComputedStyle(document.getElementById("btn-hand")).boxShadow.includes("0px 0px 0px 3px")`), "(the ✋ button raised: its 3 px ring showing)");
  const hand = await box(p, "#btn-hand");
  const h = await half(p);
  await place(p, above(hand, h.b, 2));
  await stopsWhereExpected(p, "car", "a car 2 px above the raised ✋ button (under its ring)", { mustBe: "further" });
  await place(p, above(hand, h.b, 4));
  await stopsWhereExpected(p, "car", "a car 4 px above the raised ✋ button (clear of its ring)", { mustBe: "usual" });

  step("the account button focused (its 3 px outline, 2 px out): it covers 5 px past its box in the app's own reckoning — and only while it shows");
  // (no car can be placed by it: the banner lies right under it — so the
  // app's own list of covers is read: the button's box, grown by its ring)
  const grown = (on) => p.eval(`(() => { const el = document.getElementById("btn-account"); ${on ? `el.focus({ focusVisible: true })` : `el.blur()`}; const cs = getComputedStyle(el); const b = el.getBoundingClientRect(), m = document.getElementById("map").getBoundingClientRect(); const box = { top: b.top - m.top, bottom: b.bottom - m.top, left: b.left - m.left, right: b.right - m.left }; const c = nearCovers().find((c) => Math.abs((c.top + c.bottom) / 2 - (box.top + box.bottom) / 2) < 0.5 && Math.abs((c.left + c.right) / 2 - (box.left + box.right) / 2) < 0.5); return { outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineOffset, grow: c ? [box.left - c.left, c.right - box.right, box.top - c.top, c.bottom - box.bottom] : null }; })()`);
  const fo = await grown(true);
  check(fo.outline === "solid 3px 2px", "(the focus ring showing: 3 px, 2 px out)", fo);
  check(fo.grow && fo.grow.every((g) => Math.abs(g - 5) < 0.01), "focused: the account button covers 5 px past its box on every side", fo);
  const bl = await grown(false);
  check(bl.grow && bl.grow.every((g) => Math.abs(g) < 0.01), "not focused: just its box", bl);

  step("a car whose marker isn't laid out (no size — nothing of it on the screen): never counts as in sight");
  await place(p, { x: 195, y: 330 });
  await p.eval(`(drivers[0].marker.getElement().style.display = "none", true)`);
  check(await p.eval(`drivers[0].marker.getElement().getBoundingClientRect().width === 0`), "(the marker has no size)");
  const ns = await search(p);
  await p.eval(`(drivers[0].marker.getElement().style.display = "", true)`);
  check(ns.nobody, "a marker with no size: not found — 'nobody nearby yet'", ns);

  step("a person's card with a very long name (40 letters, no spaces): cut with '…' — nothing of any cover sticks out past its box (a part outside it would be over the map, unseen by the rule)");
  check((await p.eval(`__o.overflows()`)).length === 0, "(nothing sticks out to begin with)", await p.eval(`__o.overflows()`));
  await p.eval(`(openPeerCard(drivers[0]), true)`);
  await p.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "the card open", 3000);
  await p.eval(`(document.getElementById("peer-name").textContent = "W".repeat(40), true)`);
  const name = await p.eval(`(() => { const n = document.getElementById("peer-name"); return { full: n.scrollWidth, shown: n.clientWidth }; })()`);
  check(name.full > name.shown, "(the name longer than the card can show)", name);
  const over = await p.eval(`__o.overflows()`);
  check(over.length === 0, "the long name cut inside the card — nothing past any cover's box", over);
  await p.eval(`(document.getElementById("peer-card").classList.add("hidden"), true)`);

  step("the on-screen keyboard over the bottom of the map (a phone that doesn't shrink the page for it): a car behind it is found only further out; a found car going behind it is gone for the watch");
  await p.eval(`(() => { window.__vv = window.visualViewport; Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetTop: 0, offsetLeft: 0, height: 480, width: innerWidth, scale: 1 } }); return true; })()`);
  await typing(p, true);
  await at(p, { x: 195, y: 467 }, "further", "a car just behind the keyboard", "car", "keyboard");
  await place(p, { x: 195, y: 330 });
  const k = await search(p);
  check(!k.nobody && (await p.eval(`foundWatch !== null`)), "(a car above the keyboard: found at once, watched)", k);
  await p.waitFor(`foundWatch.seenAt !== null && foundWatch.goneAt === null`, "(seen by the watch)", 3000);
  await moveTo(p, { x: 195, y: 560 });
  await p.waitFor(`foundWatch.goneAt !== null`, "the car behind the keyboard: gone, for the watch", 3000);
  await moveTo(p, { x: 195, y: 330 });
  await p.waitFor(`foundWatch.goneAt === null`, "back above it: seen again", 3000);
  // the same car behind the keyboard's area — but nothing typed in any more
  // (iOS 26 still reports the area after the keyboard closes): in sight
  await moveTo(p, { x: 195, y: 560 });
  await p.waitFor(`foundWatch.goneAt !== null`, "(behind it again: gone)", 3000);
  await typing(p, false);
  await p.waitFor(`foundWatch.goneAt === null`, "nothing typed in: the reported area isn't a cover — in sight", 3000);
  await moveTo(p, { x: 195, y: 330 });
  await p.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: window.__vv }), true)`);

  step("a found car gone while the wall clock jumps an hour ahead (a laptop asleep, the app on screen): it looks again at once — not after the full wait");
  await p.waitFor(`foundWatch && foundWatch.goneAt === null && !nearLooking`, "(the car found and watched)", 3000);
  const s1 = await p.eval(`(__trace.length = 0, nearSeq)`);
  await moveTo(p, { x: 195, y: -3000 });
  await p.waitFor(`foundWatch && foundWatch.goneAt !== null`, "gone: the count running", 3000);
  check((await p.eval(`foundWatch.wait`)) === 5000 && (await p.eval(`nearSeq`)) === s1, "(the wait 5 s; no look yet)");
  await p.eval(`(foundWatch.goneAt.d -= 3600000, true)`);
  await p.waitFor(`nearSeq > ${s1}`, "the wall clock an hour on: looked again at once", 1500);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 20000);

  step("'nobody nearby yet' (the map at its widest), then a good reading 600 m on: it looks again from there — at the zoom the map is at, never zooming in; one answer, nothing left running");
  await nobodyAround(p);
  const zw = await p.eval(`map.getZoom()`);
  check(zw < 14, "(the map at its widest)", zw);
  const s2 = await p.eval(`(__trace.length = 0, nearSeq)`);
  const to = await p.eval(`(() => { const to = { lat: state.me.lat + 0.0055, lng: state.me.lng }; state.me = to; meMarker.setLngLat([to.lng, to.lat]); nearbyMoved(to); return to; })()`);
  await p.waitFor(`nearSeq > ${s2} && !nearLooking && !map.isMoving()`, "the search over", 30000);
  const r2 = await p.eval(`({ at: nearAt, nobody: nobodyNear, c: map.getCenter(), seq: nearSeq, trace: __trace.slice() })`);
  const close = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
  check(close(r2.at, to) && close(r2.c, to) && r2.nobody, "looked from where you are now — 'nobody nearby yet' there", r2);
  check(r2.trace.length > 0 && r2.trace.every((z) => z <= zw + 1e-6), "never zooming in: every step as wide as the map was, or wider", { trace: r2.trace, zw });
  await new Promise((r) => setTimeout(r, 2000));
  check((await p.eval(`nearSeq`)) === r2.seq && !(await p.eval(`nearLooking`)), "nothing left running", await p.eval(`nearSeq`));

  step("a look-again under way (stepping out from a wider zoom), then a good reading 600 m on: it starts again from where you are — still outward, never zooming in");
  await place(p, { x: 195, y: -60 });
  const fw2 = await search(p);
  check(!fw2.nobody && fw2.z < 14, "(found further out than the usual view)", fw2);
  // (each step slow: the look-again caught part-way)
  await p.eval(`(window.__slowSteps = 2500, true)`);
  const sl = await p.eval(`nearSeq`);
  await moveTo(p, { x: 195, y: -3000 });
  await p.waitFor(`nearLooking && nearSeq > ${sl} && nearOutward`, "the look-again under way", 15000);
  const mid = await p.eval(`(() => { const z = map.getZoom(); __trace.length = 0; const to = { lat: state.me.lat + 0.0055, lng: state.me.lng }; state.me = to; meMarker.setLngLat([to.lng, to.lat]); nearbyMoved(to); return { z, to }; })()`);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "that search over", 40000);
  await p.eval(`(window.__slowSteps = 0, true)`);
  const tm = await p.eval(`({ trace: __trace.slice(), at: nearAt })`);
  check(Math.abs(tm.at.lat - mid.to.lat) < 1e-9, "(looked from where you are now)", tm);
  check(tm.trace.length > 0 && tm.trace.every((z) => z <= mid.z + 1e-6), "restarted mid-look-again: every step as wide as the map was, or wider — never zooming in", { trace: tm.trace, from: mid.z });

  step("'nobody nearby yet' (about cars), then the app finds you an online driver (a reconnect after switching on another device): the banner never says 'nobody' about ✋ — and the line clears, searching nothing");
  await nobodyAround(p);
  check((await p.eval(`document.getElementById("banner").textContent`)).includes("nobody nearby yet"), "(the rider's banner: 'nobody nearby yet')");
  // (new searches counted as they start — the search number also moves when
  // something merely stops one)
  await p.eval(`(() => { window.__fn = 0; window.__fnOrig = findNearest; findNearest = (...a) => (window.__fn++, window.__fnOrig(...a)); return true; })()`);
  const b = await p.eval(`(() => { state.handRaised = false; state.mode = "driver"; state.online = true; setBanner(contextBanner()); return document.getElementById("banner").textContent; })()`);
  check(!b.includes("nobody"), "an online driver now: no 'nobody nearby yet' about cars in her banner", b);
  await p.waitFor(`!nobodyNear`, "the line cleared (what she looks for changed)", 2500);
  check((await p.eval(`window.__fn`)) === 0, "(…clearing it started no search)", await p.eval(`window.__fn`));
  await p.eval(`(findNearest = window.__fnOrig, true)`);
  await p.close();
});
