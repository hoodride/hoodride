// The middle of a ride and the ways a request ends (owner, 2026-10-30):
// a driver declines; "Too late" when the rider cancelled just as the
// driver tapped Accept; then a ride — Navigate goes to the rider, the 📍
// pin moves it, "I'm here".
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, bannerIs, bannerLike, bannerHasCar, showsIcon } from "./app.mjs";

// a few blocks away (at the rider's own spot a driver has "arrived" at once)
const AWAY = { latitude: HOME.latitude + 0.006, longitude: HOME.longitude };

async function request(rita, driverId) {
  await openChatWith(rita, driverId);
  await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await rita.eval(`closeChat(), true`);
}

async function openRequest(driver, ritaId) {
  await driver.waitFor(`realPeersById.has(${ritaId}) && realPeersById.get(${ritaId}).pending`, `${driver.name} has the request`);
  await driver.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await driver.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
}

await journey("ride details: decline, too late, Navigate, the pin, I'm here", async (browser) => {
  step("Rita (rider); Dan, Eve and Finn (drivers, online, a few blocks away)");
  const rita = await browser.person("BT-Rita");
  const dan = await browser.person("BT-Dan", AWAY);
  const eve = await browser.person("BT-Eve", AWAY);
  const finn = await browser.person("BT-Finn", AWAY);
  await goOnline(dan, { color: "Gray", make: "Honda", model: "Civic" });
  await goOnline(eve, { color: "Red", make: "Kia", model: "Soul" });
  await goOnline(finn, { color: "Blue", make: "Toyota", model: "Prius" });
  const ritaId = await rita.id();
  const [danId, eveId, finnId] = [await dan.id(), await eve.id(), await finn.id()];
  for (const id of [danId, eveId, finnId]) await sees(rita, id);

  step("Rita asks Dan; Dan declines: Rita is told, no longer waiting");
  await request(rita, danId);
  await openRequest(dan, ritaId);
  await dan.click("btn-decline");
  await bannerIs(dan, "Request declined");
  await bannerIs(rita, "Driver can't take this one — try another");
  check(await rita.eval(`!state.ride`), "Rita no longer waiting");

  step("Rita asks Eve, then cancels just as Eve taps Accept: 'Too late'");
  await request(rita, eveId);
  await openRequest(eve, ritaId);
  // the cancel is still on its way to Eve: she still sees Accept
  await eve.eval(`(() => { const t = userChannel.trigger.bind(userChannel); userChannel.trigger = (ev, ...a) => (ev === "request_cancelled" ? ((window.__cancelHeld = true), undefined) : t(ev, ...a)); return true; })()`);
  await rita.click("btn-endride");
  await bannerIs(rita, "Request cancelled");
  // Rita's banner shows at once, before the server has her cancel: Eve taps
  // only once the server has it (its notice reached her phone, held back) —
  // else her Accept can arrive first and rightly win (gate, 2026-11-02)
  await eve.waitFor(`window.__cancelHeld === true`, "the cancel reached the server (Eve's notice held back)");
  await eve.click("btn-ride-action");
  await bannerIs(eve, "Too late — the request was withdrawn");
  check(await eve.eval(`!state.ride`), "Eve isn't in a ride");

  step("Rita asks Finn; he accepts: both in the ride");
  await request(rita, finnId);
  await openRequest(finn, ritaId);
  // Rita's GPS is slow: her phone doesn't send her exact position yet (the
  // one gate for it: HoodRidePos.mayAnnounce) — Navigate must wait for it
  await rita.eval(`(window.__mayAnnounce = HoodRidePos.mayAnnounce, HoodRidePos.mayAnnounce = () => false, true)`);
  await finn.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "connected"`, "Rita in the ride");
  await finn.waitFor(`state.ride && state.ride.status === "connected"`, "Finn in the ride");
  await finn.eval(`closeChat(), true`);

  step("Finn taps Navigate before Rita's exact location is in: told so, nothing opens — never her block centre");
  // (owner, 2026-11-02: it went to the centre of her block)
  await finn.waitFor(`!document.getElementById("btn-navigate").classList.contains("hidden")`, "Navigate shown");
  // the case the bug hit: her BLOCK CENTRE known (as from her ✋ on his
  // map), her exact spot not yet — here she asked without a ✋, so it's set
  const centre = await finn.eval(`(() => { const [lat, lng] = h3.cellToLatLng(h3.latLngToCell(40.7154, -74.0086, H3_DISPLAY_RES)); state.ride.peer.pos = { lat, lng }; return state.ride.peer.pos; })()`);
  check(await finn.eval(`!state.ride.peer.posExact && !!state.ride.peer.pos`), "only her block centre known yet", centre);
  const early = await finn.eval(`(() => { const a = document.getElementById("btn-navigate"); let followed = true; const see = (e) => { followed = !e.defaultPrevented; e.preventDefault(); }; a.addEventListener("click", see); a.click(); a.removeEventListener("click", see); return { followed, href: a.getAttribute("href") }; })()`);
  check(!early.followed, "the tap opens nothing", early);
  check(!(await finn.eval(`!document.getElementById("nav-sheet").classList.contains("hidden")`)), "no map-app box either");
  await bannerIs(finn, "🧭 Waiting for BT-Rita's exact location — or ask them to set a 📍 meeting spot");

  step("still no exact location: Rita sets a 📍 — Navigate goes there at once; she removes it — waiting again");
  // (owner, 2026-11-02: the pin wins even before her exact spot is known)
  await rita.click("btn-pin");
  await bannerIs(rita, "📍 Tap the map where you want to meet");
  await rita.waitFor(`!map.isMoving()`, "Rita's map settled");
  await rita.tapAt(700, 400);
  const earlyPin = await finn.waitFor(`state.ride.peer.pin`, "Finn has the early pin");
  check(await finn.eval(`!state.ride.peer.posExact`), "her exact spot still unknown");
  // no map app chosen yet: the box's Google Maps choice is where Navigate goes
  await finn.eval(`(() => { const a = document.getElementById("btn-navigate"); const stop = (e) => e.preventDefault(); a.addEventListener("click", stop); a.click(); a.removeEventListener("click", stop); return true; })()`);
  await finn.waitFor(`!document.getElementById("nav-sheet").classList.contains("hidden")`, "the map-app box, for the pin");
  // it says where to change it later, in words on screen — no "Settings" (owner, 2026-11-03)
  const navHint = await finn.eval(`document.querySelector("#nav-sheet p").innerText`);
  check(navHint === "Change it anytime: tap your profile picture at the top left, then Navigation app", "the box: where to change it", { navHint });
  const viaEarlyPin = await finn.eval(`document.getElementById("nav-google").href`);
  check(viaEarlyPin === `https://www.google.com/maps/dir/?api=1&destination=${earlyPin.lat}%2C${earlyPin.lng}`, "Navigate: to the pin", { viaEarlyPin, earlyPin });
  await finn.click("nav-cancel");
  // Rita taps her pin: removed — Finn's 📍 goes, and Navigate waits again.
  // (her phone draws it on the server's "pin" too, as Finn's does — which
  // of them hears it first is chance: under a full run's load Finn could,
  // and the tap found no pin. Waited for, as a person sees it before tapping)
  await rita.waitFor(`state.pinPos && !!document.querySelector(".marker-pin")`, "Rita's own pin on her map");
  await rita.eval(`document.querySelector(".marker-pin").click(), true`);
  await bannerIs(rita, "📍 Pin removed — your driver will come to you");
  await finn.waitFor(`!state.ride.peer.pin && !(pinMarker && pinMarker._map)`, "Finn: the pin gone, from his map too");
  const again = await finn.eval(`(() => { const a = document.getElementById("btn-navigate"); let followed = true; const see = (e) => { followed = !e.defaultPrevented; e.preventDefault(); }; a.addEventListener("click", see); a.click(); a.removeEventListener("click", see); return followed; })()`);
  check(!again, "Navigate opens nothing again");
  await bannerIs(finn, "🧭 Waiting for BT-Rita's exact location — or ask them to set a 📍 meeting spot");

  // her GPS comes good: her exact position goes out
  await rita.eval(`(HoodRidePos.mayAnnounce = window.__mayAnnounce, true)`);

  // Navigate is a real link: what it opens is its address once tapped
  const navigate = (p) =>
    p.eval(`(() => { const a = document.getElementById("btn-navigate"); const stop = (e) => e.preventDefault(); a.addEventListener("click", stop); a.click(); a.removeEventListener("click", stop); return a.href; })()`);

  // a choice in the map-app box: what it opens, the tap taken (not followed)
  const pick = (p, id) =>
    p.eval(`(() => { const a = document.getElementById(${JSON.stringify(id)}); const stop = (e) => e.preventDefault(); a.addEventListener("click", stop); a.click(); a.removeEventListener("click", stop); return a.href; })()`);
  const sheetOpen = `!document.getElementById("nav-sheet").classList.contains("hidden")`;

  step("Finn taps Navigate the first time: asked which map app — each a link to Rita; he picks Waze");
  // (owner, 2026-11-02: the driver's own app, as Uber's drivers pick theirs)
  await finn.waitFor(`state.ride.peer.posExact && !document.getElementById("btn-navigate").classList.contains("hidden")`, "Rita's exact position, Navigate shown", 15000);
  // the icons are pictures (icons.js), not emoji
  check(await showsIcon(finn, "#btn-navigate", "compass.svg"), "Navigate: the compass picture");
  await navigate(finn);
  await finn.waitFor(sheetOpen, "the map-app box");
  const shown = await finn.eval(`[...document.querySelectorAll(".nav-choice")].filter((a) => !a.classList.contains("hidden")).map((a) => a.textContent)`);
  check(JSON.stringify(shown) === JSON.stringify(["Google Maps", "Waze"]), "Google Maps and Waze (Apple Maps only on iPhone)", shown);
  const viaGoogle = await finn.eval(`document.getElementById("nav-google").href`);
  check(viaGoogle.startsWith("https://www.google.com/maps/dir/?api=1&destination=40.715"), "Google Maps: directions to Rita", viaGoogle);
  const toRita = await pick(finn, "nav-waze");
  check(toRita.startsWith("https://waze.com/ul?ll=40.715") && toRita.endsWith("&navigate=yes"), "Waze: to Rita, navigation on", toRita);
  await finn.waitFor(`!(${sheetOpen})`, "the box closed");
  check((await finn.eval(`localStorage.getItem("hoodride_navapp")`)) === "waze", "remembered on this phone");

  step("Navigate again: straight to Waze, not asked");
  check((await navigate(finn)) === toRita, "Waze, to Rita");
  check(!(await finn.eval(sheetOpen)), "no box this time");

  step("Rita sets a 📍 meeting spot with a tap on the map: Finn has it, Navigate goes there");
  check(await showsIcon(rita, "#btn-pin", "pin.svg"), "Meet here: the pin picture");
  await rita.click("btn-pin");
  await bannerIs(rita, "📍 Tap the map where you want to meet");
  check(await showsIcon(rita, "#banner", "pin.svg"), "the banner: the pin picture");
  await rita.waitFor(`!map.isMoving()`, "the map settled on Rita");
  await rita.tapAt(800, 450);
  await bannerIs(rita, "📍 Meetup spot set — your driver sees it");
  const pin = await finn.waitFor(`state.ride.peer.pin`, "Finn has the pin");
  // Rita's own pin is drawn when the server's "pin" comes back to her too
  // (both sides the same) — Finn may have his first: wait for hers
  await rita.waitFor(`state.pinPos && !!document.querySelector(".marker-pin")`, "Rita's pin on her map");
  check(await showsIcon(rita, ".marker-pin", "pin.svg"), "the pin on the map: the picture");
  check(await showsIcon(rita, "#btn-pin", "pin.svg"), "Move pin: the pin picture");
  const toPin = await navigate(finn);
  check(toPin === `https://waze.com/ul?ll=${pin.lat}%2C${pin.lng}&navigate=yes`, "Navigate goes to the pin (in Waze)", { toPin, pin });
  check(toPin !== toRita, "not to Rita any more");
  // Finn's map shows BOTH at once (owner, 2026-11-02): where they'll meet
  // (📍) and where Rita is now (🙋, her exact live spot) — the pin hides
  // nothing
  const both = await finn.waitFor(
    `(() => {
      const pinOn = !!pinMarker && !!pinMarker._map;
      const pll = pinOn && pinMarker.getLngLat();
      const entry = realEntries.get(state.ride.peer.id);
      const her = entry && entry.type === "ridepeer" && entry.marker._map ? entry.marker : null;
      const hll = her && her.getLngLat();
      const ok = pinOn && Math.abs(pll.lat - ${pin.lat}) < 1e-9 && Math.abs(pll.lng - ${pin.lng}) < 1e-9 &&
        !!her && !!her.getElement().querySelector('img[src^="person.svg"]') && state.ride.peer.posExact &&
        Math.abs(hll.lat - state.ride.peer.pos.lat) < 1e-9 && Math.abs(hll.lng - state.ride.peer.pos.lng) < 1e-9;
      return ok ? { pin: [pll.lat, pll.lng], rita: [hll.lat, hll.lng] } : null;
    })()`,
    "Finn's map: the 📍 at the pin AND Rita's 🙋 at her exact spot"
  );
  check(both.pin[0] !== both.rita[0] || both.pin[1] !== both.rita[1], "two different places", both);

  step("Finn changes it in Settings: Google Maps — only the choice, nothing opens");
  await finn.click("btn-account");
  await finn.waitFor(`document.getElementById("navapp-note").textContent === "Waze"`, "Settings: Navigation app, Waze");
  await finn.click("btn-navapp");
  await finn.waitFor(sheetOpen, "the map-app box, from Settings");
  check((await finn.eval(`document.getElementById("nav-google").getAttribute("href")`)) === "#", "from Settings, the choices go nowhere");
  await finn.click("nav-google");
  await finn.waitFor(`!(${sheetOpen}) && localStorage.getItem("hoodride_navapp") === "google"`, "Google Maps chosen");
  check(await finn.eval(`location.pathname === "/" && !!state.ride`), "still in the app, in the ride");
  check((await navigate(finn)) === `https://www.google.com/maps/dir/?api=1&destination=${pin.lat}%2C${pin.lng}`, "Navigate: Google Maps now, to the pin");

  step("Rita moves the 📍: Navigate follows the new spot");
  // (owner, 2026-11-02: every way the pin changes, tested)
  await rita.click("btn-pin");
  await rita.waitFor(`state.pinArmed`, "Move pin: armed");
  await rita.waitFor(`!map.isMoving()`, "Rita's map settled");
  await rita.tapAt(900, 520);
  const moved = await finn.waitFor(`state.ride.peer.pin && (state.ride.peer.pin.lat !== ${pin.lat} || state.ride.peer.pin.lng !== ${pin.lng}) ? state.ride.peer.pin : null`, "Finn has the moved pin");
  check((await navigate(finn)) === `https://www.google.com/maps/dir/?api=1&destination=${moved.lat}%2C${moved.lng}`, "Navigate: to the moved pin", moved);
  check(await finn.eval(`(() => { const ll = pinMarker.getLngLat(); return Math.abs(ll.lat - ${moved.lat}) < 1e-9 && Math.abs(ll.lng - ${moved.lng}) < 1e-9; })()`), "Finn's 📍 moved too");

  step("Rita removes the 📍: it leaves Finn's map, and Navigate goes back to her exact spot");
  await rita.eval(`document.querySelector(".marker-pin").click(), true`);
  await bannerIs(rita, "📍 Pin removed — your driver will come to you");
  await finn.waitFor(`!state.ride.peer.pin && !(pinMarker && pinMarker._map)`, "Finn: the pin gone, from his map too");
  const exactNow = await finn.eval(`state.ride.peer.posExact ? state.ride.peer.pos : null`);
  check(!!exactNow, "her exact spot known", exactNow);
  check((await navigate(finn)) === `https://www.google.com/maps/dir/?api=1&destination=${exactNow.lat}%2C${exactNow.lng}`, "Navigate: back to Rita", exactNow);

  step("Rita's phone stops updating: Navigate still goes to her last spot, and says how old it is");
  // her last position, as if it came in 200 s ago (no new one since)
  await finn.eval(`(state.ride.peer.posRx = { ...state.ride.peer.posRx, ageAtArrival: 200000, arrivedAt: performance.now() }, true)`);
  check((await navigate(finn)) === `https://www.google.com/maps/dir/?api=1&destination=${exactNow.lat}%2C${exactNow.lng}`, "Navigate: her last spot");
  await bannerIs(finn, "🧭 BT-Rita was last seen there 3 min ago");

  step("Finn taps I'm here: both see it");
  await finn.click("btn-arrived");
  await bannerLike(rita, "BT-Finn has arrived · Blue Toyota Prius");
  await bannerHasCar(rita);
  await finn.waitFor(`state.ride.status === "arrived"`, "Finn: arrived");

  step("the ride ends");
  await rita.click("btn-endride");
  await rita.waitFor(`!state.ride`, "Rita's ride ended");
  await finn.waitFor(`!state.ride`, "Finn's ride ended");
});
