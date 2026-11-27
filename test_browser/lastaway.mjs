// A driver's last-known distance while the RIDER's phone was away (its
// connection dropped — a lock, a tunnel, iOS freezing the tab): review,
// 2026-11-24.
// 1. Dirk goes offline meanwhile: found gone at the reconnect, his "last
//    seen" is when her phone last KNEW the map (the gap's start), not when
//    it found out — "0 min ago" for a driver gone minutes.
// 2. The request she knew of gone when she's back — a whole ride with him
//    meanwhile (request → accept → end, none of it seen), or only a decline
//    or an expiry: the block from when she asked is cleared. The server
//    keeps no ride history, so the app can't tell these apart; a blank
//    distance beats a wrong one, and his car fills it in again (owner,
//    2026-11-25: no server note).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, DRAWN } from "./app.mjs";

const away = (p) => p.eval(`(socket.disconnect(), true)`);
const back = async (p) => {
  await p.eval(`(socket.connect(), true)`);
  await p.waitFor(`socket.isConnected() && hydrated && !reloading`, `${p.name}: back`, 15000);
};

await journey("lastaway: a driver's last-known distance when the rider's phone was away — stamped when it last knew; cleared when the request she knew of is gone", async (browser) => {
  step("Rosa (rider) sees Dirk's car; her connection drops; Dirk goes offline; it comes back: his last seen is from before the drop");
  const rosa = await browser.person("BT-AwayRosa");
  const dirk = await browser.person("BT-AwayDirk", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dirk);
  const [dirkId, rosaId] = [await dirk.id(), await rosa.id()];
  await sees(rosa, dirkId, "(his car)");
  const droppedAt = await rosa.eval(`Date.now()`);
  await away(rosa);
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await new Promise((r) => setTimeout(r, 4000));
  await back(rosa);
  await rosa.waitFor(`!realEntries.has(${dirkId}) && !!realPeersById.get(${dirkId}).lastSeen`, "his car gone (found at the reconnect), kept", 15000);
  const at = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at <= droppedAt + 1000, "last seen: when her phone last knew (the drop), not when it found out (4 s later)", { droppedAt, at, diff: at - droppedAt });

  step("a whole ride with Dirk while she's away: his block from when she asked is cleared");
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, back)");
  await openChatWith(rosa, dirkId);
  await rosa.click("btn-ride-action");
  await rosa.waitFor(`state.ride && state.ride.status === "requested" && !!realPeersById.get(${dirkId}).lastSeen`, "asked: his block kept (the cars hide)");
  await away(rosa);
  await dirk.waitFor(`realPeersById.get(${rosaId}) && realPeersById.get(${rosaId}).pending === true`, "Dirk has the request");
  await dirk.eval(`(openChat(realPeersById.get(${rosaId})), true)`);
  await dirk.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride");
  await dirk.click("btn-ride-action");
  await dirk.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "Dirk in the ride", 15000);
  await dirk.click("btn-endride");
  await dirk.waitFor(`!state.ride`, "the ride over (Dirk ended it)");
  await back(rosa);
  await rosa.waitFor(`!state.ride`, "Rosa: no ride, no request");
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`)) == null, "his block from when she asked: cleared (a ride happened)");
  // (a late snapshot dropping a stale entry of his — kept from before the
  // ride, its news from before the gap — after the reload cleared it:
  // never taken again. Set as it happens: his old entry, a silence)
  await rosa.eval(`(() => {
    const p = realPeersById.get(${dirkId});
    p.pos = p.pos || { lat: ${HOME.latitude + 0.004}, lng: ${HOME.longitude} };
    realEntries.set(${dirkId}, { peer: p, type: "driver", cell: "x", spot: "x" });
    socketLiveAt = Date.now() - 60_000;
    dropEntry(${dirkId});
    socketLiveAt = Date.now();
    return true;
  })()`);
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`)) == null, "a stale entry dropped late: his old block not taken again");

  step("a ride that starts while she's away and is still on when she's back: the block from when she asked is cleared");
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, once more)");
  await openChatWith(rosa, dirkId);
  await rosa.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await rosa.click("btn-ride-action");
  await rosa.waitFor(`state.ride && state.ride.status === "requested" && !!realPeersById.get(${dirkId}).lastSeen`, "asked: his block kept");
  await away(rosa);
  await dirk.waitFor(`realPeersById.get(${rosaId}) && realPeersById.get(${rosaId}).pending === true`, "Dirk has the request");
  await dirk.eval(`(openChat(realPeersById.get(${rosaId})), true)`);
  await dirk.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride");
  await dirk.click("btn-ride-action");
  await dirk.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "Dirk in the ride", 15000);
  await back(rosa);
  await rosa.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "Rosa: in the ride");
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`)) == null, "his block from when she asked: cleared (the ride is on)");
  await dirk.click("btn-endride");
  await rosa.waitFor(`!state.ride`, "the ride over");

  step("only a decline while she's away: his block is cleared too (no ride history to tell them apart)");
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, again)");
  await openChatWith(rosa, dirkId);
  await rosa.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await rosa.click("btn-ride-action");
  await rosa.waitFor(`state.ride && state.ride.status === "requested" && !!realPeersById.get(${dirkId}).lastSeen`, "asked again: his block kept");
  await away(rosa);
  await dirk.waitFor(`realPeersById.get(${rosaId}) && realPeersById.get(${rosaId}).pending === true`, "Dirk has the request");
  await dirk.eval(`(openChat(realPeersById.get(${rosaId})), true)`);
  await dirk.waitFor(`!document.getElementById("btn-decline").classList.contains("hidden")`, "Decline");
  await dirk.click("btn-decline");
  await dirk.waitFor(`realPeersById.get(${rosaId}).pending !== true`, "declined");
  await back(rosa);
  await rosa.waitFor(`!state.ride`, "Rosa: the request gone");
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`)) == null, "his block: cleared (the request she knew of is gone)");

  step("a flapping connection: it drops, comes back and catches up, drops again; Dirk goes offline meanwhile: dated to the SECOND drop, not the first");
  if (!(await dirk.eval(`state.online`))) await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, after the decline)");
  // (the first outage long — 8 s — so its time and the second's can't mix up)
  await away(rosa);
  await new Promise((r) => setTimeout(r, 8000));
  const back1 = await rosa.eval(`Date.now()`);
  await back(rosa);
  await rosa.waitFor(`worldSync.settled() && ${DRAWN(dirkId)}`, "caught up: his car drawn again", 15000);
  await new Promise((r) => setTimeout(r, 3000));
  const drop2 = await rosa.eval(`Date.now()`);
  await away(rosa);
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await back(rosa);
  await rosa.waitFor(`!realEntries.has(${dirkId}) && !!realPeersById.get(${dirkId}).lastSeen`, "his car gone, kept", 15000);
  const at5 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  // (known live till at least the first reconnect's catch-up — the last
  // message before the second drop, not the first drop, 8 s before it)
  check(at5 >= back1 && at5 <= drop2, "dated after the first outage ended, by the second drop", { back1, drop2, at5 });

  step("connected again, the catch-up not done yet: a car dropped then — a cell the rejoin let go, or the map torn down for a ride that started meanwhile — is dated to the loss, not 'now'");
  // (as it is mid-catch-up: the socket back, the map's sync not settled,
  // the loss a minute ago; a driver entry known from before it)
  const mid = await rosa.eval(`(() => {
    const lost = Date.now() - 60_000;
    const p = ensurePeer({ id: 900000003, name: "T3" });
    p.pos = { lat: ${HOME.latitude + 0.002}, lng: ${HOME.longitude} };
    const settled = worldSync.settled;
    worldSync.settled = () => false;
    lostFrom = lost;
    // a cell let go by the rejoin (onDropGeo → dropEntry)
    realEntries.set(p.id, { peer: p, type: "driver", cell: "x", spot: "x" });
    dropEntry(p.id);
    const a1 = p.lastSeen && p.lastSeen.at;
    // the map torn down for a ride (onServerRole → dropEntry), the old
    // state still a request
    p.lastSeen = null;
    realEntries.set(p.id, { peer: p, type: "driver", cell: "x", spot: "x" });
    const ride = state.ride;
    state.ride = { peer: realPeersById.get(${dirkId}) || p, status: "requested" };
    dropEntry(p.id);
    const a2 = p.lastSeen && p.lastSeen.at;
    state.ride = ride;
    worldSync.settled = settled;
    lostFrom = null;
    return { lost, a1, a2 };
  })()`);
  check(mid.a1 === mid.lost && mid.a2 === mid.lost, "both dated to the loss", mid);

  step("the request's answer lost (the connection drops as she taps), then a whole ride missed: his block from before it is cleared all the same");
  // (Dax: a driver she's never asked — Dirk's decline above started its
  // minute's cooldown)
  const dax = await browser.person("BT-AwayDax", { latitude: HOME.latitude - 0.004, longitude: HOME.longitude });
  await goOnline(dax);
  const daxId = await dax.id();
  await sees(rosa, daxId, "(Dax's car)");
  await openChatWith(rosa, daxId);
  await rosa.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  // (the reload can't reach the server meanwhile: the push's timeout
  // would otherwise recover the request over HTTP)
  await rosa.eval(`(() => { window.__blockState = true; const f = window.fetch; window.fetch = (u, o) => (window.__blockState && String(u).includes("/api/state") ? Promise.reject(new TypeError("blocked")) : f(u, o)); return true; })()`);
  // (the request goes out; its answer is lost — as when the connection
  // drops right after the tap; then the connection does drop)
  await rosa.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      const real = orig(ev, payload, t);
      if (ev !== "request_ride") return real;
      userChannel.push = orig;
      // (lost: no answer — Phoenix's push timeout fires, as it always does)
      const lost = { receive: (st, cb) => (st === "timeout" && setTimeout(cb, 300), lost) };
      return lost;
    };
    document.getElementById("btn-ride-action").click();
    return true;
  })()`);
  await dax.waitFor(`realPeersById.get(${rosaId}) && realPeersById.get(${rosaId}).pending === true`, "the request reached Dax");
  check((await rosa.eval(`state.ride`)) == null, "Rosa's app: no answer, no request known");
  await rosa.eval(`(socket.disconnect(), true)`);
  await dax.waitFor(`realPeersById.get(${rosaId}) && realPeersById.get(${rosaId}).pending === true`, "Dax has the request");
  await dax.eval(`(openChat(realPeersById.get(${rosaId})), true)`);
  await dax.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride");
  await dax.click("btn-ride-action");
  await dax.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "Dax in the ride", 15000);
  await dax.click("btn-endride");
  await dax.waitFor(`!state.ride`, "the ride over");
  await new Promise((r) => setTimeout(r, 11000));
  await rosa.eval(`(window.__blockState = false, true)`);
  await back(rosa);
  await rosa.waitFor(`!realEntries.has(${daxId}) && !reloading`, "back: his car gone", 15000);
  check((await rosa.eval(`realPeersById.get(${daxId}).lastSeen`)) == null, "his block from before the ride: cleared (a ride happened)", await rosa.eval(`realPeersById.get(${daxId}).lastSeen`));
  check(rosa.errors.length === 0, "no page errors", rosa.errors);
});
