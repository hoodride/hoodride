// What you do while the app reloads stays done (owner, 2026-11-07): every
// join of the connection reloads the app from the server (/api/state) —
// right after opening it, and after any blip. Something done while that
// reload's answer was on its way was undone by it (the answer was from just
// before): a ✋ down on your screen while every driver still saw it (found by
// findnearest.mjs, which taps ✋ the moment the app opens); a message gone
// from your chat though it was delivered.
// Here the reload's answer is made slow (the question reaches the server at
// once), and the tap lands while it's on its way.
import { journey, step, check, server as onServer } from "./cdp.mjs";
import { bannerLike, goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

// a reload as a rejoin starts one, its answer 1.5 s on the way; `act` while
// it's loading; then wait until it's applied
async function duringReload(p, act) {
  await p.waitFor("hydrated && !reloading", `${p.name}: the app loaded`);
  await p.eval(`(() => {
    if (!window.__slowState) {
      const f = window.fetch;
      window.fetch = (u, o) => String(u).includes("/api/state") ? f(u, o).then((r) => new Promise((ok) => setTimeout(() => ok(r), 1500))) : f(u, o);
      window.__slowState = true;
    }
    softReload();
    return true;
  })()`);
  await p.waitFor("reloading", `${p.name}: reloading`);
  await new Promise((r) => setTimeout(r, 300));
  await act();
  await p.waitFor("!reloading", `${p.name}: the reload applied`, 15000);
  await new Promise((r) => setTimeout(r, 300));
}
// Dora drives: her phone's location moves a couple of blocks every half
// second, until stopped (then she's back where she started)
const DORA_AT = { latitude: 40.7214, longitude: -74.0086 };
function drive(p) {
  let on = true;
  const loop = (async () => {
    for (let i = 1; on; i++) {
      await p.locate({ latitude: DORA_AT.latitude + (i % 10) * 0.002, longitude: DORA_AT.longitude });
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return async () => {
    on = false;
    await loop;
    await p.locate(DORA_AT);
  };
}
// a reload (its answer 1.5 s slow, as above) while she drives: it must
// still finish — her position updates, every ~1.5 s, aren't news (if they
// were, every answer would be "overtaken" and asked for again, for as long
// as she drives). Counted, so the test can't pass with no updates sent.
async function reloadWhileDriving(p, event, channel) {
  await p.waitFor("hydrated && !reloading", `${p.name}: the app loaded`);
  await p.eval(`(() => {
    window.__sent = 0;
    const ch = ${channel};
    const push = ch.push.bind(ch);
    ch.push = (e, ...a) => { if (e === ${JSON.stringify(event)} && reloading) window.__sent++; return push(e, ...a); };
    return true;
  })()`);
  const stop = drive(p);
  await new Promise((r) => setTimeout(r, 1500));
  await p.eval(`(() => {
    if (!window.__slowState) {
      const f = window.fetch;
      window.fetch = (u, o) => String(u).includes("/api/state") ? f(u, o).then((r) => new Promise((ok) => setTimeout(() => ok(r), 1500))) : f(u, o);
      window.__slowState = true;
    }
    softReload();
    return true;
  })()`);
  try {
    await p.waitFor("reloading", `${p.name}: reloading`);
    await p.waitFor("!reloading", `${p.name}: the reload finished while she drove`, 9000);
  } finally {
    await stop();
  }
  const sent = await p.eval("window.__sent");
  check(sent >= 2, `her position went out while it loaded (${event})`, sent);
}

const server = (p) => p.eval(`window.fetch("/api/state").then(r => r.json()).then(s => ({ hand: !!s.hand, onMap: !!s.on_map }))`);

await journey("tapreload: what you do while the app reloads stays done", async (browser) => {
  step("Sam (rider) taps ✋ while a reload is loading: up on his screen AND on the server");
  const sam = await browser.person("BT-Sam");
  await duringReload(sam, () => sam.click("btn-hand"));
  check(await sam.eval("state.handRaised"), "✋ up on Sam's screen");
  check((await server(sam)).hand, "✋ up on the server");
  await bannerLike(sam, "✋ Nearby drivers can see you need a ride");

  step("…and ✋ down while another reload is loading: down on both");
  await duringReload(sam, () => sam.click("btn-hand"));
  check(!(await sam.eval("state.handRaised")), "✋ down on Sam's screen");
  check(!(await server(sam)).hand, "✋ down on the server");

  step("Dora (driver, car known) taps Go online while a reload is loading: online on both");
  const dora = await browser.person("BT-Dora", DORA_AT);
  const car = { color: "Gray", make: "Honda", model: "Civic" };
  check(await dora.eval(`fetch("/api/car", {method: "POST", headers: {"content-type": "application/json"}, body: ${JSON.stringify(JSON.stringify(car))}}).then(r => r.ok)`), "Dora's car saved");
  await dora.open();
  await dora.click("btn-mode");
  await dora.waitFor(`state.mode === "driver" && state.myCar !== undefined`, "Dora: driver mode, car known");
  await duringReload(dora, () => dora.click("btn-online"));
  check(await dora.eval("state.online"), "online on Dora's screen");
  check((await server(dora)).onMap, "her car on the map (server)");
  await bannerLike(dora, "🟢 You're online");

  step("Dora drives (online) while a reload is loading: it still finishes");
  await reloadWhileDriving(dora, "driver_update", "userChannel");

  step("Sam sends Dora a message while a reload is loading: it stays in his chat (and she gets it)");
  const [doraId, samId] = [await dora.id(), await sam.id()];
  await sees(sam, doraId);
  await openChatWith(sam, doraId);
  await duringReload(sam, async () => {
    await typeText(sam, "on my way out");
    await send(sam);
  });
  const mine = await sam.eval(`chatFor(realPeersById.get(${doraId})).msgs.filter((m) => m.mine).map((m) => m.text)`);
  check(mine.includes("on my way out"), "in Sam's chat", mine);
  await dora.waitFor(`realPeersById.has(${samId}) && chatFor(realPeersById.get(${samId})).msgs.some((m) => m.text === "on my way out")`, "Dora got it");

  step("Sam taps Request ride while a reload is loading: still waiting on his screen");
  await sam.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await duringReload(sam, () => sam.click("btn-ride-action"));
  check(await sam.eval(`!!state.ride && state.ride.status === "requested"`), "requested on Sam's screen", await sam.eval("state.ride && state.ride.status"));
  await dora.waitFor(`document.getElementById("btn-ride-action") && chatFor(realPeersById.get(${samId})).msgs.length > 0 && realPeersById.get(${samId}).pending`, "Dora sees the request", 15000);

  step("Sam cancels the request while a reload is loading: cancelled on his screen (and Dora's)");
  await duringReload(sam, () => sam.click("btn-endride"));
  check(!(await sam.eval("state.ride")), "no request on Sam's screen", await sam.eval("state.ride && state.ride.status"));
  await dora.waitFor(`!realPeersById.get(${samId}).pending`, "Dora's request from Sam gone");

  // asks again, normally — then the driver's side
  const requestAgain = async () => {
    await onServer("cooldown_over"); // (a cancel or a decline: a minute before asking the same driver again)
    await sam.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
    await sam.click("btn-ride-action");
    await sam.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
    await dora.waitFor(`realPeersById.get(${samId}).pending`, "Dora has the request", 15000);
  };
  await requestAgain();

  step("Dora declines while a reload is loading: gone from her screen (and Sam's)");
  await dora.eval(`openChat(realPeersById.get(${samId})), true`);
  await dora.waitFor(`!document.getElementById("btn-decline").classList.contains("hidden")`, "the Decline button");
  await duringReload(dora, () => dora.click("btn-decline"));
  check(!(await dora.eval(`realPeersById.get(${samId}).pending`)), "no request on Dora's screen");
  check(await dora.eval(`document.getElementById("btn-decline").classList.contains("hidden")`), "no Decline button");
  await sam.waitFor(`!state.ride`, "Sam's request gone (declined)");
  await dora.eval(`closeChat(), true`);
  await requestAgain();

  step("Dora accepts while a reload is loading: both in the ride");
  await dora.eval(`openChat(realPeersById.get(${samId})), true`);
  await dora.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await duringReload(dora, () => dora.click("btn-ride-action"));
  await dora.waitFor(`state.ride && state.ride.status === "connected"`, "Dora in the ride");
  await sam.waitFor(`state.ride && state.ride.status === "connected"`, "Sam in the ride");
  await dora.eval(`closeChat(), true`);
  await sam.eval(`closeChat(), true`);

  // the ride's own connection (rideChannel): the meetup pin, End ride
  step("Dora drives (in the ride) while a reload is loading: it still finishes");
  await reloadWhileDriving(dora, "pos", "rideChannel");

  step("Sam sets the meetup pin while a reload is loading: it stays, on both");
  const pin = { lat: 40.7172, lng: -74.0101 };
  await duringReload(sam, () => sam.eval(`placePin(${JSON.stringify(pin)}), true`));
  const near = (p) => p.eval(`!!state.pinPos && Math.abs(state.pinPos.lat - ${pin.lat}) < 1e-6 && Math.abs(state.pinPos.lng - ${pin.lng}) < 1e-6`);
  check(await near(sam), "the pin on Sam's screen", await sam.eval("state.pinPos"));
  await dora.waitFor(`!!state.pinPos`, "the pin on Dora's screen");
  check(await near(dora), "at Sam's spot", await dora.eval("state.pinPos"));

  step("Sam removes the pin while a reload is loading: gone, on both");
  await duringReload(sam, () => sam.eval(`clearPin(), true`));
  check(!(await sam.eval("state.pinPos")), "no pin on Sam's screen", await sam.eval("state.pinPos"));
  await dora.waitFor(`!state.pinPos`, "no pin on Dora's screen");

  // 📍 Meet here waits for your tap on the map — the server doesn't know
  // that: a reload in between used to forget it, while the line still said
  // "Tap the map where you want to meet" (and the tap did nothing)
  step("Sam taps 📍 Meet here, a reload comes, then he taps the map: the pin lands there");
  const tapMap = (p, dLat, dLng) =>
    p.eval(`(() => { const c = map.getCenter(); const ll = { lng: c.lng + ${dLng}, lat: c.lat + ${dLat} }; map.fire("click", { lngLat: ll, point: map.project(ll), originalEvent: new MouseEvent("click") }); return { lat: ll.lat, lng: ll.lng }; })()`);
  await sam.click("btn-pin");
  await sam.waitFor("state.pinArmed && !map.isMoving()", "Meet here: waiting for the tap");
  await sam.eval(`softReload(), true`);
  await sam.waitFor("hydrated && !reloading", "reloaded");
  check(await sam.eval("state.pinArmed"), "still waiting for the tap");
  await bannerLike(sam, "📍 Tap the map where you want to meet");
  // Dora drives meanwhile: her position updates mustn't write over the hint
  // (they did, within a second — no reload needed)
  for (const lat of [40.7206, 40.7198]) {
    await dora.locate({ latitude: lat, longitude: -74.0086 });
    await sam.waitFor(`!!state.ride.peer.pos && Math.abs(state.ride.peer.pos.lat - ${lat}) < 0.0005`, "Dora's new position on Sam's map", 10000);
    await new Promise((r) => setTimeout(r, 300));
    check((await sam.banner()) === "📍 Tap the map where you want to meet", "the hint stays while Dora drives", await sam.banner());
  }
  const spot = await tapMap(sam, 0.0005, 0.001);
  await sam.waitFor(`!!state.pinPos && Math.abs(state.pinPos.lat - ${spot.lat}) < 1e-6 && Math.abs(state.pinPos.lng - ${spot.lng}) < 1e-6`, "the pin where Sam tapped");
  await dora.waitFor(`!!state.pinPos && Math.abs(state.pinPos.lat - ${spot.lat}) < 1e-6`, "…on Dora's screen too");
  // placed (its "Meetup spot set" note gone): the distance comes back with
  // her next position
  await bannerLike(sam, "BT-Dora is on the way");
  await dora.locate({ latitude: 40.719, longitude: -74.0086 });
  await bannerLike(sam, "BT-Dora is on the way", " away", "the distance back");

  step("Dora taps I'm here while a reload is loading: arrived, on both");
  await dora.waitFor(`!document.getElementById("btn-arrived").classList.contains("hidden")`, "the I'm here button");
  await duringReload(dora, () => dora.click("btn-arrived"));
  check(await dora.eval(`!!state.ride && state.ride.status === "arrived"`), "arrived on Dora's screen", await dora.eval("state.ride && state.ride.status"));
  await sam.waitFor(`state.ride && state.ride.status === "arrived"`, "arrived on Sam's screen");

  step("Sam ends the ride while a reload is loading: over, on both");
  await duringReload(sam, () => sam.click("btn-endride"));
  check(!(await sam.eval("state.ride")), "over on Sam's screen", await sam.eval("state.ride && state.ride.status"));
  await dora.waitFor(`!state.ride`, "over on Dora's screen");

  step("Dora goes online again (a ride takes the driver off the map)");
  await dora.waitFor(`!state.online && document.getElementById("btn-online") && !document.getElementById("btn-online").classList.contains("hidden")`, "Dora's GO ONLINE back");
  await dora.click("btn-online");
  await dora.waitFor(`state.online`, "Dora online again");

  // the ride ends while Sam's map waits for his tap, and he only learns it
  // from a reload: no "Tap the map" left on screen
  step("a new ride; Sam taps 📍 Meet here; the ride ends behind his back; a reload: no 'Tap the map' left over");
  await sam.eval(`openChat(realPeersById.get(${doraId})), true`);
  await requestAgain();
  await dora.eval(`openChat(realPeersById.get(${samId})), true`);
  await dora.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await dora.click("btn-ride-action");
  await sam.waitFor(`state.ride && state.ride.status === "connected" && !!rideChannel && rideChannel.state === "joined"`, "Sam in the ride");
  await sam.eval(`closeChat(), true`);
  await dora.eval(`closeChat(), true`);
  await sam.waitFor(`!document.getElementById("btn-pin").classList.contains("hidden")`, "the Meet here button");
  await sam.click("btn-pin");
  await sam.waitFor("state.pinArmed", "Meet here: waiting for the tap");
  await sam.eval(`rideChannel.leave(), true`); // (he doesn't hear the ride end live)
  await dora.click("btn-endride");
  await dora.waitFor(`!state.ride`, "over on Dora's screen");
  await sam.eval(`softReload(), true`);
  await sam.waitFor("hydrated && !reloading && !state.ride", "reloaded: no ride");
  check(!(await sam.eval("state.pinArmed")), "not waiting for a tap");
  check(!(await sam.banner()).includes("Tap the map"), "no 'Tap the map' line", await sam.banner());
  await dora.waitFor(`!state.online && !document.getElementById("btn-online").classList.contains("hidden")`, "Dora's GO ONLINE back");
  await dora.click("btn-online");
  await dora.waitFor(`state.online`, "Dora online again");

  step("Dora goes offline while a reload is loading: offline on both");
  await duringReload(dora, () => dora.click("btn-online"));
  check(!(await dora.eval("state.online")), "offline on Dora's screen");
  check(!(await server(dora)).onMap, "her car off the map (server)");
});
