// What covers the map, part 4 (owner, 2026-11-09 — "if you can see it on
// the map, it counts"; "test it to death"): real accounts, through the real
// server. A real car is shown at its block's spot, not where the driver is —
// so instead of moving the car to the pixel, the RIDER stands where that
// spot lands under (or beside) what covers the map at the usual view.
//
//   * a real car under the locate button: found only further out, exactly
//     where the test's own rule says; beside it: found at once;
//   * three cars on one block: one group marker, wider than a single car —
//     the group a few pixels from the locate button's side, where a single
//     car would be clear, is hidden (its real width counts);
//   * the group's list open (it covers the bottom of the map): a group and a
//     car under it found only where the rule says; the list stays open;
//   * "nobody nearby yet", then a real driver coming online in the clear:
//     cleared by the once-a-second look alone.
// Helpers and the rule: cover.mjs.
// The others: findnearestcover/2/3/3b/4/5/6.mjs, findnearestpause.mjs,
// findnearestnobody.mjs, findnearestovertime/backoff/driving/
// settle/faults/away/dot.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline } from "./app.mjs";
import { oracle, box, mapSize, stopsWhereExpected, drawnWherePredicted, inside, leftOf, onlyTheSecondLook, allLooksBack, clearsWithin, search, looksFrom } from "./cover.mjs";

const RIDER_ZOOM = 14;
const merc = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const unmerc = (m) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * m))) * 180) / Math.PI;

// where to stand so that `spot` lands at screen point `t` at the usual view
// (or at `zoom`; screen `size`): the test's own Mercator maths
function standFor(spot, t, size, zoom = RIDER_ZOOM) {
  const k = 512 * 2 ** zoom;
  return {
    latitude: unmerc(merc(spot.lat) - (t.y - size.h / 2) / k),
    longitude: spot.lng - ((t.x - size.w / 2) * 360) / k,
  };
}

// a car's spot as Kim's map shows it (its group marker's place)
const spotOf = (p, id) => p.eval(`(() => { for (const pm of pileMarkers.values()) if (pm.ids.includes(${id})) { const a = pm.marker.getLngLat(); return { lat: a.lat, lng: a.lng, n: pm.ids.length }; } return null; })()`);

// Kim stands at `at`, the map on her at the usual view, everything answered.
// (A rider's ✋ doesn't keep the GPS on — only a shift or a ride does — so
// her page opens afresh there: her ✋ stays up across it, the page reads
// where she is.)
async function standAt(kim, at) {
  await kim.locate(at);
  await kim.open();
  await kim.waitFor(`worldChannel && worldChannel.state === "joined" && state.handRaised && !!state.me`, "Kim's page, ✋ still up", 15000);
  await kim.waitFor(`Math.abs(state.me.lat - ${at.latitude}) < 1e-7 && Math.abs(state.me.lng - ${at.longitude}) < 1e-7`, "Kim where she stands", 15000);
  await kim.waitFor(`!nearLooking && !map.isMoving()`, "the search on opening over", 30000);
  await oracle(kim);
  await kim.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: INTENT_ZOOM }), true)`);
  await kim.waitFor(`!map.isMoving() && worldSync.settled() && serverRole === "viewer"`, "Kim's map answered", 15000);
}

// the car(s) `ids` drawn on Kim's map
const drawn = (kim, ids) => kim.waitFor(`[${ids}].every((id) => [...pileMarkers.values()].some((pm) => pm.ids.includes(id)))`, `#${ids} drawn on Kim's map`, 15000);

const BLOCK = { latitude: HOME.latitude + 0.004, longitude: HOME.longitude + 0.003 };

