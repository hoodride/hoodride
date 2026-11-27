// A rider's chat with a driver keeps the driver's distance when the car
// leaves her map (owner, 2026-11-22: it went blank when he went offline —
// drivers share no block, the car on her map was all there was). Now the
// car's last block and the moment it left: "0.4 mi away", then
// "0.4 mi away · 3 min ago" as it ages; back on the map, the map's again.
// Her request hides the cars: his distance stays too. After a ride with
// him, the block from before it is gone (he's driven since).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, DRAWN } from "./app.mjs";

const DIST = `document.getElementById("chat-dist").textContent`;

await journey("lastseen: a driver's distance stays in the rider's chat when his car leaves her map — with its age", async (browser) => {
  step("Rosa (rider) and Dirk (driver, online, ~0.4 mi north): her chat with him says how far");
  const rosa = await browser.person("BT-SeenRosa");
  const dirk = await browser.person("BT-SeenDirk", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dirk);
  const dirkId = await dirk.id();
  await sees(rosa, dirkId, "(his car)");
  await openChatWith(rosa, dirkId);
  await rosa.waitFor(`${DIST}.endsWith("away")`, "a distance in the chat's header");
  const before = await rosa.eval(DIST);
  check(!before.includes("ago"), "on the map: no age", before);

  step("Dirk goes offline: his car leaves her map — the distance stays, the same");
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await rosa.waitFor(`!(${DRAWN(dirkId)})`, "his car gone from her map", 15000);
  // (asked afresh: the kept block, not the header's old text — the header
  // following the map by itself is step 4's)
  await rosa.eval(`(refreshChatDistance(), true)`);
  const after = await rosa.eval(DIST);
  check(after === before, "the same distance, still there", { before, after });

  step("3 minutes on: it says how old it is");
  await rosa.eval(`(realPeersById.get(${dirkId}).lastSeen.at -= 3 * 60_000, refreshChatDistance(), true)`);
  const aged = await rosa.eval(DIST);
  check(aged === `${before} · 3 min ago`, "… · 3 min ago", aged);

  step("Dirk back online: his car on her map again — the map's distance, no age");
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, back)");
  await rosa.waitFor(`${DIST}.endsWith("away") && !${DIST}.includes("ago")`, "the map's again: no age (by itself)");

  // (Ben: another driver she knows, west of her)
  const ben = await browser.person("BT-SeenBen", { latitude: HOME.latitude, longitude: HOME.longitude - 0.004 });
  await goOnline(ben);
  const benId = await ben.id();
  await sees(rosa, benId, "(Ben's car)");

  step("Rosa asks Dirk for a ride: the cars hide — his distance stays");
  await rosa.click("btn-ride-action");
  await rosa.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await rosa.waitFor(`!(${DRAWN(dirkId)})`, "cars hidden (at once)");
  // (a fresh stamp: the one from his time offline was aged 3 min above)
  const asked = await rosa.eval(DIST);
  check(asked === before, "the same distance while she waits", { before, asked });

  step("while she waits, Dirk drives on: her chat follows his car (still sent to her, hidden) — and after a full reload too");
  await dirk.locate({ latitude: HOME.latitude + 0.012, longitude: HOME.longitude });
  await rosa.waitFor(`${DIST}.endsWith("away") && ${DIST} !== ${JSON.stringify(before)} && !${DIST}.includes("ago")`, "his live distance, farther", 20000);
  const moved = await rosa.eval(DIST);
  await rosa.open();
  await rosa.waitFor(`hydrated && !reloading && state.ride && state.ride.status === "requested" && realEntries.has(${dirkId})`, "back, the request open, his car known", 15000);
  await rosa.eval(`(openChat(realPeersById.get(${dirkId})), true)`);
  await rosa.waitFor(`${DIST} === ${JSON.stringify(moved)}`, "his distance after the reload (not blank)", 10000);
  // (back where he was: the steps below move him again)
  await dirk.locate({ latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await rosa.waitFor(`${DIST} === ${JSON.stringify(before)}`, "his distance as before", 20000);

  step("he accepts: his block from when she asked is gone in the ride; Ben, who drove on while she waited, kept at his latest block; the ride ends");
  // (Ben drives on while she waits — still sent to her, hidden)
  await ben.locate({ latitude: HOME.latitude, longitude: HOME.longitude - 0.010 });
  await rosa.waitFor(`realPeersById.get(${benId}).pos.lng < ${HOME.longitude - 0.007}`, "Ben's move heard", 20000);
  const benNow = await rosa.eval(`realPeersById.get(${benId}).pos.lng`);
  // (the ride taking the map keeps every car you knew at its latest block —
  // whatever order the ride's news and the map's teardown come in: asked
  // directly, Ben's block moved within his cell meanwhile)
  const benMoved = await rosa.eval(`(() => {
    const b = realPeersById.get(${benId});
    b.pos = { lat: b.pos.lat, lng: b.pos.lng - 0.001 };
    // (…after an outage: what was known of it dates from the loss)
    const lost = Date.now() - 120_000;
    lostFrom = lost;
    rideTakesTheMap(realPeersById.get(${dirkId}), "driver");
    lostFrom = null;
    const lng = b.lastSeen && b.lastSeen.lng;
    const at = b.lastSeen && b.lastSeen.at;
    b.pos = { lat: b.pos.lat, lng: b.pos.lng + 0.001 };
    return { lng, want: b.pos.lng - 0.001, at, lost };
  })()`);
  check(benMoved.lng === benMoved.want, "a ride taking the map: Ben kept at his latest block", benMoved);
  check(benMoved.at === benMoved.lost, "…dated to the connection's loss, not 'now'", benMoved);
  const rosaId = await rosa.id();
  await dirk.waitFor(`realPeersById.get(${rosaId}) && realPeersById.get(${rosaId}).pending === true`, "Dirk has the request");
  await dirk.eval(`(openChat(realPeersById.get(${rosaId})), true)`);
  await dirk.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride");
  await dirk.click("btn-ride-action");
  await rosa.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "the ride started", 15000);
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`)) == null, "in the ride: Dirk's block from when she asked, gone");
  check((await rosa.eval(`(realPeersById.get(${benId}).lastSeen || {}).lng`)) === benNow, "Ben: kept at his latest block, not where he was when she asked", await rosa.eval(`realPeersById.get(${benId}).lastSeen`));
  await rosa.click("btn-endride");
  await rosa.waitFor(`!state.ride`, "the ride over");
  // (after the redraw that ending schedules: nothing stamps it again)
  await rosa.waitFor(`!renderMarkersSoon.pending()`, "the map redrawn");
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen`)) == null, "his last block from before the ride: gone");

  step("her app in the background (no screen frames): Dirk drives on, then goes offline — kept where he WENT offline, not where she last saw him drawn");
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, after the ride)");
  await openChatWith(rosa, dirkId);
  await rosa.waitFor(`${DIST}.endsWith("away")`, "his distance");
  const near = await rosa.eval(DIST);
  const lat0 = await rosa.eval(`realPeersById.get(${dirkId}).pos.lat`);
  // (a background tab: animation frames held — the map's redraws wait —
  // and run when it's shown again, as browsers do)
  await rosa.eval(`(window.__raf = window.requestAnimationFrame, window.__frames = [], window.requestAnimationFrame = (f) => (window.__frames.push(f), 1), true)`);
  await dirk.locate({ latitude: HOME.latitude + 0.012, longitude: HOME.longitude });
  await rosa.waitFor(`realPeersById.get(${dirkId}).pos.lat > ${lat0} + 0.003`, "his move heard (not drawn)", 20000);
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await rosa.waitFor(`!realEntries.has(${dirkId})`, "his car gone (heard)", 15000);
  const backAt = await rosa.eval(`Date.now()`);
  // (shown again: the held frames run — the redraw then doesn't stamp anew)
  await rosa.eval(`(window.requestAnimationFrame = window.__raf, window.__frames.splice(0).forEach((f) => f(performance.now())), true)`);
  await rosa.waitFor(`!renderMarkersSoon.pending()`, "the map redrawn");
  check((await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`)) < backAt, "kept from when he went, not from when she came back");
  const far = await rosa.eval(DIST);
  check(far.endsWith("away") && far !== near, "measured to where he went offline (farther), not his last drawn block", { near, far, lat0, why: await rosa.eval(`(() => { const p = realPeersById.get(${dirkId}); return { pos: p.pos, lastSeen: p.lastSeen, shared: p.shared, here: loc.best, inDrawn: drawnCars.has(${dirkId}), entry: realEntries.has(${dirkId}) }; })()`) });
  check(rosa.errors.length === 0, "no page errors", rosa.errors);
});
