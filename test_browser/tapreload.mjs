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

  // the ride ends AND a new one with the same person starts, both while Sam
  // waits for his Meet-here tap and hears neither: the reload brings the new
  // ride — it isn't waiting for a tap he made for the old one
  step("Sam taps 📍 Meet here; his ride ends and a new one with Dora starts, unheard; a reload: the new ride isn't waiting for a tap");
  await onServer(`start_ride ${samId} ${doraId}`);
  await sam.waitFor(`state.ride && state.ride.status === "connected" && !!rideChannel && rideChannel.state === "joined"`, "Sam in the ride");
  const firstRide = await sam.eval("state.ride.id");
  await sam.waitFor(`!document.getElementById("btn-pin").classList.contains("hidden")`, "the Meet here button");
  await sam.click("btn-pin");
  await sam.waitFor("state.pinArmed", "Meet here: waiting for the tap");
  // he hears nothing of it live
  await sam.eval(`(() => {
    rideChannel.leave();
    window.__trigger = userChannel.trigger;
    const on = userChannel.trigger.bind(userChannel);
    userChannel.trigger = (ev, ...a) => (String(ev).startsWith("ride_") ? undefined : on(ev, ...a));
    return true;
  })()`);
  await onServer(`swap_ride ${samId} ${doraId}`);
  check(await sam.eval("state.pinArmed"), "(still waiting for the tap, just before the reload)");
  await sam.eval(`softReload(), true`);
  await sam.waitFor(`hydrated && !reloading && !!state.ride && state.ride.id !== ${JSON.stringify(firstRide)}`, "reloaded: the new ride");
  check(!(await sam.eval("state.pinArmed")), "not waiting for a tap");
  check(!(await sam.banner()).includes("Tap the map"), "no 'Tap the map' line", await sam.banner());
  await sam.eval(`(userChannel.trigger = window.__trigger), true`);

  // at the pickup a driver's app says "I'm here" by itself with every
  // update until the server's answer comes — it was counted each time, and
  // a reload loading meanwhile threw its answer away and asked again, over
  // and over. Here the answer is held back so she keeps saying it
  step("Dora, at the pickup, says 'I'm here' again and again while a reload is loading: the reload still finishes");
  await dora.waitFor(`state.ride && state.ride.status === "connected" && !!rideChannel && rideChannel.state === "joined"`, "Dora in the new ride");
  await dora.eval(`(() => {
    const on = rideChannel.trigger.bind(rideChannel);
    rideChannel.trigger = (ev, ...a) => (ev === "arrived" ? undefined : on(ev, ...a));
    window.__said = 0;
    window.__saying = setInterval(() => { if (reloading) window.__said++; declareArrived(); }, 400);
    return true;
  })()`);
  try {
    await duringReload(dora, async () => {});
  } finally {
    await dora.eval(`clearInterval(window.__saying), true`);
  }
  check((await dora.eval("window.__said")) >= 2, "she kept saying it while it loaded", await dora.eval("window.__said"));
  check(await dora.eval(`!!state.ride && state.ride.status === "arrived"`), "arrived: the reload's answer says so", await dora.eval("state.ride && state.ride.status"));

  // news of the ride partner (a name looked up again) while Sam's list
  // shows, reached by ‹ from her chat: her ROW is redrawn — the heading
  // stays "Chats" (it got her name)
  step("Sam goes ‹ from Dora's chat to his list; news of Dora comes on the ride: the heading still says Chats");
  await sam.eval(`openChat(realPeersById.get(${doraId})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === ${doraId}`, "Dora's chat open");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  const chatsHeading = await sam.eval(`document.getElementById("chat-name").textContent`);
  check(chatsHeading === "Chats", "(the list's heading: Chats)", chatsHeading);
  const rows = () => sam.eval(`[...document.querySelectorAll("#chat-messages .chat-item strong")].map((e) => e.textContent)`);
  const newsOfDora = (name) => sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: ${JSON.stringify(name)}, photo: null }), true)`);
  await newsOfDora("BT-Dora (new)");
  check((await sam.eval(`document.getElementById("chat-name").textContent`)) === chatsHeading, "the heading unchanged", { was: chatsHeading, now: await sam.eval(`document.getElementById("chat-name").textContent`) });
  check((await rows()).includes("BT-Dora (new)"), "her row has the news", await rows());

  // the list reached from someone ELSE's chat: her row is redrawn too
  step("…and with the list reached from someone else's chat: her row has the news");
  await sam.eval(`openChat(ensurePeer({ id: 990011, name: "BT-Other" })), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === 990011`, "BT-Other's chat open");
  // (someone else's chat on screen: its heading is theirs, whatever comes)
  await newsOfDora("BT-Dora (again)");
  check((await sam.eval(`document.getElementById("chat-name").textContent`)) === "BT-Other", "BT-Other's chat: its heading unchanged", await sam.eval(`document.getElementById("chat-name").textContent`));
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await newsOfDora("BT-Dora");
  check((await rows()).includes("BT-Dora"), "her row has the news", await rows());
  await sam.eval(`(closeChat(), chats.delete(realPeersById.get(990011))), true`);

  // her chat on screen: the heading has her new name AND her photo
  step("Dora's chat open; news of Dora with a photo: the heading has her name and photo");
  await sam.eval(`openChat(realPeersById.get(${doraId})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === ${doraId}`, "Dora's chat open");
  const pic = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%228%22%20height%3D%228%22%2F%3E";
  const heading = () => sam.eval(`({ name: document.getElementById("chat-name").textContent, photo: document.getElementById("chat-photo").getAttribute("src"), initialOf: document.getElementById("chat-photo").dataset.name })`);
  await sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: "BT-Dora (pic)", photo: ${JSON.stringify(pic)} }), true)`);
  const head = await heading();
  check(head.name === "BT-Dora (pic)" && head.photo === pic, "her new name and photo", head);
  // no photo: her new name's initial (HoodAvatar)
  await sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: "Zoe", photo: null }), true)`);
  const noPic = await heading();
  const zoeAvatar = await sam.eval(`HoodAvatar.url("Zoe")`);
  check(noPic.name === "Zoe" && noPic.photo === zoeAvatar && noPic.initialOf === "Zoe", "no photo: her new name's initial", noPic);
  await sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: "BT-Dora", photo: null }), closeChat(), true)`);

  // Message hides a card but remembers whose it was: news of her then
  // brought it back up over the chat
  step("Sam opens Dora's card and taps Message; news of Dora comes: her card stays hidden");
  await sam.eval(`openPeerCard(realPeersById.get(${doraId})), true`);
  await sam.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "her card");
  await sam.click("btn-msg");
  await sam.waitFor(`state.chatPeer && state.chatPeer.id === ${doraId} && !document.getElementById("chat").classList.contains("hidden")`, "her chat");
  await sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: "BT-Dora", photo: null }), true)`);
  check(await sam.eval(`document.getElementById("peer-card").classList.contains("hidden")`), "her card stays hidden");
  await sam.eval(`closeChat(), true`);

  step("Sam's looking at Dora's card; news of Dora comes: the card shows it");
  await sam.eval(`openPeerCard(realPeersById.get(${doraId})), true`);
  await sam.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "her card");
  await sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: "BT-Dora (card)", photo: null }), true)`);
  const card = await sam.eval(`({ open: !document.getElementById("peer-card").classList.contains("hidden"), text: document.getElementById("peer-card").textContent })`);
  check(card.open && card.text.includes("BT-Dora (card)"), "the card still open, with the news", card);
  await sam.eval(`(rideChannel.trigger("peer", { id: ${doraId}, name: "BT-Dora", photo: null }), closePeerCard()), true`);

  await sam.click("btn-endride");
  await sam.waitFor(`!state.ride`, "the new ride ended");
});
