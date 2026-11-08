// Find the nearest on a hopeless connection (owner, 2026-11-07): the search
// waits 3 s for the server's answer, then decides with what it has, and
// keeps listening 30 s more for a late one (findnearest.mjs: a 5 s answer
// still zooms in to the nearest). After that it has given up: an answer 40 s
// late no longer moves the map — by then the map may be anywhere in your
// mind, and a jump out of nowhere would be worse than none.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, bannerIs } from "./app.mjs";
import { HOME } from "./cdp.mjs";

const RIDER = "✋ Nearby drivers can see you need a ride";

await journey("findnearestslow: a 40-second answer no longer moves the map", async (browser) => {
  step("Dora online 2 km north; Kim (home) zoomed right in, on a connection 40 s slow");
  const dora = await browser.person("BT-Dora", { latitude: HOME.latitude + 2 / 111.32, longitude: HOME.longitude });
  await goOnline(dora);
  const doraId = await dora.id();
  const kim = await browser.person("BT-Kim");
  await kim.phone(390, 844);
  await kim.open();
  await kim.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Kim's map loaded");
  await kim.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
  await kim.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "zoomed in, Dora not on Kim's map");
  // the map's question reaches the server 40 s late (so its answer does too)
  await kim.eval(`(() => {
    const push = worldChannel.push.bind(worldChannel);
    worldChannel.push = (event, ...rest) => {
      if (event !== "sync") return push(event, ...rest);
      const cbs = [];
      const later = { receive(status, cb) { cbs.push([status, cb]); return later; } };
      setTimeout(() => cbs.reduce((p, [status, cb]) => p.receive(status, cb), push(event, ...rest)), 40000);
      return later;
    };
    return true;
  })()`);

  step("Kim raises ✋: 'nobody nearby yet', as wide as cars still show");
  await kim.click("btn-hand");
  await kim.waitFor("state.handRaised", "Kim's ✋ up");
  await bannerIs(kim, RIDER + " · nobody nearby yet");
  await kim.waitFor("!nearLooking && !map.isMoving()", "the map settled");
  const held = await kim.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; })()`);

  step("the answer comes 40 s later (Dora's car with it): the map stays where it was");
  await kim.waitFor(`worldSync.settled() && realEntries.has(${doraId})`, "the late answer in, Dora on Kim's map", 50000);
  await new Promise((r) => setTimeout(r, 1500)); // (it checked every 0.2 s while it listened)
  const now = await kim.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; })()`);
  check(JSON.stringify(now) === JSON.stringify(held), "not moved", { held, now });
  // (her car is on screen now: the line says so — nobodyNear clears)
  await bannerIs(kim, RIDER);
});
