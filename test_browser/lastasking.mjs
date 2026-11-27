// A reload while a Request ride is still on its way (cross-feature review,
// 2026-11-25): the snapshot can be taken before the server has saved it —
// a request in flight isn't a request gone. Her last-known distance to the
// driver she's asking must stay (it was wiped: the reload took "not in the
// snapshot" for "answered while away").
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("lastasking: a reload while her request is still on its way keeps the driver's last-known distance", async (browser) => {
  step("Rosa (rider) has Dirk's last-known block (as his car left her view); she taps Request ride — the push held on its way");
  const rosa = await browser.person("BT-AskRosa");
  const dirk = await browser.person("BT-AskDirk", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dirk);
  const dirkId = await dirk.id();
  await sees(rosa, dirkId, "(his car)");
  await openChatWith(rosa, dirkId);
  await rosa.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await rosa.eval(`(() => {
    const p = realPeersById.get(${dirkId});
    p.lastSeen = { lat: ${HOME.latitude + 0.004}, lng: ${HOME.longitude}, at: Date.now() - 300_000 };
    // (the request on its way: sent only when released — as a slow server
    // that hasn't saved it yet when a reload's snapshot is read)
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "request_ride") return orig(ev, payload, t);
      userChannel.push = orig;
      const hooks = [];
      const held = { receive: (st, cb) => (hooks.push([st, cb]), held) };
      window.__release = () => {
        let r = orig(ev, payload, t);
        hooks.forEach(([st, cb]) => (r = r.receive(st, cb)));
      };
      return held;
    };
    document.getElementById("btn-ride-action").click();
    return true;
  })()`);

  step("a reload meanwhile (a rejoin's): the snapshot has no request yet — her last-known block of him stays");
  await rosa.eval(`(softReload(), true)`);
  await rosa.waitFor(`hydrated && !reloading`, "reloaded", 10000);
  const kept = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`);
  check(kept != null, "his last-known block kept (the request is only on its way)", kept);

  step("the request arrives: she's waiting on Dirk");
  await rosa.eval(`(window.__release(), true)`);
  await rosa.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  check(rosa.errors.length === 0, "no page errors", rosa.errors);
});
