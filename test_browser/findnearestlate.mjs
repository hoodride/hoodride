// Find the nearest on a slow connection (owner, 2026-11-07; split from
// findnearest.mjs, 2026-11-08 — together they ran past a journey's time):
// the late answer, and stopping looking while it's on its way.
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
const DORA = near(2); // about 1¼ miles north of Lu: further than the usual view

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

const RIDER = "✋ Nearby drivers can see you need a ride";
const NOBODY = " · nobody nearby yet";

await journey("findnearestlate: the late answer on a slow connection", async (browser) => {
  step("Dora goes online 2 km north");
  const dora = await browser.person("BT-Dora", DORA);
  await dora.phone(390, 844);
  const doraId = await dora.id();
  await goOnline(dora);
  await settled(dora);

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
    await lu.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "Lu zoomed in, Dora not on his map", 30000);
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
});
