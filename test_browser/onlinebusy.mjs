// Going online when the server is busy (precommit, 2026-11-26: the rare
// "rider never sees the car" — the server had NO car for the driver whose
// app said online). The first update's answer was ignored and the next one
// came only at the heartbeat (16–24 s): a refused or lost first update hid
// the car that long. Now a "busy" is tried again when the server says, any
// other failure at the next tick.
import { journey, step, check, HOME, serverAsk } from "./cdp.mjs";
import { goOnline, sees } from "./app.mjs";

await journey("onlinebusy: the first car update answered 'busy' — tried again soon, the car on the map within seconds", async (browser) => {
  step("Ola (rider) watches; Ben goes online — his first update answered 'busy'");
  const ola = await browser.person("BT-BusyOla");
  const ben = await browser.person("BT-BusyBen", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(ben);
  const benId = await ben.id();
  await sees(ola, benId, "(Ben's car)");
  // (offline, then online again — the first update after it refused once)
  await ben.click("btn-online");
  await ben.waitFor(`!state.online`, "Ben offline");
  await ola.waitFor(`!realEntries.has(${benId})`, "his car gone from Ola's map", 10000);
  await ben.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "driver_update") return orig(ev, payload, t);
      userChannel.push = orig;
      // (not placed: the server's "busy", try again in a second)
      const busy = { receive: (st, cb) => (st === "error" && setTimeout(() => cb({ reason: "busy", retry_ms: 1000 }), 50), busy) };
      return busy;
    };
    return true;
  })()`);
  const at = Date.now();
  await ben.click("btn-online");
  await ben.waitFor(`state.online`, "Ben online again");

  step("his car on the server and on Ola's map within a few seconds — not at the next heartbeat (16–24 s)");
  await ola.waitFor(`realEntries.has(${benId})`, "his car back on Ola's map", 8000).catch(async (e) => {
    check(false, "the car placed soon", { cell: await serverAsk(`driver_cell ${benId}`), after: Date.now() - at });
    throw e;
  });
  check(ben.errors.length === 0 && ola.errors.length === 0, "no page errors", [ben.errors, ola.errors]);
});
