// A ride, start to finish (owner, 2026-10-30): request, accept, both in the
// ride with the car shown; mid-ride the connection drops — the ride stays
// on screen ("… · Reconnecting…"), End ride is refused; back, it ends for
// both.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, bannerIs, bannerLike, bannerHasCar, dropAndWait, restoreAndWait } from "./app.mjs";

await journey("ride: request, accept, a dropped connection, end", async (browser) => {
  step("Rita (rider) and Dan (driver, online, Blue Toyota Prius) sign in");
  const rita = await browser.person("BT-Rita");
  // a few blocks away: at the same spot he'd have "arrived" at once
  const dan = await browser.person("BT-Dan", { latitude: HOME.latitude + 0.006, longitude: HOME.longitude });
  await goOnline(dan, { color: "Blue", make: "Toyota", model: "Prius" });
  const [ritaId, danId] = [await rita.id(), await dan.id()];
  await sees(rita, danId);

  step("Rita asks Dan for a ride: waiting");
  await openChatWith(rita, danId);
  await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested"`, "requested");

  step("Rita's connection drops: cancelling the request is refused, it still waits");
  await rita.eval(`closeChat(), true`);
  await dropAndWait(rita);
  await rita.click("btn-endride");
  await bannerIs(rita, "Can't reach Hood Ride — try again");
  check(await rita.eval(`!!state.ride && state.ride.status === "requested"`), "still requested on Rita's screen");
  check(await dan.eval(`realPeersById.get(${ritaId}).pending`), "Dan still has the request");
  await restoreAndWait(rita);
  await rita.waitFor(`state.ride && state.ride.status === "requested"`, "back: the request is still there (from the server)");

  step("Dan accepts: both are in the ride; Rita sees Dan's car");
  await dan.waitFor(`realPeersById.has(${ritaId}) && realPeersById.get(${ritaId}).pending`, "Dan has the request");
  await dan.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await dan.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  // Rita's location not decided yet when the ride starts (the next step)
  await rita.locationPermission("prompt");
  await dan.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "connected"`, "Rita in the ride");
  await dan.waitFor(`state.ride && state.ride.status === "connected"`, "Dan in the ride");
  // Dan's rider on his map at her real spot: the person-raising-a-hand
  // picture (icons.js) — not the ✋ of someone nearby, and not the emoji
  await dan.waitFor(`(() => { const e = realEntries.get(${ritaId}); return !!e && e.type === "ridepeer" && !!e.marker.getElement().querySelector('img[src^="person.svg"]') && !e.marker.getElement().textContent.includes("\u{1F64B}"); })()`, "Dan's map: his rider, the person picture");
  // a late map update about Dan (his car's block) arriving mid-ride must
  // change nothing of the partner's: his exact ride position, his marker
  await rita.waitFor(`(() => { const e = realEntries.get(${danId}); return !!e && e.type === "ridepeer" && e.peer.posExact; })()`, "Rita has Dan's exact ride position", 15000);
  const before = await rita.eval(`(() => { const p = realEntries.get(${danId}).peer; return { lat: p.pos.lat, lng: p.pos.lng, exact: p.posExact }; })()`);
  await rita.eval(`(upsertBrowseEntry({ id: ${danId}, cell: "882a1072c7fffff", spot: "892a1072c63ffff" }, "driver"), true)`);
  const after = await rita.eval(`(() => { const e = realEntries.get(${danId}); const p = e.peer; return { type: e.type, lat: p.pos.lat, lng: p.pos.lng, exact: p.posExact }; })()`);
  check(after.type === "ridepeer" && after.exact && after.lat === before.lat && after.lng === before.lng, "a late map update mid-ride: Dan's exact position untouched", { before, after });
  await rita.eval(`closeChat(), true`);
  // (then the distance: "· 0.5 mi away")
  await bannerLike(rita, "BT-Dan is on the way · Blue Toyota Prius");
  await bannerHasCar(rita);

  // the other way to the blocked banner beside the button: the ride needs
  // location, it isn't decided yet → the "Share your location" button;
  // then it's blocked in Settings, and the next re-check finds it
  step("location not decided: the Share button; then blocked from Settings: the steps, no button");
  await rita.waitFor(`!!document.getElementById("share-location")`, "the Share your location button");
  await rita.locationPermission("denied");
  await rita.eval(`refreshControls(), true`); // the next screen update re-checks
  await bannerLike(rita, "📍 Location is blocked for Hood Ride");
  check(!(await rita.eval(`!!document.getElementById("share-location")`)), "no Share your location button beside it");

  // owner, 2026-10-30: the blocked banner and the blue "Share your location"
  // button showed together. A ride under way when the app opens asks for
  // location at once, button too; the phone says "blocked" — the button must go
  step("Rita reopens the app mid-ride with location not allowed: blocked steps, no Share button");
  await rita.locationPermission("prompt");
  await rita.open();
  await bannerLike(rita, "📍 Location is blocked for Hood Ride");
  check(!(await rita.eval(`!!document.getElementById("share-location")`)), "no Share your location button beside it");
  check(await rita.eval(`state.ride && state.ride.status === "connected"`), "still in the ride");
  await rita.locationPermission("granted");
  await rita.open();
  await rita.waitFor(`state.ride && state.ride.status === "connected"`, "back in the ride, location allowed");
  await rita.eval(`(clearTimeout(bannerTimer), bannerTimer = null, setBanner(contextBanner()), true)`);

  step("Rita's connection drops: the ride stays on screen, '· Reconnecting…'");
  await dropAndWait(rita);
  await bannerLike(rita, "BT-Dan is on the way · Blue Toyota Prius", " · Reconnecting…");

  step("End ride while disconnected: refused, still in the ride");
  await rita.click("btn-endride");
  await bannerIs(rita, "Can't reach Hood Ride — try again");
  check(await rita.eval(`!!state.ride`), "Rita still in the ride");
  check(await dan.eval(`!!state.ride`), "Dan still in the ride");

  step("back: still in the ride; End ride ends it for both");
  await restoreAndWait(rita);
  await rita.waitFor(`state.ride && state.ride.status === "connected"`, "the ride came back from the server");
  await rita.click("btn-endride");
  await rita.waitFor(`!state.ride`, "Rita's ride ended");
  await dan.waitFor(`!state.ride`, "Dan's ride ended");
});
