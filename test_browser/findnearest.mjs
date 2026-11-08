// Find the nearest (owner, 2026-11-07): Go online, ✋ Need a ride, or the
// locate button while either is on — the map centres on you and zooms out
// just far enough to show the nearest person you're looking for (a rider:
// cars; a driver: ✋), never closer than the usual zoom (14) and never wider
// than people still show one by one. Nobody: it stays that wide and the
// banner adds "nobody nearby yet" — until someone shows up on screen (the
// map doesn't move). Any move of your own ends it.
// The rules themselves (zooms, nearest, edges): test_js/nearby.test.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, bannerIs } from "./app.mjs";

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
  p.eval(`HoodNearby.widestMarkerZoom({ viewport: HoodViewport, h3, center: state.me, size: mapSize(), rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS, maxZoom: INTENT_ZOOM })`);
const view = (p) =>
  p.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), cars: map.getZoom() > 0 && HoodViewport.planWatch(h3, screenRect(), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS)?.res === H3_RES }; })()`);
// centred on where you are
const onYou = async (p) => {
  const v = await view(p);
  const me = await p.eval(`({ lat: state.me.lat, lng: state.me.lng })`);
  return Math.abs(v.lat - me.lat) < 1e-4 && Math.abs(v.lng - me.lng) < 1e-4;
};
// their marker is on this person's screen
const onScreen = (p, id) =>
  p.eval(`realEntries.has(${id}) && map.getBounds().contains([realEntries.get(${id}).peer.pos.lng, realEntries.get(${id}).peer.pos.lat])`);
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

  step("Dora goes online 2 km north: her map finds Sam's ✋ — zoomed out just enough");
  const dora = await browser.person("BT-Dora", DORA);
  await dora.phone(390, 844);
  const [doraId, samId] = [await dora.id(), await sam.id()];
  await goOnline(dora);
  await settled(dora);
  v = await view(dora);
  check(v.zoom < 14 && v.zoom > (await widest(dora)) + 0.05, "between the usual and the widest", v);
  check(await onYou(dora), "centred on Dora");
  check(await onScreen(dora, samId), "Sam's ✋ on her screen");
  await bannerIs(dora, ONLINE);

  step("…and on Sam's map her car shows up: the line clears, the map doesn't move");
  const before = await view(sam);
  await sam.waitFor(`realEntries.has(${doraId})`, "Dora's car on Sam's map", 15000);
  check(await onScreen(sam, doraId), "on his screen");
  await bannerIs(sam, RIDER);
  check(JSON.stringify(await view(sam)) === JSON.stringify(before), "the map stayed put", await view(sam));

  step("Sam's locate button: back on him, zoomed to show Dora's car");
  await drag(sam);
  await locate(sam);
  v = await view(sam);
  check(v.zoom < 14 && v.zoom > samWide + 0.05, "zoomed to fit her", v);
  check(await onYou(sam), "centred on Sam");
  check(await onScreen(sam, doraId), "Dora's car on screen");
  await bannerIs(sam, RIDER);

  // longer than the search waits (3 s): it decides "nobody" with what it
  // has, then the late answer brings the view a fast one would have
  step("Lu (home) on a very slow connection (5 s) raises ✋: 'nobody' at first, then the late answer zooms in to Dora's car");
  const lu = await browser.person("BT-Lu");
  await lu.phone(390, 844);
  await lu.open();
  await lu.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Lu's map loaded");
  // zoomed right in first: Dora's block is outside what Lu's map watches,
  // so only the wide look (the slow answer) can find her
  await lu.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
  await lu.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "Lu zoomed in, Dora not on his map");
  await slowMap(lu, 5000);
  await lu.click("btn-hand");
  await lu.waitFor("state.handRaised", "Lu's ✋ up");
  await bannerIs(lu, RIDER + NOBODY);
  const luWide = await widest(lu);
  await lu.waitFor(`!map.isMoving() && map.getZoom() < 14 && map.getZoom() > ${luWide + 0.05}`, "Lu's map zoomed in to fit", 15000);
  check(await onYou(lu), "centred on Lu");
  check(await onScreen(lu, doraId), "Dora's car on screen");
  await bannerIs(lu, RIDER);
  const luId = await lu.id();
  await lu.click("btn-hand");
  await lu.waitFor("!state.handRaised", "Lu's ✋ down");

  // waiting for the late answer, Lu moves the map himself: when it comes,
  // it leaves the map where he put it
  step("Lu again, and drags the map while the late answer is on its way: it never pulls the map back");
  const zoomIn = async () => {
    await lu.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
    await lu.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "Lu zoomed in, Dora not on his map", 15000);
  };
  await zoomIn();
  await lu.click("btn-hand");
  await lu.waitFor("state.handRaised", "Lu's ✋ up");
  await bannerIs(lu, RIDER + NOBODY);
  await drag(lu);
  await bannerIs(lu, RIDER);
  let held = await view(lu);
  await new Promise((r) => setTimeout(r, 4000)); // past the late answer (5 s)
  await lu.waitFor(`worldSync.settled()`, "the late answer in", 10000);
  await new Promise((r) => setTimeout(r, 1000)); // time to act on it (it checks every 0.2 s)
  check(JSON.stringify(await view(lu)) === JSON.stringify(held), "the map stayed where Lu put it", { held, now: await view(lu) });
  await lu.click("btn-hand");
  await lu.waitFor("!state.handRaised", "Lu's ✋ down");

  step("Lu again, and puts ✋ down while the late answer is on its way: it does nothing");
  await zoomIn();
  await lu.click("btn-hand");
  await lu.waitFor("state.handRaised", "Lu's ✋ up");
  await bannerIs(lu, RIDER + NOBODY);
  held = await view(lu);
  await lu.click("btn-hand");
  await lu.waitFor("!state.handRaised", "Lu's ✋ down");
  await new Promise((r) => setTimeout(r, 4000));
  await lu.waitFor(`worldSync.settled()`, "the late answer in", 10000);
  await new Promise((r) => setTimeout(r, 1000)); // time to act on it (it checks every 0.2 s)
  check(JSON.stringify(await view(lu)) === JSON.stringify(held), "the map didn't move", { held, now: await view(lu) });
  check((await lu.banner()) === "", "no line (not looking)", await lu.banner());

  await dora.waitFor(`!realEntries.has(${luId})`, "Lu's ✋ gone from Dora's map", 15000);
  await lu.close();

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
  await locate(sam);
  check((await view(sam)).zoom === 14, "Sam's locate: Ed's close — zoom 14", await view(sam));

  step("Sam's ✋ down: Dora's locate finds nobody — wide, 'nobody nearby yet'");
  await sam.click("btn-hand");
  await sam.waitFor("!state.handRaised", "Sam's ✋ down");
  await dora.waitFor(`!realEntries.has(${samId})`, "Sam's ✋ gone from Dora's map", 15000);
  await locate(dora);
  v = await view(dora);
  check(Math.abs(v.zoom - (await widest(dora))) < 1e-6, "the widest zoom", v);
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
  await locate(sam);
  v = await view(sam);
  check(v.zoom >= 15, "zoom 15 or closer", v);
  check(await onYou(sam), "centred on Sam");
  check(await sam.eval("nearSeq > 0 && !nearLooking && !nobodyNear"), "no search");
});

