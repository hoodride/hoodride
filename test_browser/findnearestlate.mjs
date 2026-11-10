// Find the nearest on a slow connection (owner, 2026-11-07; split from
// findnearest.mjs, 2026-11-08 — together they ran past a journey's time;
// no deadline, 2026-11-09): it waits at each step for the slow answer,
// never says "nobody nearby yet" while it waits, and a swipe or ✋ down
// while it waits ends it — the answer then moves nothing.
// Find the nearest (owner, 2026-11-07; step by step 2026-11-09): Go online,
// ✋ Need a ride, or the locate button while either is on — the map centres
// on you at the usual zoom (14), then steps out half a level at a time,
// waiting at each step for the server's answer however long it takes,
// until someone you're looking for shows (a rider: cars; a driver: ✋), and
// stays there. Nobody at the widest view that still shows people one by
// one: "nobody nearby yet". Any move of your own ends it.
// The rules themselves (the steps, the box rule): test_js/nearby.test.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, bannerIs } from "./app.mjs";
import { firstStepShowing } from "./cover.mjs";

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
  p.eval(`HoodNearby.widestMarkerZoom({ viewport: HoodViewport, h3, center: state.me, size: { w: mapSize().w + 2 * NEAR_EDGE_PX, h: mapSize().h + 2 * NEAR_EDGE_PX }, rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS, maxZoom: INTENT_ZOOM })`);
const view = (p) =>
  p.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), cars: map.getZoom() > 0 && HoodViewport.planWatch(h3, screenRect(), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS)?.res === H3_RES }; })()`);
// centred on where you are
const onYou = async (p) => {
  const v = await view(p);
  const me = await p.eval(`({ lat: state.me.lat, lng: state.me.lng })`);
  return Math.abs(v.lat - me.lat) < 1e-4 && Math.abs(v.lng - me.lng) < 1e-4;
};
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

await journey("findnearestlate: a slow connection — it waits at each step, and a swipe ends it", async (browser) => {
  step("Dora goes online 2 km north");
  const dora = await browser.person("BT-Dora", DORA);
  await dora.phone(390, 844);
  const doraId = await dora.id();
  await goOnline(dora);
  await settled(dora);

  // a slow answer at each step: the search waits for it (no deadline) and
  // never says "nobody nearby yet" while it waits — that's only for a
  // widest view really answered and empty (owner, 2026-11-09)
  step("Lu (home) on a slow connection (5 s per answer) raises ✋: it waits at each step, never 'nobody', and stops at the step with Dora's car");
  const lu = await browser.person("BT-Lu");
  await lu.phone(390, 844);
  await lu.open();
  await lu.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Lu's map loaded");
  // zoomed right in first: Dora's block is outside what Lu's map watches,
  // so only the steps out (the slow answers) can find her
  await lu.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
  await lu.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "Lu zoomed in, Dora not on his map");
  await slowMap(lu, 5000);
  // every line the banner shows from here on
  await lu.eval(`(() => {
    window.__lines = [];
    const b = document.getElementById("banner");
    new MutationObserver(() => window.__lines.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  await lu.click("btn-hand");
  await lu.waitFor("state.handRaised", "Lu's ✋ up");
  await lu.waitFor(`nearLooking && map.getZoom() <= 14`, "looking, from the usual view");
  await new Promise((r) => setTimeout(r, 6000)); // past the old 3 s give-up
  check(await lu.eval("nearLooking"), "still waiting (no deadline)");
  await lu.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 40000);
  const luStop = await firstStepShowing(lu, doraId);
  check(luStop.ok, "the first step that shows Dora's car", luStop);
  check(await onYou(lu), "centred on Lu");
  await bannerIs(lu, RIDER);
  const lines = await lu.eval("window.__lines");
  check(!lines.some((l) => l.includes("nobody nearby yet")), "never 'nobody nearby yet' while it waited", lines);
  const luId = await lu.id();
  await lu.click("btn-hand");
  await lu.waitFor("!state.handRaised", "Lu's ✋ down");

  // waiting at a step, Lu moves the map himself: the search is over — when
  // the answer comes, it leaves the map where he put it (no step further)
  step("Lu again, and swipes the map while it waits at a step: it never moves the map again");
  const zoomIn = async () => {
    await lu.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
    await lu.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "Lu zoomed in, Dora not on his map", 30000);
  };
  await zoomIn();
  await lu.click("btn-hand");
  await lu.waitFor("state.handRaised", "Lu's ✋ up");
  await lu.waitFor(`nearLooking && !map.isMoving() && !worldSync.settled()`, "waiting at a step for the answer", 15000);
  await drag(lu);
  check(!(await lu.eval("nearLooking")), "the swipe ended the search");
  await bannerIs(lu, RIDER);
  let held = await view(lu);
  await lu.waitFor(`worldSync.settled()`, "the answer in", 15000);
  await new Promise((r) => setTimeout(r, 1500)); // time to act on it (it checks every 0.1 s)
  check(JSON.stringify(await view(lu)) === JSON.stringify(held), "the map stayed where Lu put it", { held, now: await view(lu) });
  await lu.click("btn-hand");
  await lu.waitFor("!state.handRaised", "Lu's ✋ down");

  step("Lu again, and puts ✋ down while it waits at a step: it does nothing");
  await zoomIn();
  await lu.click("btn-hand");
  await lu.waitFor("state.handRaised", "Lu's ✋ up");
  await lu.waitFor(`nearLooking && !map.isMoving() && !worldSync.settled()`, "waiting at a step for the answer", 15000);
  await lu.click("btn-hand");
  await lu.waitFor("!state.handRaised && !map.isMoving()", "Lu's ✋ down");
  held = await view(lu);
  await new Promise((r) => setTimeout(r, 4000));
  await lu.waitFor(`worldSync.settled()`, "the late answer in", 10000);
  await new Promise((r) => setTimeout(r, 1000)); // time to act on it (it checks every 0.2 s)
  check(JSON.stringify(await view(lu)) === JSON.stringify(held), "the map didn't move", { held, now: await view(lu) });
  check((await lu.banner()) === "", "no line (not looking)", await lu.banner());

  await dora.waitFor(`!realEntries.has(${luId})`, "Lu's ✋ gone from Dora's map", 15000);
  await lu.close();
});
