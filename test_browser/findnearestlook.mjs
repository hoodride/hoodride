// Find the nearest on a slow connection: stopping looking while it waits at
// a step for the answer (owner, 2026-11-08; split from findnearestlate.mjs —
// together they came near a journey's time).
// Find the nearest (owner, 2026-11-07; step by step 2026-11-09): Go online,
// ✋ Need a ride, or the locate button while either is on — the map centres
// on you at the usual zoom (14), then steps out half a level at a time,
// waiting at each step for the server's answer however long it takes,
// until someone you're looking for shows (a rider: cars; a driver: ✋), and
// stays there. Nobody at the widest view that still shows people one by
// one: "nobody nearby yet". Any move of your own ends it.
// The rules themselves (steps, edges): test_js/nearby.test.mjs.
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, bannerIs } from "./app.mjs";

// `km` north and east of home
const near = (north, east = 0) => ({
  latitude: HOME.latitude + north / 111.32,
  longitude: HOME.longitude + east / (111.32 * Math.cos((HOME.latitude * Math.PI) / 180)),
});
const DORA = near(2); // about 1¼ miles north of Lu: further than the usual view

// the search over, the camera still
const settled = (p) => p.waitFor(`!nearLooking && !map.isMoving()`, `${p.name}: the map settled`);
const view = (p) =>
  p.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), cars: map.getZoom() > 0 && HoodViewport.planWatch(h3, screenRect(), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS)?.res === H3_RES }; })()`);
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

await journey("findnearestlook: stopping looking while the late answer is on its way", async (browser) => {
  step("Dora goes online 2 km north; Lu (home) on a very slow connection (8 s from the first step on)");
  const dora = await browser.person("BT-Dora", DORA);
  await dora.phone(390, 844);
  const doraId = await dora.id();
  await goOnline(dora);
  await settled(dora);
  const lu = await browser.person("BT-Lu");
  await lu.phone(390, 844);
  await lu.open();
  await lu.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Lu's map loaded");
  const luId = await lu.id();
  await slowMap(lu, 5000);
  // zoomed right in: Dora's block is outside what Lu's map watches, so only
  // the wide look (the slow answer) can find her
  const zoomIn = async () => {
    await lu.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
    await lu.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "Lu zoomed in, Dora not on his map", 30000);
  };

  // stopping looking in a way that doesn't end the search itself — a ride
  // starting and ending (live, or heard through a reload), a request —
  // while the late answer is on its way: when it comes, it leaves the map
  // alone. Max's car is out there meanwhile, so an answer acted on would
  // move the map to fit him
  const max = await browser.person("BT-Max", near(-2));
  await goOnline(max, { color: "White", make: "Ford", model: "Focus" });
  const maxId = await max.id();
  const zoomInAlone = async () => {
    await zoomIn();
    await lu.waitFor(`!realEntries.has(${maxId})`, "Max not on Lu's map either", 15000);
  };
  // `moveable`: the answer brought Max's car onto Lu's map — so acting on
  // it WOULD have moved the map (the check isn't true by default)
  const quietFor = async (what, moveable = true) => {
    const held = await view(lu);
    await new Promise((r) => setTimeout(r, 6000)); // most of the way to the late answer (5 s, later 8 s): then wait for it
    await lu.waitFor(`worldSync.settled()`, "the late answer in", 10000);
    await new Promise((r) => setTimeout(r, 1000)); // time to act on it (it checks every 0.2 s)
    check(JSON.stringify(await view(lu)) === JSON.stringify(held), `${what}: the map didn't move`, { held, now: await view(lu) });
    if (moveable) check(await lu.eval(`realEntries.has(${maxId})`), `${what}: (Max's car came with the answer)`);
  };
  const lookAgain = async () => {
    await zoomInAlone();
    await lu.click("btn-hand");
    await lu.waitFor("state.handRaised", "Lu's ✋ up");
    // waiting at a step for the slow answer: no "nobody" while it waits
    await lu.waitFor(`nearLooking && !map.isMoving() && !worldSync.settled()`, "waiting at a step for the answer", 15000);
    await bannerIs(lu, RIDER);
  };
  const doraBack = async () => {
    await dora.waitFor(`!state.ride && !state.online && !document.getElementById("btn-online").classList.contains("hidden")`, "Dora's GO ONLINE back");
    await dora.click("btn-online");
    await dora.waitFor(`state.online`, "Dora online again");
    await settled(dora);
  };

  // (an even slower answer from here — 8 s: the ride, the reload, the
  // request all happen while it's still on its way, with time to spare on
  // a busy machine)
  await slowMap(lu, 3000);

  step("Lu again; a short ride with Dora starts and ends while the late answer is on its way: it leaves the map alone");
  await lookAgain();
  await server(`start_ride ${luId} ${doraId}`);
  await lu.waitFor(`state.ride && state.ride.status === "connected"`, "Lu in the ride");
  check(!(await lu.eval("worldSync.settled()")), "(the answer still on its way)");
  await lu.click("btn-endride");
  await lu.waitFor(`!state.ride && !map.isMoving()`, "the ride over, Lu's map still");
  await quietFor("after the ride");
  await doraBack();

  // the same, the ride heard only through a reload (not live)
  step("Lu again; a short ride starts, heard only through a reload, and ends while the late answer is on its way: it leaves the map alone");
  await lookAgain();
  await lu.eval(`(() => {
    window.__trigger = userChannel.trigger;
    const on = userChannel.trigger.bind(userChannel);
    userChannel.trigger = (ev, ...a) => (ev === "ride_started" ? undefined : on(ev, ...a));
    return true;
  })()`);
  await server(`start_ride ${luId} ${doraId}`);
  await new Promise((r) => setTimeout(r, 500));
  check(!(await lu.eval("state.ride")), "(not heard live)");
  check(!(await lu.eval("worldSync.settled()")), "(the answer still on its way)");
  await lu.eval(`softReload(), true`);
  await lu.waitFor(`hydrated && !reloading && state.ride && state.ride.status === "connected"`, "the reload: Lu in the ride", 15000);
  await lu.eval(`(userChannel.trigger = window.__trigger), true`);
  await lu.click("btn-endride");
  await lu.waitFor(`!state.ride && !map.isMoving()`, "the ride over, Lu's map still");
  await quietFor("after the ride heard through a reload");
  await doraBack();

  // a request: ✋ stays up, but Lu is waiting on one car now — not looking
  step("Lu again, and asks Dora for a ride while the late answer is on its way: it leaves the map alone");
  await lookAgain();
  await lu.eval(`openChat(realPeersById.get(${doraId})), true`);
  await lu.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await lu.click("btn-ride-action");
  await lu.waitFor(`state.ride && state.ride.status === "requested"`, "Lu's request waiting");
  check(!(await lu.eval("worldSync.settled()")), "(the answer still on its way)");
  await lu.eval(`closeChat(), true`);
  await lu.waitFor(`!map.isMoving()`, "Lu's map still");
  await quietFor("while the request waits");
  await lu.click("btn-endride"); // cancel the request
  await lu.waitFor(`!state.ride`, "the request cancelled");
  if (await lu.eval("state.handRaised")) {
    await lu.click("btn-hand");
    await lu.waitFor("!state.handRaised", "Lu's ✋ down");
  }

  // switching to driving and back: a rider again, ✋ down — not looking,
  // but watching the wide view, so Max's car comes with the answer
  step("Lu again, and switches to driving and back while the late answer is on its way: it leaves the map alone");
  await lookAgain();
  await lu.click("btn-mode");
  await lu.waitFor(`state.mode === "driver" && !state.handRaised`, "Lu a driver, ✋ down");
  await lu.click("btn-mode");
  await lu.waitFor(`state.mode === "rider" && !state.handRaised && !map.isMoving()`, "a rider again, ✋ down, the map still");
  check(!(await lu.eval("worldSync.settled()")), "(the answer still on its way)");
  await quietFor("after switching and back");
  check(!(await lu.eval("nobodyNear")), "no 'nobody nearby' left set");
  await max.close();

  await dora.waitFor(`!realEntries.has(${luId})`, "Lu's ✋ gone from Dora's map", 15000);
  await lu.close();
});
