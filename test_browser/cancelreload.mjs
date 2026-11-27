// A Cancel answered after a reload (cross-feature review round 13,
// 2026-11-26): the reload made the ride anew, and the answer's "is it still
// that request?" compared the object — the request stayed on screen
// ("Waiting for the driver…", every other chat greyed) though cancelled.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("cancelreload: a Cancel answered after a reload clears the request", async (browser) => {
  step("Rio asks Ada; he taps Cancel — the push held; a reload meanwhile still sees the request");
  const rio = await browser.person("BT-CrRio");
  const ada = await browser.person("BT-CrAda", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(ada);
  const [adaId, rioId] = [await ada.id(), await rio.id()];
  await sees(rio, adaId, "(Ada's car)");
  await openChatWith(rio, adaId);
  await rio.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await rio.click("btn-ride-action");
  await rio.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await ada.waitFor(`realPeersById.get(${rioId}) && realPeersById.get(${rioId}).pending === true`, "Ada has the request");
  await rio.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    // (every cancel held — the reload's resend too (round 14): only the
    // FIRST is sent, when the test says; its own answer must clear it)
    let first = true;
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      const hooks = [];
      const held = { receive: (st, cb) => (hooks.push([st, cb]), held) };
      if (first) {
        first = false;
        window.__send = () => {
          let r = orig(ev, payload, t);
          hooks.forEach(([st, cb]) => (r = r.receive(st, cb)));
        };
      }
      return held;
    };
    return true;
  })()`);
  await rio.click("btn-endride");
  await rio.eval(`(softReload(), true)`);
  await rio.waitFor(`hydrated && !reloading && state.ride && state.ride.status === "requested"`, "reloaded: the request still there", 10000);

  step("the cancel goes; its answer: the request gone here too");
  await rio.eval(`(window.__send(), true)`);
  await ada.waitFor(`realPeersById.get(${rioId}).pending !== true`, "Ada: withdrawn");
  await new Promise((r) => setTimeout(r, 1000));
  check((await rio.eval(`state.ride`)) == null, "Rio: no request left on screen", await rio.eval(`state.ride && state.ride.status`));
  check(rio.errors.length === 0, "no page errors", rio.errors);
});
