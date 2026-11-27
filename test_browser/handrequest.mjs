// A ✋ raised, then a request — a reconnect meanwhile (final review,
// 2026-11-26): the server still has her ✋; the reload forgot it (restored
// only with no request). The driver then declines: her button said
// "✋ Need a ride" while every driver still saw her ✋ — till the next
// reconnect. As live: the ✋ stays hers through the request.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("handrequest: ✋ up, a request, a reconnect, a decline — her ✋ still hers on screen, as on the server", async (browser) => {
  step("Hil raises ✋, then asks Jon; a reload meanwhile");
  const hil = await browser.person("BT-HandHil");
  const jon = await browser.person("BT-HandJon", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(jon);
  const [jonId, hilId] = [await jon.id(), await hil.id()];
  await hil.click("btn-hand");
  await hil.waitFor(`state.handRaised`, "✋ up");
  await sees(hil, jonId, "(Jon's car)");
  await openChatWith(hil, jonId);
  await hil.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await hil.click("btn-ride-action");
  await hil.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await jon.waitFor(`realPeersById.get(${hilId}) && realPeersById.get(${hilId}).pending === true`, "Jon has it");
  await hil.eval(`(softReload(), true)`);
  await hil.waitFor(`hydrated && !reloading && state.ride && state.ride.status === "requested"`, "reloaded: still requested", 10000);
  check((await hil.eval(`state.handRaised`)) === true, "her ✋ still hers after the reload (the server has it)");

  step("Jon declines: her ✋ is up, on screen as on the server");
  await jon.eval(`(openChat(realPeersById.get(${hilId})), true)`);
  await jon.waitFor(`!document.getElementById("btn-decline").classList.contains("hidden")`, "Decline");
  await jon.click("btn-decline");
  await hil.waitFor(`!state.ride`, "declined");
  check((await hil.eval(`state.handRaised`)) === true, "✋ still up on her screen");
  check(hil.errors.length === 0 && jon.errors.length === 0, "no page errors", [hil.errors, jon.errors]);
});
