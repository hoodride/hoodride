// A driver's last-known distance when the rider's connection dies SILENTLY
// (review, 2026-11-25): a dead path — a garage, a tunnel, iOS waking with a
// socket that still reads OPEN (WebKit bugs 247943, 308073) — sends no
// close. Phoenix's heartbeat timeout replaces the connection itself, and
// the old one's close event, arriving late or never, no longer reaches
// socket.onClose (deps/phoenix socket.js teardown: "onConnClose is not
// called when the close event arrives late"). A car found gone at the
// reconnect must still be dated to when her phone last knew the map, not
// to the reconnect ("0.6 mi away" for a driver gone a while).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees } from "./app.mjs";

await journey("laststall: a connection that dies silently, replaced at a heartbeat timeout — a car found gone dated to the stall", async (browser) => {
  step("Rosa (rider) sees Dirk's car; her connection stalls: nothing comes in, its close never confirmed");
  const rosa = await browser.person("BT-StallRosa");
  const dirk = await browser.person("BT-StallDirk", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dirk);
  const dirkId = await dirk.id();
  await sees(rosa, dirkId, "(his car)");
  const stallAt = await rosa.eval(`(() => {
    const tr = socket.conn;
    window.__stalled = tr;
    window.__realClose = tr.close.bind(tr);
    tr.onmessage = () => {};   // replies lost on the dead path
    tr.close = () => {};       // the close never confirmed: it stays OPEN
    return Date.now();
  })()`);

  step("Dirk goes offline meanwhile (she can't hear it); seconds later her heartbeat times out: Phoenix replaces the connection");
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await new Promise((r) => setTimeout(r, 5000));
  await rosa.eval(`(socket.pendingHeartbeatRef = socket.makeRef(), socket.heartbeatTimeout(), true)`);
  await rosa.waitFor(`socket.isConnected() && socket.conn !== window.__stalled`, "a new connection", 15000);
  await rosa.waitFor(`!realEntries.has(${dirkId}) && !!realPeersById.get(${dirkId}).lastSeen`, "his car found gone, kept", 15000);
  const at = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  await rosa.eval(`(window.__realClose(), true)`);
  check(at <= stallAt + 500, "his last seen: when her phone last knew (the stall), not the reconnect 5 s later", { stallAt, at, diff: at - stallAt });
  check(rosa.errors.length === 0, "no page errors", rosa.errors);
});
