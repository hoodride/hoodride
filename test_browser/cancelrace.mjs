// A rider's Cancel just after the driver's Accept (leftovers review,
// 2026-11-13): the app cleared the request and said "Request cancelled" at
// once, before the server answered — then the ride opened anyway, the
// driver on the way. Now the app waits for the server: "accepted" (the
// ride's already starting) — no "Request cancelled", the ride comes.
// (HoodrideWeb.CancelAcceptRaceTest: the server's side)
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

const AWAY = { latitude: HOME.latitude + 0.006, longitude: HOME.longitude };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await journey("cancelrace: Cancel just after the Accept — never 'Request cancelled', the ride comes", async (browser) => {
  step("Rita (rider) and Dan (driver, online, a few blocks away)");
  const rita = await browser.person("BT-Rita");
  const dan = await browser.person("BT-Dan", AWAY);
  await goOnline(dan, { color: "Gray", make: "Honda", model: "Civic" });
  const ritaId = await rita.id();
  const danId = await dan.id();
  await sees(rita, danId);

  step("Rita asks Dan for a ride");
  await openChatWith(rita, danId);
  await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await rita.eval(`closeChat(), true`);

  step("Dan accepts — but the news hasn't reached Rita's phone yet (held back)");
  await rita.eval(`(() => {
    window.__held = [];
    const t = userChannel.trigger.bind(userChannel);
    window.__trigger = t;
    userChannel.trigger = (ev, ...a) => (ev === "ride_started" ? void window.__held.push([ev, ...a]) : t(ev, ...a));
    // what the server answers her Cancel
    const push = userChannel.push.bind(userChannel);
    userChannel.push = (ev, ...a) => {
      const p = push(ev, ...a);
      if (ev === "cancel_request") p.receive("ok", () => (window.__cancelReply = "ok")).receive("error", (e) => (window.__cancelReply = e.reason));
      return p;
    };
    return true;
  })()`);
  await dan.waitFor(`realPeersById.has(${ritaId}) && realPeersById.get(${ritaId}).pending`, "Dan has the request");
  await dan.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await dan.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await dan.click("btn-ride-action");
  await dan.waitFor(`state.ride && state.ride.status === "connected"`, "Dan in the ride");
  await rita.waitFor(`window.__held.length === 1`, "the ride's news reached Rita's phone (held back)");

  step("Rita taps Cancel: the server says the driver already accepted — no 'Request cancelled'");
  await rita.click("btn-endride");
  const reply = await rita.waitFor(`window.__cancelReply`, "the server's answer");
  check(reply === "accepted", "the answer: already accepted", reply);
  await sleep(300);
  const banner = await rita.eval(`document.getElementById("banner").textContent`);
  check(!banner.includes("Request cancelled"), "never 'Request cancelled'", banner);
  check(await rita.eval(`!!state.ride`), "her request isn't dropped");

  step("the news never reaches her phone: within seconds the app asks the server itself — Rita's in the ride");
  // (crash review 2026-11-14: "accepted" and then nothing — the ride's start
  // failed after all, or its news was lost — left the Cancel doing nothing)
  await rita.waitFor(`state.ride && state.ride.status === "connected"`, "Rita in the ride, from the server", 15000);
  check((await rita.eval(`window.__held.length`)) >= 1, "(the live news never got through)");
  await rita.eval(`(userChannel.trigger = window.__trigger, true)`);
});
