// Find the nearest (owner, 2026-11-07; step by step 2026-11-09): Go online,
// ✋ Need a ride, or the locate button while either is on — the map centres
// on you at the usual zoom (14), then steps out half a level at a time until
// someone you're looking for shows (a rider: cars; a driver: ✋), and stays
// there — no zooming back in. Never wider than people still show one by
// one: nobody there, it stays that wide and the banner adds "nobody nearby
// yet" — until someone comes into sight (the map doesn't move). Any move
// of your own ends it.
// The rules themselves (the steps, the box rule): test_js/nearby.test.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, bannerIs } from "./app.mjs";
import { firstStepShowing } from "./cover.mjs";

// `km` north and east of home
const near = (north, east = 0) => ({
  latitude: HOME.latitude + north / 111.32,
  longitude: HOME.longitude + east / (111.32 * Math.cos((HOME.latitude * Math.PI) / 180)),
});
const DORA = near(2); // about 1¼ miles north of Sam: further than the usual view
const ED = near(0, 0.2); // a block or two from Sam

// the search over, the camera still
const settled = (p) => p.waitFor(`!nearLooking && !map.isMoving()`, `${p.name}: the map settled`);
// the widest zoom that still shows people one by one, around you
const widest = (p) =>
  p.eval(`HoodNearby.widestMarkerZoom({ viewport: HoodViewport, h3, center: state.me, size: { w: mapSize().w + 2 * NEAR_EDGE_PX, h: mapSize().h + 2 * NEAR_EDGE_PX }, rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS, maxZoom: INTENT_ZOOM })`);
