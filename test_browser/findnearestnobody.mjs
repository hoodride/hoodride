// "Nobody nearby yet" (owner, 2026-11-09 — "test it to death"; split from
// findnearestcover.mjs): looked at again once a second — that look alone
// clears it when someone comes into sight; a half-covered car doesn't; never
// while the map is out of sight (each drawer and form, Settings sliding
// away); the chat closing or the banner shrinking shows a car; a message
// arriving meanwhile; markers far off never measured; and the locate button
// from far out. Helpers and the rule: cover.mjs.
import { journey, step, check } from "./cdp.mjs";
import { typing,
  demo, freeze, riderLooking, box, place, at, half, inside, below, above, longBanner, moveTo, nobodyAround, onlyTheSecondLook, allLooksBack, staysNobody, clearsWithin, sleep, HUGE, looksFrom, search,
} from "./cover.mjs";

await journey("findnearestnobody: 'nobody nearby yet' — looked at again, never behind a drawer, and what clears it", async (browser) => {
  step("'nobody nearby yet', then the once-a-second look ALONE clears it when a car comes into sight");
  const n = await demo(browser, "BT-CoverNobody", { w: 390, h: 844, scale: 2 });
  await freeze(n);
  await riderLooking(n);
  const hn = await half(n);
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  // (the map's redraws stopped looking; only the 1 s interval can)
  await looksFrom(n);
  await moveTo(n, { x: 195, y: 420 });
  await clearsWithin(n, 1300, "a car in the clear");

  step("a half-covered car doesn't clear it; a pixel clear does");
  await allLooksBack(n);
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  const nb = await box(n, "#banner");
  await moveTo(n, below(nb, hn.y, -1, 195));
  await staysNobody(n, 2500, "a car a pixel under the banner");
  await looksFrom(n);
  await moveTo(n, below(nb, hn.y, 1, 195));
  await clearsWithin(n, 1300, "a pixel clear of the banner");

  step("never cleared while the map is out of sight — Settings, the car form, the navigation choice, the language list, 'Use here'");
  const SHEETS = [
    ["Settings", `openSettings()`, `closeSettings()`],
    ["the car form", `openCarSheet()`, `closeCarSheet()`],
    ["the navigation choice", `openNavSheet()`, `closeNavSheet()`],
    ["the language list", `openLangSheet()`, `closeLangSheet()`],
    ["'Use here'", `showSessionMoved()`, `document.getElementById("session-moved").remove()`],
  ];
  for (const [name, open, close] of SHEETS) {
    await allLooksBack(n);
    await nobodyAround(n);
    await onlyTheSecondLook(n);
    await n.eval(`(${open}, true)`);
    check(await n.eval(`mapOutOfSight()`), `(${name} open: the map out of sight)`);
    await moveTo(n, { x: 195, y: 420 });
    await staysNobody(n, 2500, `${name} open, a car in the clear behind it`);
    await looksFrom(n);
    await n.eval(`(${close}, true)`);
    await clearsWithin(n, 1300, `${name} closed`);
  }

  step("Settings sliding away over a car: 'nobody nearby yet' clears only once the car is out from under it");
  await allLooksBack(n);
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  await n.eval(`(openSettings(), true)`);
  // (measured once it has slid all the way in)
  await n.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().left) < 0.5`, "Settings all the way open");
  const drawer = await n.eval(`__o.rel(document.getElementById("settings-sheet").getBoundingClientRect())`);
  check(drawer.right > 2 * hn.x + 20, "(the drawer measured open)", drawer);
  // the car under the drawer's middle, as the drawer slides left
  const underDrawer = { x: Math.round(drawer.right - hn.x - 6), y: 420 };
  await moveTo(n, underDrawer);
  await staysNobody(n, 2500, "Settings open over the car");
  // the moment the line clears: where's the drawer?
  // (closed, and looked at again AT ONCE — as a marker redraw would, not
  // only on the next once-a-second look — so the 0.2 s slide can't be
  // missed by luck)
  await n.eval(`(window.__seqFrom = nearSeq, window.__lastInSight = null, closeSettings(), window.__nearbyArrived(), setTimeout(() => window.__nearbyArrived(), 60), setTimeout(() => window.__nearbyArrived(), 120), true)`);
  // (looked at three times on purpose, at once: no bound on the count here —
  // what's checked is where the drawer was when it cleared)
  await clearsWithin(n, 2500, "Settings gone", Infinity);
  const at0 = await n.eval(`__lastInSight`);
  check(at0 && at0.right <= underDrawer.x - hn.x + 0.5, "the drawer no longer over the car when the line cleared", { at0, car: underDrawer, half: hn });

  step("the chat closing shows a car under it: cleared");
  await allLooksBack(n);
  await nobodyAround(n);
  await n.eval(`(openChat(drivers[1]), true)`);
  await n.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat open");
  await onlyTheSecondLook(n);
  await moveTo(n, inside(await box(n, "#chat"), 0.5));
  await staysNobody(n, 2500, "a car under the chat");
  await looksFrom(n);
  await n.eval(`(closeChat(), true)`);
  await clearsWithin(n, 1300, "the chat closed");

  step("the banner shrinking back shows a car under it: cleared");
  await allLooksBack(n);
  await nobodyAround(n);
  const ln = await longBanner(n, HUGE);
  await onlyTheSecondLook(n);
  const n3 = await box(n, "#banner");
  const n1 = { ...nb };
  check(n3.bottom - n1.bottom > 2 * hn.y + 4, "(room between the two banners for a whole marker)", { n1, n3 });
  await moveTo(n, below(n1, hn.y, 2, 195));
  await staysNobody(n, 2500, "a car under the 3-line banner");
  await looksFrom(n);
  await ln.off();
  await clearsWithin(n, 1300, "the banner back to one line");
  await allLooksBack(n);

  step("the on-screen keyboard over the bottom of the map (a phone that doesn't shrink the page for it): a car behind it doesn't clear 'nobody nearby yet'; one above it does");
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  await n.eval(`(() => { window.__vv = window.visualViewport; Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetTop: 0, offsetLeft: 0, height: 480, width: innerWidth, scale: 1 } }); return true; })()`);
  await typing(n, true);
  await moveTo(n, { x: 195, y: 620 });
  check(!(await n.eval(`__o.seenNow("car")`)), "(by the test's rule: behind the keyboard)");
  await staysNobody(n, 2500, "a car behind the keyboard");
  await looksFrom(n);
  await moveTo(n, { x: 195, y: 330 });
  await clearsWithin(n, 1300, "a car above the keyboard");
  await typing(n, false);
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: window.__vv }), true)`);
  await allLooksBack(n);
  // iOS 26 after the keyboard closes: still reports a keyboard-sized area
  // (nothing being typed in) — not a cover: a car there is in sight
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetTop: 24, offsetLeft: 0, height: 480, width: innerWidth, scale: 1 } }), true)`);
  // (the premise, by the test's rule: typing, that area would hide the car;
  // not typing, it doesn't)
  await typing(n, true);
  await moveTo(n, { x: 195, y: 620 });
  check(!(await n.eval(`__o.seenNow("car")`)), "(typing: the car behind the keyboard's area)");
  await typing(n, false);
  check(await n.eval(`__o.seenNow("car")`), "(nothing typed in: the car in sight)");
  await looksFrom(n);
  await clearsWithin(n, 1300, "a car where a closed keyboard is still reported (nothing typed in)");
  // the chat closed: its text box no longer focused (the keyboard goes with
  // it) — and a text box in something closed never counts as typing, even
  // if a browser leaves the focus there
  await n.eval(`(document.getElementById("chat").classList.remove("hidden"), document.getElementById("chat-input").focus(), true)`);
  check(await n.eval(`document.activeElement === document.getElementById("chat-input")`), "(the chat's text box focused)");
  const blurs = await n.eval(`(() => { const ci = document.getElementById("chat-input"); let k = 0; const ob = ci.blur; ci.blur = () => (k++, ob.call(ci)); closeChat(); ci.blur = ob; return k; })()`);
  check(blurs === 1, "the chat closed: the app takes the focus off its text box (Safari would keep it)", blurs);
  check(await n.eval(`document.activeElement !== document.getElementById("chat-input")`), "(…and it's off)");
  // (the real once-a-second look back first: a new line's timer takes the
  // look as it is when the line goes up)
  await allLooksBack(n);
  await nobodyAround(n);
  await n.eval(`(() => { const ci = document.getElementById("chat-input"); Object.defineProperty(document, "activeElement", { configurable: true, get: () => ci }); return true; })()`);
  await looksFrom(n);
  await moveTo(n, { x: 195, y: 620 });
  check(await n.eval(`__o.seenNow("car")`), "(by the test's rule too: in sight)");
  await clearsWithin(n, 1300, "focus left in the closed chat's text box: not typing — the car in sight");
  await typing(n, false);
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: window.__vv }), true)`);
  await allLooksBack(n);
  // the visible area moved down and in from the left (a page pinched on a
  // desktop trackpad): a car above it, or left of it — behind; inside — seen
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetTop: 200, offsetLeft: 120, height: 600, width: innerWidth - 120, scale: 1.5 } }), true)`);
  for (const [x, y, what] of [[195, 150, "above it"], [60, 500, "left of it"]]) {
    await moveTo(n, { x, y });
    check(!(await n.eval(`__o.seenNow("car")`)), `(by the test's rule: ${what})`);
    await staysNobody(n, 2500, `a car ${what}`);
  }
  await looksFrom(n);
  await moveTo(n, { x: 250, y: 500 });
  await clearsWithin(n, 1300, "a car inside the visible area");
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: window.__vv }), true)`);
  await allLooksBack(n);
  // …pinched so its RIGHT side is off the visible area: a car there, behind
  await nobodyAround(n);
  await onlyTheSecondLook(n);
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetTop: 0, offsetLeft: 0, height: innerHeight, width: innerWidth - 150, scale: 1.5 } }), true)`);
  await moveTo(n, { x: Math.round((await n.eval(`innerWidth`)) - 60), y: 450 });
  check(!(await n.eval(`__o.seenNow("car")`)), "(by the test's rule: right of the visible area)");
  await staysNobody(n, 2500, "a car right of the visible area");
  await n.eval(`(Object.defineProperty(window, "visualViewport", { configurable: true, value: window.__vv }), true)`);
  await allLooksBack(n);

  step("a chat message arriving while 'nobody nearby yet' shows: the message shows, then the line comes back");
  await nobodyAround(n);
  await n.eval(`(receiveMsg(drivers[1], "hello from the test"), true)`);
  await n.waitFor(`document.getElementById("banner").textContent.includes("hello from the test")`, "the message in the banner", 3000);
  check(await n.eval(`nobodyNear`), "(still nobody nearby meanwhile)");
  await n.waitFor(`document.getElementById("banner").textContent.includes("nobody nearby yet")`, "the line back once the message has gone", 15000);

  step("markers far off the screen are never measured: only one whose middle is on the screen is");
  await nobodyAround(n);
  await n.eval(`(() => { window.__mr = markerReach; window.__measured = 0; markerReach = (el) => (window.__measured++, window.__mr(el)); return true; })()`);
  await n.eval(`(window.__nearbyArrived || nearbyArrived)()`);
  const far = await n.eval(`({ measured: __measured, people: peopleOnMap("driver").length, nobody: nobodyNear })`);
  check(far.people > 0 && far.measured === 0 && far.nobody, "everyone far off: none measured", far);
  // (the map's redraw on moving it looks too: off for this, so the look
  // counted is the only one)
  await onlyTheSecondLook(n);
  // (moved and looked at in one go: nothing else looks in between)
  await n.eval(`(() => { const ll = map.unproject([195, 420]); drivers[0].pos = { lat: ll.lat, lng: ll.lng }; drivers[0].marker.setLngLat([ll.lng, ll.lat]); __measured = 0; window.__nearbyArrived(); return true; })()`);
  const near = await n.eval(`({ measured: __measured, nobody: nobodyNear })`);
  check(near.measured === 1 && !near.nobody, "the one on the screen: measured (once), and seen", near);
  await allLooksBack(n);
  await n.eval(`(markerReach = window.__mr, true)`);

  step("tapping the locate button while zoomed far out (11): the search starts at the usual view, and finds the car there");
  await place(n, { x: 195, y: 330 });
  await n.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 11 }), true)`);
  await n.waitFor(`!map.isMoving() && map.getZoom() === 11`, "zoomed out to 11");
  const out = await search(n);
  check(out.trace[0] === 14 && out.trace.length === 1 && out.z === 14 && !out.nobody && (await n.eval(`foundWatch !== null`)), "in to the usual view, the car found there (watched: found)", out);

  // the banner's size after "nobody nearby yet" goes: exactly the short
  // message's own, laid out afresh — Safari kept the longer text's balanced
  // wrapping (1 line → 3 → 2 on the owner's iPhone, 2026-11-10). Chrome never
  // showed it; this keeps the property, and no leftover style
  step("'nobody nearby yet' gone: the banner back to the short message's own size, nothing left over");
  // (measured after the banner's two frames: its balancing back on)
  const size = () => n.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => { const r = document.getElementById("banner").getBoundingClientRect(); ok({ w: Math.round(r.width), h: Math.round(r.height) }); }))))`);
  await n.eval(`(state.handRaised = true, setBanner(contextBanner()), true)`);
  const fresh = await size();
  await n.eval(`(setNobodyNear(true), true)`);
  const long = await size();
  await n.eval(`(setNobodyNear(false), true)`);
  const back = await size();
  check(long.h > fresh.h || long.w > fresh.w, "(the long message is bigger)", { fresh, long });
  check(back.w === fresh.w && back.h === fresh.h, "back to the short message's own size", { fresh, long, back });
  check((await n.eval(`document.getElementById("banner").style.textWrap`)) === "", "no leftover style on the banner");
  await n.eval(`(state.handRaised = false, setBanner(contextBanner()), true)`);

  await sleep(100);
  await n.close();
});
