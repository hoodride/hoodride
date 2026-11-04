// Signing out takes you off the map at once (owner, 2026-10-31): a rider's ✋
// leaves the drivers' maps, a driver's car the riders' (and whoever was
// waiting on it is declined) — not minutes later. Refused by the server
// during a ride or while your own request waits, even when the phone hadn't
// heard of it yet (a waiting request, a ride).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, bannerIs, signOut } from "./app.mjs";


await journey("signout: off the map at once; refused in a ride or a waiting request", async (browser) => {
  step("Rita (rider) and Dan (driver, online) sign in; Rita raises ✋, Dan sees it");
  const rita = await browser.person("BT-Rita");
  const dan = await browser.person("BT-Dan");
  await goOnline(dan);
  const [ritaId, danId] = [await rita.id(), await dan.id()];
  await rita.click("btn-hand");
  await rita.waitFor("state.handRaised", "✋ up");
  await sees(dan, ritaId, "(her ✋)");
  // a ✋ on the map is the hand picture (icons.js), not the emoji
  // (drawn just after Dan's app has her: wait for it)
  await dan.waitFor(`[...pileMarkers.values()].some((pm) => pm.el.querySelector('img[src^="hand.svg"]') && !pm.el.textContent.includes("✋"))`, "Dan's map: the hand picture");

  step("Rita signs out: her ✋ leaves Dan's map at once");
  await signOut(rita);
  await dan.waitFor(`!realEntries.has(${ritaId})`, "Rita's ✋ gone from Dan's map", 5000);
  await rita.close(); // done: fewer pages open for the rest

  step("Ria (rider) asks Dan for a ride: waiting");
  const ria = await browser.person("BT-Ria");
  const riaId = await ria.id();
  await sees(ria, danId, "(his car)");
  await openChatWith(ria, danId);
  await ria.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await ria.click("btn-ride-action");
  await ria.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await ria.eval(`closeChat(), true`);

  step("Ria's phone hasn't heard of her request (as in a race): the server refuses the sign-out");
  await ria.eval(`(state.ride = null, renderSettings(), true)`);
  await ria.click("btn-logout");
  await bannerIs(ria, "Cancel your ride request first");
  const me = await ria.eval(`fetch("/api/me").then((r) => r.json())`);
  check(!!me.user && me.user.id === riaId, "Ria still signed in", me);
  check(await dan.eval(`realPeersById.get(${riaId}).pending`), "Dan still has her request");

  step("Rob (rider) and Eve (driver) are in a ride");
  // a few blocks away: at the same spot she'd have "arrived" at once
  const eve = await browser.person("BT-Eve", { latitude: HOME.latitude + 0.006, longitude: HOME.longitude });
  await goOnline(eve);
  const rob = await browser.person("BT-Rob");
  const [eveId, robId] = [await eve.id(), await rob.id()];
  await sees(rob, eveId, "(her car)");
  await openChatWith(rob, eveId);
  await rob.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await rob.click("btn-ride-action");
  await eve.waitFor(`realPeersById.has(${robId}) && realPeersById.get(${robId}).pending`, "Eve has the request");
  await eve.eval(`openChat(realPeersById.get(${robId})), true`);
  await eve.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await eve.click("btn-ride-action");
  await rob.waitFor(`state.ride && state.ride.status === "connected"`, "Rob in the ride");
  await eve.waitFor(`state.ride && state.ride.status === "connected"`, "Eve in the ride");
  await rob.eval(`closeChat(), true`);

  step("Rob's phone has lost track of the ride: the server refuses the sign-out");
  // (as the app itself drops a ride: the ride channel left, then the ride)
  await rob.eval(`(realRideCleanup(), renderSettings(), true)`);
  await rob.click("btn-logout");
  await bannerIs(rob, "End your ride first");
  const robMe = await rob.eval(`fetch("/api/me").then((r) => r.json())`);
  check(!!robMe.user && robMe.user.id === robId, "Rob still signed in", robMe);
  await rob.open();
  await rob.waitFor(`state.ride && state.ride.status === "connected"`, "Rob: the ride, from the server");
  check(await eve.eval(`!!state.ride && state.ride.status === "connected"`), "Eve still in the ride");
  await rob.click("btn-endride");
  await rob.waitFor(`!state.ride`, "Rob's ride ended");
  await eve.waitFor(`!state.ride`, "Eve's ride ended");
  await rob.close();
  await eve.close();

  step("Dan signs out: his car leaves Ria's map, her request is declined");
  await ria.open();
  await ria.waitFor(`state.ride && state.ride.status === "requested"`, "the request, from the server");
  await signOut(dan);
  await ria.waitFor(`!realEntries.has(${danId})`, "Dan's car gone from Ria's map", 5000);
  await ria.waitFor(`!state.ride`, "Ria's request ended (declined)", 5000);
});