const view = (p) =>
  p.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), cars: map.getZoom() > 0 && HoodViewport.planWatch(h3, screenRect(), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS)?.res === H3_RES }; })()`);
// centred on where you are
const onYou = async (p) => {
  const v = await view(p);
  const me = await p.eval(`({ lat: state.me.lat, lng: state.me.lng })`);
  return Math.abs(v.lat - me.lat) < 1e-4 && Math.abs(v.lng - me.lng) < 1e-4;
};
// their marker is on this person's screen (drawn: a pile holding them, inside the view)
const onScreen = (p, id) =>
  p.eval(`(() => { for (const pm of pileMarkers.values()) if (pm.ids.includes(${id})) return map.getBounds().contains(pm.marker.getLngLat()); return false; })()`);
// a gesture of yours: a drag (it carries the pointer's event, as a real one)
const drag = (p) => p.eval(`map.panBy([0, 300], { duration: 0 }, { originalEvent: new MouseEvent("mousedown") }), true`);
// a slow connection: this person's map asks the server who's in view, and
// the question gets there `ms` late — so the answer, and the live news for
// the new area, come that late too (as on a slow phone connection)
const slowMap = (p, ms) =>
  p.eval(`(() => {
    const push = worldChannel.push.bind(worldChannel);
    worldChannel.push = (event, ...rest) => {
      if (event !== "sync") return push(event, ...rest);
      const cbs = [];
      const later = { receive(status, cb) { cbs.push([status, cb]); return later; } };
      setTimeout(() => cbs.reduce((p, [status, cb]) => p.receive(status, cb), push(event, ...rest)), ${ms});
      return later;
    };
    return true;
  })()`);
const locate = async (p) => {
  await p.click("btn-locate");
  await settled(p);
};

const RIDER = "✋ Nearby drivers can see you need a ride";
const ONLINE = "🟢 You're online";
const NOBODY = " · nobody nearby yet";

await journey("findnearest: the map shows you the nearest", async (browser) => {
  step("Sam (rider, home) raises ✋ with nobody around: as wide as cars still show, 'nobody nearby yet'");
  const sam = await browser.person("BT-Sam");
  await sam.phone(390, 844);
  await sam.open();
  await sam.click("btn-hand");
  await sam.waitFor("state.handRaised", "Sam's ✋ up");
  await settled(sam);
  const samWide = await widest(sam);
  let v = await view(sam);
  check(Math.abs(v.zoom - samWide) < 1e-6, "the widest zoom", { v, samWide });
  check(samWide < 13, "well wider than the usual view", samWide);
  check(v.cars, "still cars, not counts");
  check(await onYou(sam), "centred on Sam");
  await bannerIs(sam, RIDER + NOBODY);

  // someone under the banner (or the buttons) at that wide view isn't on
  // screen for the search — nor for "nobody nearby yet": the line cleared
  // while the map stayed wide and they stayed hidden (owner, 2026-11-08)
  step("a car shows up under Sam's banner at that wide view: his line stays 'nobody nearby yet', the map stays put");
  const underBanner = await sam.eval(`(() => { const { w } = mapSize(); const ll = map.unproject([w / 2, 60]); return { latitude: ll.lat, longitude: ll.lng }; })()`);
  const held0 = await view(sam);
  const top = await browser.person("BT-Top", underBanner);
  await top.phone(390, 844);
  await goOnline(top, { color: "Green", make: "Fiat", model: "500" });
  const topId = await top.id();
  await sam.waitFor(`realEntries.has(${topId})`, "Top's car on Sam's map", 15000);
  await sam.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.includes(${topId}))`, "Top's car drawn on Sam's map", 15000);
  const topAt = await sam.eval(`(() => { const pm = [...pileMarkers.values()].find((pm) => pm.ids.includes(${topId})); const c = pm.el.getBoundingClientRect(), b = document.getElementById("banner").getBoundingClientRect(); return { overlap: c.left < b.right && c.right > b.left && c.top < b.bottom && c.bottom > b.top, car: [c.top, c.bottom], banner: [b.top, b.bottom] }; })()`);
  check(topAt.overlap, "(Top's car drawn under the banner)", topAt);
  // two of the once-a-second looks with it drawn there: the line stays
  await new Promise((r) => setTimeout(r, 2200));
  check(await sam.eval(`nobodyNear`), "(still 'nobody nearby yet' after two looks)");
  await bannerIs(sam, RIDER + NOBODY);
  check(JSON.stringify(await view(sam)) === JSON.stringify(held0), "the map stayed put", { held0, now: await view(sam) });

  step("…and one under his buttons at the bottom: still 'nobody nearby yet'");
  const underButtons = await sam.eval(`(() => { const { w, h } = mapSize(); const ll = map.unproject([w / 2, h - 60]); return { latitude: ll.lat, longitude: ll.lng }; })()`);
  const bottom = await browser.person("BT-Bottom", underButtons);
  await bottom.phone(390, 844);
  await goOnline(bottom, { color: "Black", make: "Ford", model: "Ka" });
  const bottomId = await bottom.id();
  await sam.waitFor(`realEntries.has(${bottomId})`, "Bottom's car on Sam's map", 15000);
  await sam.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.includes(${bottomId}))`, "Bottom's car drawn on Sam's map", 15000);
  const bottomAt = await sam.eval(`(() => { const pm = [...pileMarkers.values()].find((pm) => pm.ids.includes(${bottomId})); const c = pm.el.getBoundingClientRect(); const hit = [...document.querySelectorAll("#bottom-controls > *")].filter((e) => !e.closest(".hidden")).map((e) => e.getBoundingClientRect()).some((b) => b.width && c.left < b.right && c.right > b.left && c.top < b.bottom && c.bottom > b.top); return { hit, car: [c.top, c.bottom] }; })()`);
  check(bottomAt.hit, "(Bottom's car drawn under one of the buttons)", bottomAt);
  await new Promise((r) => setTimeout(r, 2200));
  check(await sam.eval(`nobodyNear`), "(still 'nobody nearby yet' after two looks)");
  await bannerIs(sam, RIDER + NOBODY);
  check(JSON.stringify(await view(sam)) === JSON.stringify(held0), "the map stayed put", { held0, now: await view(sam) });
  await bottom.click("btn-online");
  await bottom.waitFor("!state.online", "Bottom offline");
  await sam.waitFor(`!realEntries.has(${bottomId})`, "Bottom's car gone from Sam's map", 15000);
  await bottom.close();

  step("…then Top drives into the clear: Sam's line clears, the map stays put");
  await top.locate(near(0.5));
  await sam.waitFor(`(() => { const e = realEntries.get(${topId}); if (!e) return false; const pt = map.project([e.peer.pos.lng, e.peer.pos.lat]); return pt.y > 130; })()`, "Top's car in the clear on Sam's map", 15000);
  await bannerIs(sam, RIDER);
  check(JSON.stringify(await view(sam)) === JSON.stringify(held0), "the map stayed put", { held0, now: await view(sam) });
  await top.click("btn-online");
  await top.waitFor("!state.online", "Top offline");
  await sam.waitFor(`!realEntries.has(${topId})`, "Top's car gone from Sam's map", 15000);
  await top.close();
  // (nobody around again: Sam's ✋ down and up — a new look, nobody)
  await sam.click("btn-hand");
  await sam.waitFor("!state.handRaised", "Sam's ✋ down");
  await sam.click("btn-hand");
  await sam.waitFor("state.handRaised", "Sam's ✋ up");
  await settled(sam);
  await bannerIs(sam, RIDER + NOBODY);

  step("Dora goes online 2 km north: her map steps out until Sam's ✋ shows, and stays there");
  const dora = await browser.person("BT-Dora", DORA);
  await dora.phone(390, 844);
  const [doraId, samId] = [await dora.id(), await sam.id()];
  await goOnline(dora);
  await settled(dora);
  v = await view(dora);
  const doraStop = await firstStepShowing(dora, samId);
  check(doraStop.ok, "the first step that shows Sam's ✋ — not a step wider, not zoomed back in", doraStop);
  check(await onYou(dora), "centred on Dora");
  check(await onScreen(dora, samId), "Sam's ✋ on her screen");
  await bannerIs(dora, ONLINE);

  step("…and on Sam's map her car shows up: the line clears, the map doesn't move");
  const before = await view(sam);
  await sam.waitFor(`realEntries.has(${doraId})`, "Dora's car on Sam's map", 15000);
  check(await onScreen(sam, doraId), "on his screen");
  await bannerIs(sam, RIDER);
  check(JSON.stringify(await view(sam)) === JSON.stringify(before), "the map stayed put", await view(sam));

  step("Sam's locate button: back on him, stepped out to the first view with Dora's car");
  await drag(sam);
  await locate(sam);
  v = await view(sam);
  const samStop = await firstStepShowing(sam, doraId);
  check(samStop.ok, "the first step that shows her car", samStop);
  check(await onYou(sam), "centred on Sam");
  check(await onScreen(sam, doraId), "Dora's car on screen");
  await bannerIs(sam, RIDER);

  step("Ed goes online a block from Sam: the usual view (never closer), Sam's ✋ on it");
  const ed = await browser.person("BT-Ed", ED);
  await ed.phone(390, 844);
  // his phone's "Reduce motion" is on (the map jumps, no animation) and
  // his connection is slow: the server's answers for the map take 1.5 s.
  // The search must wait for them — deciding at once, it found "nobody"
  // (the test server answers in ~70 ms, and the animation covered for it)
  await ed.reduceMotion(true);
  const car = { color: "Red", make: "Kia", model: "Soul" };
  check(await ed.eval(`fetch("/api/car", {method: "POST", headers: {"content-type": "application/json"}, body: ${JSON.stringify(JSON.stringify(car))}}).then(r => r.ok)`), "Ed's car saved");
  await ed.open();
  await ed.click("btn-mode");
  await ed.waitFor(`state.mode === "driver" && state.myCar !== undefined && worldChannel && worldChannel.state === "joined"`, "Ed: driver mode, car known");
  await slowMap(ed, 1500);
  await ed.click("btn-online");
  await ed.waitFor("state.online", "Ed online");
  await settled(ed);
  v = await view(ed);
  check(v.zoom === 14, "zoom 14", v);

  check(await onScreen(ed, samId), "Sam's ✋ on his screen");
  const edId = await ed.id();
  await sam.waitFor(`realEntries.has(${edId})`, "Ed's car on Sam's map", 15000);
  // (Ed's car already on Sam's map, a block away: straight to the usual
  // view — never out to the widest first and back)
  await sam.eval(`(window.__minZoom = map.getZoom(), window.__startZoom = map.getZoom(), map.on("zoom", () => { window.__minZoom = Math.min(window.__minZoom, map.getZoom()); }), true)`);
  await locate(sam);
  check((await view(sam)).zoom === 14, "Sam's locate: Ed's close — zoom 14", await view(sam));
  const samZooms = await sam.eval(`({ min: window.__minZoom, start: window.__startZoom, widest: ${await widest(sam)} })`);
  check(samZooms.start > samZooms.widest + 0.05 && samZooms.min >= Math.min(samZooms.start, 14) - 1e-6, "never out to the widest on the way", samZooms);

  step("Sam's ✋ down: Dora's locate finds nobody — wide, 'nobody nearby yet'");
  await sam.click("btn-hand");
  await sam.waitFor("!state.handRaised", "Sam's ✋ down");
  await dora.waitFor(`!realEntries.has(${samId})`, "Sam's ✋ gone from Dora's map", 15000);
  // (a short message is up meanwhile: "nobody nearby yet" waits for it)
  // (60 s, not 8: it must outlast a whole real search out to the widest
  // view — each step waits for the server, longer on a loaded machine; the
  // search itself is no slower — a timing flake, removed 2026-11-09)
  await dora.eval(`transientBanner("a short message", 60000), true`);
  await locate(dora);
  v = await view(dora);
  check(Math.abs(v.zoom - (await widest(dora))) < 1e-6, "the widest zoom", v);
  check((await dora.banner()) === "a short message", "the short message stays up", await dora.banner());
  await dora.eval(`(clearTimeout(bannerTimer), bannerTimer = null, setBanner(contextBanner())), true`);
  await bannerIs(dora, ONLINE + NOBODY);

  step("Dora drags the map: the line goes back (the screen isn't 'near you' any more), the map stays where she put it");
  await drag(dora);
  const dragged = await view(dora);
  await bannerIs(dora, ONLINE);
  await new Promise((r) => setTimeout(r, 1500));
  check(JSON.stringify(await view(dora)) === JSON.stringify(dragged), "not moved back", await view(dora));

  step("Dora's locate again: nobody — then Sam's ✋ goes up: her line clears, her map stays put");
  await locate(dora);
  await bannerIs(dora, ONLINE + NOBODY);
  const still = await view(dora);
  await sam.click("btn-hand");
  await sam.waitFor("state.handRaised", "Sam's ✋ up again");
  await dora.waitFor(`realEntries.has(${samId})`, "Sam's ✋ on Dora's map", 15000);
  await bannerIs(dora, ONLINE);
  check(JSON.stringify(await view(dora)) === JSON.stringify(still), "the map stayed put", await view(dora));

  step("not looking (✋ down): Sam's locate button as before — on him, close up");
  await sam.click("btn-hand");
  await sam.waitFor("!state.handRaised", "Sam's ✋ down");
  await drag(sam);
  // (new searches counted as they start — the search number also moves when
  // something merely stops one, as the tap's own map move does)
  await sam.eval(`(() => { window.__fn = 0; window.__fn0 = findNearest; findNearest = (...a) => (window.__fn++, window.__fn0(...a)); return true; })()`);
  await locate(sam);
  v = await view(sam);
  check(v.zoom >= 15, "zoom 15 or closer", v);
  check(await onYou(sam), "centred on Sam");
  check(await sam.eval(`window.__fn === 0 && !nearLooking && !nobodyNear`), "no search (none started by this tap)", await sam.eval("window.__fn"));
  await sam.eval(`(findNearest = window.__fn0, true)`);
});