await journey("findnearestcover4: real cars under and beside a cover, a group's real width, the group's list, 'nobody' cleared by a real driver", async (browser) => {
  step("Dora online a few blocks off; Kim (rider) with ✋ up");
  const dora = await browser.person("BT-Dora", BLOCK);
  await dora.phone(390, 844);
  await goOnline(dora);
  const doraId = await dora.id();
  const kim = await browser.person("BT-Kim");
  await kim.phone(390, 844);
  await kim.open();
  await kim.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Kim's map loaded");
  await oracle(kim);
  await kim.click("btn-hand");
  await kim.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "Kim's ✋ up, the first search over", 30000);
  await drawn(kim, [doraId]);
  const spot = await spotOf(kim, doraId);
  check(spot && spot.n === 1, "(Dora's car on its own)", spot);
  // where her car should show, worked out here: the middle of her block (the
  // map's display block, res 9) — not the app's own value
  const block = await kim.eval(`(() => { const [lat, lng] = h3.cellToLatLng(h3.latLngToCell(${BLOCK.latitude}, ${BLOCK.longitude}, 9)); return { lat, lng }; })()`);
  check(Math.abs(block.lat - spot.lat) < 1e-9 && Math.abs(block.lng - spot.lng) < 1e-9, "Dora's car shown at the middle of her block", { block, spot });
  // a single car's reach, measured
  const hd = await kim.eval(`__o.drawnBox(__o.target(${doraId}).el).half`);
  check(hd.l === hd.r && hd.t === hd.b && hd.r > 10, "(a single car: the same each way)", hd);
  const size = await mapSize(kim);
  const loc = await box(kim, "#btn-locate");

  step("a finger on Dora's car (its marker, where it's drawn): her card opens");
  const mk = await kim.eval(`(() => { const t = __o.target(${doraId}); const b = t.el.getBoundingClientRect(); const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2; const top = document.elementFromPoint(x, y); return { x, y, ok: !!top && t.el.contains(top) }; })()`);
  check(mk.ok, "(Dora's marker is what a finger there touches)", mk);
  await kim.tapAt(mk.x, mk.y);
  await kim.waitFor(`!document.getElementById("peer-card").classList.contains("hidden") && state.cardPeer && state.cardPeer.id === ${doraId}`, "Dora's card open");
  await kim.eval(`(closeMapOverlays(), true)`);

  step("Kim stands so Dora's car is under her locate button: found only further out, where the rule says");
  await standAt(kim, standFor(spot, inside(loc), size));
  await drawn(kim, [doraId]);
  await drawnWherePredicted(kim, doraId);
  await stopsWhereExpected(kim, doraId, "a real car under the locate button", { mustBe: "further" });

  step("…and so it's just beside it: found at once");
  await standAt(kim, standFor(spot, leftOf(loc, hd.r, 3), size));
  await drawn(kim, [doraId]);
  await stopsWhereExpected(kim, doraId, "a real car beside the locate button", { mustBe: "usual" });

  step("the connection drops at the search's first step and comes back 2 s later: it carries on — the same stop, no 'nobody'");
  await standAt(kim, standFor(spot, inside(loc), size));
  await drawn(kim, [doraId]);
  const before = await kim.eval(`__o.stop([${doraId}])`);
  check(before.stop !== null && before.stop < 14, "(Dora's car under the locate button)", before);
  await kim.eval(`(window.__dropped = null, window.__onStep = (n) => { if (n === 1) { socket.disconnect(); window.__dropped = !socket.isConnected(); setTimeout(() => socket.connect(), 2000); } }, true)`);
  await stopsWhereExpected(kim, doraId, "a reconnect mid-search", { expect: before, bannerMayChange: true });
  await kim.eval(`(window.__onStep = null, true)`);
  check(await kim.eval(`window.__dropped === true`), "(the connection really dropped at the first step)", await kim.eval(`window.__dropped`));
  check(await kim.eval(`socket.isConnected()`), "(connected again)");

  step("Dora's car is known but not yet DRAWN (the drawing held back, as on a slow phone): the search waits for it to be drawn — then finds her at once, not further out");
  // (Dora offline while Kim takes her place, then online again: Kim's app
  // learns of her at once; her marker is drawn on the next screen frame —
  // held here until let go)
  await dora.click("btn-online");
  await dora.waitFor("!state.online", "Dora offline");
  await kim.waitFor(`!realEntries.has(${doraId})`, "Dora gone from Kim's map", 15000);
  await standAt(kim, standFor(spot, { x: Math.round(size.w / 2) + 40, y: Math.round(size.h / 2) - 120 }, size));
  // (a draw already on its way would ask for no frame — and teach nothing:
  // waited out first)
  await kim.eval(`(async () => {
    for (let k = 0; k < 100 && renderMarkersSoon.pending(); k++) await new Promise((r) => setTimeout(r, 20));
    const raf = window.requestAnimationFrame.bind(window);
    window.__held = [];
    window.__holdMarkers = true;
    // the frame helper's drawings — the markers' and the count layer's (one
    // helper makes both: the same callback) — learned by asking for one
    // draw and seeing what comes; the map's own frames run as ever
    let sig = null;
    window.requestAnimationFrame = (f) => { sig = String(f); return raf(f); };
    renderMarkersSoon();
    if (!sig) throw new Error("the markers' drawing didn't ask for a frame");
    window.__sig = sig;
    window.requestAnimationFrame = (f) => (window.__holdMarkers && String(f) === sig ? window.__held.push(f) : raf(f));
    window.__rafBack = () => { window.requestAnimationFrame = raf; window.__holdMarkers = false; window.__held.splice(0).forEach((f) => raf(f)); };
    return true;
  })()`);
  await dora.click("btn-online");
  await dora.waitFor("state.online", "Dora online again");
  await kim.waitFor(`realEntries.has(${doraId})`, "Kim's app knows Dora", 15000);
  const heldNow = await kim.eval(`({ held: __held.length, drawn: [...pileMarkers.values()].some((pm) => pm.ids.includes(${doraId})), pending: renderMarkersSoon.pending() })`);
  check(heldNow.held > 0 && !heldNow.drawn && heldNow.pending, "(her marker's drawing held back: not drawn yet)", heldNow);
  const want1 = await kim.eval(`(() => { const s = __o.size(), cs = __o.covers(), zs = __o.steps(); const z = zs.find((z) => __o.clear(__o.point(state.me, ${JSON.stringify({ lat: spot.lat, lng: spot.lng })}, z, s), ${JSON.stringify(hd)}, s, cs)); return { stop: z === undefined ? null : z, steps: zs, found: 1 }; })()`);
  check(want1.stop === want1.steps[0], "(by the test's rule: in plain sight at the usual view, once drawn)", want1);
  const seq0 = await kim.eval(`(__trace.length = 0, nearSeq)`);
  await kim.click("btn-locate");
  await kim.waitFor(`nearSeq > ${seq0}`, "the search started");
  await new Promise((res) => setTimeout(res, 1500));
  const waiting = await kim.eval(`({ looking: nearLooking, trace: __trace.slice(), nobody: nobodyNear })`);
  check(waiting.looking && waiting.trace.length === 1 && !waiting.nobody, "not drawn yet: the search waits at the usual view", waiting);
  await kim.eval(`(__rafBack(), true)`);
  await kim.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 15000);
  const late = await kim.eval(`({ z: map.getZoom(), trace: __trace.slice(), nobody: nobodyNear })`);
  check(late.z === want1.steps[0] && late.trace.length === 1 && !late.nobody, "drawn: found at once, at the usual view", late);

  step("Eve and Finn online on Dora's block: one group marker, wider than a car — a few pixels from the locate button's side it's hidden, though one car there would be clear");
  const eve = await browser.person("BT-Eve", BLOCK);
  await eve.phone(390, 844);
  await goOnline(eve, { color: "Red", make: "Honda", model: "Fit" });
  const finn = await browser.person("BT-Finn", BLOCK);
  await finn.phone(390, 844);
  await goOnline(finn, { color: "White", make: "Kia", model: "Rio" });
  const [eveId, finnId] = [await eve.id(), await finn.id()];
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 3 && [${doraId}, ${eveId}, ${finnId}].every((id) => pm.ids.includes(id)))`, "the three in one group on Kim's map", 15000);
  const group = await spotOf(kim, doraId);
  const gap = 30; // the group's middle 30 px from the button: a single car (22) would clear it
  await standAt(kim, standFor(group, leftOf(loc, gap, 0), size));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 3)`, "the group drawn", 15000);
  const gh = await kim.eval(`__o.drawnBox(__o.target(${doraId}).el).half`);
  check(gh.r > gap && hd.r < gap, "(the group reaches further than a single car would, on the button's side)", { gh, hd });
  check((await kim.eval(`(() => { const w = __o.stop([${doraId}, ${eveId}, ${finnId}], "#btn-locate"); return w.stop === w.steps[0]; })()`)), "(without the locate button: in sight at once — the button alone hides it)");
  check((await kim.eval(`__o.coveredBy(${doraId}, "#btn-locate")`)).ok, "(on the screen, the locate button is on top of it)", await kim.eval(`__o.coveredBy(${doraId}, "#btn-locate")`));
  await stopsWhereExpected(kim, [doraId, eveId, finnId], "the group a few pixels from the locate button", { mustBe: "further" });

  step("the group's list open (it covers the bottom of the map): the group under it found only where the rule says; the list stays open");
  const key = await kim.eval(`[...pileMarkers.entries()].find(([, pm]) => pm.ids.length === 3)[0]`);
  await kim.eval(`(openPileSheet(${JSON.stringify(key)}), true)`);
  await kim.waitFor(`!document.getElementById("pile-sheet").classList.contains("hidden")`, "the group's list open");
  const sheet = await box(kim, "#pile-sheet");
  // (standing elsewhere opens the page afresh: the list opened again there)
  await standAt(kim, standFor(group, { x: Math.round(size.w / 2), y: Math.round(sheet.top + 40) }, size));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 3)`, "the group drawn", 15000);
  const key2 = await kim.eval(`[...pileMarkers.entries()].find(([, pm]) => pm.ids.length === 3)[0]`);
  await kim.eval(`(openPileSheet(${JSON.stringify("KEY")}), true)`.replace('"KEY"', JSON.stringify(key2)));
  await kim.waitFor(`!document.getElementById("pile-sheet").classList.contains("hidden")`, "the group's list open again");
  const sheet2 = await box(kim, "#pile-sheet");
  check(Math.abs(sheet2.top - sheet.top) < 2, "(the list the same height)", { sheet, sheet2 });
  const r = await stopsWhereExpected(kim, [doraId, eveId, finnId], "the group under its own list");
  check(r.want.stop !== 14, "(under the list: not seen at the usual view)", r.want);
  check(await kim.eval(`!document.getElementById("pile-sheet").classList.contains("hidden")`), "the list stays open");
  await kim.eval(`(closePileSheet(), true)`);

  step("Gus on the block too: four cars, a group with its '+N' badge (top right) — the badge alone over the locate button hides it; its badge-free side can come right up to the screen's edge");
  const gus = await browser.person("BT-Gus", BLOCK);
  await gus.phone(390, 844);
  await goOnline(gus, { color: "Silver", make: "Subaru", model: "Impreza" });
  const gusId = await gus.id();
  const four = [doraId, eveId, finnId, gusId];
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 4)`, "the four in one group on Kim's map", 15000);
  await standAt(kim, standFor(group, { x: 120, y: 420 }, size));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 4 && !!pm.el.querySelector(".pile-more"))`, "the group of four drawn, with its badge", 15000);
  const g4 = await kim.eval(`__o.drawnBox(__o.target(${doraId}).el).half`);
  check(g4.r > g4.l + 4 && g4.t > g4.b + 4, "(the badge pokes out top right only)", g4);
  // the body 2 px clear of the button's left side, the badge over it
  await standAt(kim, standFor(group, { x: Math.round(loc.left - g4.l - 2), y: Math.round(loc.top + g4.t - 4) }, size));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 4)`, "the group drawn", 15000);
  const badgeOver = await kim.eval(`(() => { const t = __o.target(${doraId}); const b = t.el.querySelector(".pile-more").getBoundingClientRect(); const r = __o.rel(b); const l = ${JSON.stringify(loc)}; const body = __o.rel(t.el.getBoundingClientRect()); return { badge: r.right > l.left && r.left < l.right && r.bottom > l.top && r.top < l.bottom, body: body.right > l.left && body.left < l.right && body.bottom > l.top && body.top < l.bottom }; })()`);
  check(badgeOver.badge && !badgeOver.body, "(only the badge over the locate button)", badgeOver);
  check((await kim.eval(`(() => { const w = __o.stop(${JSON.stringify(four)}, "#btn-locate"); return w.stop === w.steps[0]; })()`)), "(without the locate button: in sight at once — the button alone hides it)");
  check((await kim.eval(`__o.coveredBy(${doraId}, "#btn-locate")`)).ok, "(on the screen, the locate button is on top of it)", await kim.eval(`__o.coveredBy(${doraId}, "#btn-locate")`));
  await stopsWhereExpected(kim, four, "the badge alone over the locate button", { mustBe: "further" });
  // the badge-free left side 2 px in from the screen's edge: in plain sight
  await standAt(kim, standFor(group, { x: Math.round(g4.l + 2), y: 420 }, size));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 4)`, "the group drawn", 15000);
  await stopsWhereExpected(kim, four, "the group's badge-free side near the screen's edge", { mustBe: "usual" });

  step("a desktop (1280×700): the group's list open; the group under it is found only where the rule says");
  await kim.phone(1280, 700);
  await standAt(kim, standFor(group, { x: 640, y: 350 }, { w: 1280, h: 700 }));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 4)`, "the group drawn", 15000);
  const dkey = await kim.eval(`[...pileMarkers.entries()].find(([, pm]) => pm.ids.length === 4)[0]`);
  await kim.eval(`(openPileSheet(${JSON.stringify(dkey)}), true)`);
  await kim.waitFor(`!document.getElementById("pile-sheet").classList.contains("hidden")`, "the group's list open");
  const dsheet = await box(kim, "#pile-sheet");
  const dsize = await mapSize(kim);
  const dspot = await kim.eval(`__o.onlyUnder("#pile-sheet", __o.drawnBox(__o.target(${doraId}).el).half)`);
  check(!!dspot, "(a spot under the list and nothing else)", { dspot, dsheet });
  await standAt(kim, standFor(group, dspot, dsize));
  await kim.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 4)`, "the group drawn", 15000);
  const dkey2 = await kim.eval(`[...pileMarkers.entries()].find(([, pm]) => pm.ids.length === 4)[0]`);
  await kim.eval(`(openPileSheet(${JSON.stringify(dkey2)}), true)`);
  await kim.waitFor(`!document.getElementById("pile-sheet").classList.contains("hidden")`, "the group's list open again");
  const dr = await stopsWhereExpected(kim, four, "the group under its list, on a desktop");
  check(dr.want.stop !== 14, "(under the list: not seen at the usual view)", dr.want);
  await kim.eval(`(closePileSheet(), true)`);
  await kim.phone(390, 844);
  await standAt(kim, standFor(group, { x: 120, y: 420 }, size));

  step("everyone offline: 'nobody nearby yet'; then Hal comes online in the clear — the once-a-second look alone clears it");
  for (const d of [dora, eve, finn, gus]) {
    await d.click("btn-online");
    await d.waitFor("!state.online", `${d.name} offline`);
  }
  await kim.waitFor(`![${doraId}, ${eveId}, ${finnId}, ${gusId}].some((id) => realEntries.has(id))`, "the four gone from Kim's map", 15000);
  const got = await search(kim);
  check(got.nobody, "'nobody nearby yet'", got);
  await onlyTheSecondLook(kim);
  const me = await kim.eval(`state.me`);
  const hal = await browser.person("BT-Hal", { latitude: me.lat + 0.0015, longitude: me.lng });
  await hal.phone(390, 844);
  await goOnline(hal, { color: "Gray", make: "Mazda", model: "3" });
  const halId = await hal.id();
  await drawn(kim, [halId]);
  await looksFrom(kim);
  check(await kim.eval(`__o.seenNow(${halId})`), "(Hal's car in sight on Kim's map, by the test's rule)");
  await clearsWithin(kim, 1300, "Hal's car in the clear");
  await allLooksBack(kim);
  for (const p of [hal, kim, dora, eve, finn, gus]) await p.close();
});
