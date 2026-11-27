// Her Cancel's answers (cross-feature review round 15, 2026-11-26):
// 1. "accepted" (the driver's Accept at work), then that Accept fails and
//    her cancel is done after all — no ride comes: not "your ride request
//    was lost, please ask again", and the driver's last-known block kept
//    (it was her own cancel);
// 2. two cancels both answered ok (a resend): "Request cancelled" once;
// 3. (round 16) "accepted", then the driver DECLINES (his Accept's start
//    failed): her cancel's mark mustn't outlive the request — asked again,
//    a later reload never cancels the NEW request;
// 4. (round 16) the cancel's ok after a reload already cleared the request:
//    "Request cancelled" all the same, once.
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("cancelaccepted: a Cancel answered 'accepted' with no ride after — no 'please ask again'; one 'Request cancelled'", async (browser) => {
  step("Ria asks Dex; she cancels — it's done on the server, but its answer says 'accepted' (as an Accept at work); no ride comes");
  const ria = await browser.person("BT-AccRia");
  const dex = await browser.person("BT-AccDex", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dex);
  const [dexId, riaId] = [await dex.id(), await ria.id()];
  await sees(ria, dexId, "(Dex's car)");
  await openChatWith(ria, dexId);
  await ria.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await ria.click("btn-ride-action");
  await ria.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await dex.waitFor(`realPeersById.get(${riaId}) && realPeersById.get(${riaId}).pending === true`, "Dex has the request");
  await ria.eval(`(() => {
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    realPeersById.get(${dexId}).lastSeen = { lat: ${HOME.latitude + 0.004}, lng: ${HOME.longitude}, at: Date.now() - 300_000 };
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      userChannel.push = orig;
      // (sent for real — it cancels; its answer: "accepted")
      orig(ev, payload, t);
      const ans = { receive: (st, cb) => (st === "error" && setTimeout(() => cb({ reason: "accepted" }), 50), ans) };
      return ans;
    };
    return true;
  })()`);
  await ria.click("btn-endride");
  await dex.waitFor(`realPeersById.get(${riaId}).pending !== true`, "Dex: withdrawn");
  // (the Accept failed, her cancel done after all: the server says so —
  // "cancel_done", CancelAcceptRaceTest — as it would here)
  await ria.eval(`(userChannel.trigger("cancel_done", { driver_id: ${dexId} }), true)`);

  step("the request gone; no 'please ask again', Dex's block kept");
  await ria.waitFor(`!state.ride && hydrated && !reloading`, "the request gone", 15000);
  await new Promise((r) => setTimeout(r, 500));
  const said = await ria.eval(`window.__banners`);
  check(!said.some((t) => t.includes("please ask again")), "no 'please ask again' after her own cancel", said);
  check((await ria.eval(`realPeersById.get(${dexId}).lastSeen`)) != null, "Dex's last-known block kept (no ride happened)");
  // (…and her cancel confirmed: the reload found it done — round 17)
  check(said.filter((t) => t === "Request cancelled").length === 1, "'Request cancelled' said once", said);

  step("two cancels both answered ok (a resend): 'Request cancelled' once");
  const twice = await ria.eval(`(() => {
    window.__banners = [];
    const p = realPeersById.get(${dexId});
    // (a new request, as its tap leaves things: no earlier cancel wish)
    state.ride = { peer: p, status: "requested" };
    cancelIntent = null;
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      const ans = { receive: (st, cb) => (st === "ok" && setTimeout(() => cb({}), 0), ans) };
      return ans;
    };
    endRide();
    endRide();
    return new Promise((ok) => setTimeout(() => { userChannel.push = orig; ok(window.__banners.filter((t) => t === "Request cancelled").length); }, 200));
  })()`);
  check(twice === 1, "'Request cancelled' once", twice);
  step("Ria asks Dex again; she cancels — not sent, answered 'accepted'; Dex declines (his start failed): she asks again — a reload doesn't cancel the new request");
  // (a new second: a request's stamp is its second — the cooldown, skipped
  // here, keeps real ones a minute apart)
  await new Promise((r) => setTimeout(r, 1500));
  await server("cooldown_over");
  await ria.eval(`(state.ride = null, refreshControls(), true)`);
  await ria.eval(`(closeChat(), openChat(realPeersById.get(${dexId})), true)`);
  await ria.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride (again)");
  await ria.click("btn-ride-action");
  await ria.waitFor(`state.ride && state.ride.status === "requested"`, "requested again");
  await dex.waitFor(`realPeersById.get(${riaId}) && realPeersById.get(${riaId}).pending === true`, "Dex has it");
  await ria.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      userChannel.push = orig;
      const ans = { receive: (st, cb) => (st === "error" && setTimeout(() => cb({ reason: "accepted" }), 50), ans) };
      return ans;
    };
    return true;
  })()`);
  await ria.click("btn-endride");
  await dex.eval(`(openChat(realPeersById.get(${riaId})), true)`);
  await dex.waitFor(`!document.getElementById("btn-decline").classList.contains("hidden")`, "Decline");
  await dex.click("btn-decline");
  await ria.waitFor(`!state.ride`, "Ria: declined");
  await new Promise((r) => setTimeout(r, 5500));
  await server("cooldown_over");
  await ria.eval(`(closeChat(), openChat(realPeersById.get(${dexId})), true)`);
  await ria.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride (a third time)");
  await ria.click("btn-ride-action");
  await ria.waitFor(`state.ride && state.ride.status === "requested"`, "requested a third time");
  await ria.eval(`(window.__banners = [], softReload(), true)`);
  await ria.waitFor(`hydrated && !reloading`, "reloaded", 10000);
  await new Promise((r) => setTimeout(r, 1500));
  const kept = await ria.eval(`({ ride: state.ride && state.ride.status, banners: window.__banners })`);
  check(kept.ride === "requested" && !kept.banners.includes("Request cancelled"), "the new request stands — not cancelled by the old cancel", kept);
  check((await dex.eval(`realPeersById.get(${riaId}).pending`)) === true, "Dex still has it");

  step("she cancels it — the ok held; a reload meanwhile finds it gone; then the ok: 'Request cancelled', once");
  await ria.eval(`(() => {
    window.__banners = [];
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      userChannel.push = orig;
      // (sent for real; its ok held until the test says)
      const hooks = [];
      const real = orig(ev, payload, t);
      const held = { receive: (st, cb) => (hooks.push([st, cb]), held) };
      window.__ok = () => hooks.filter(([st]) => st === "ok").forEach(([, cb]) => cb({}));
      return held;
    };
    return true;
  })()`);
  await ria.click("btn-endride");
  await dex.waitFor(`realPeersById.get(${riaId}).pending !== true`, "Dex: withdrawn");
  await ria.eval(`(softReload(), true)`);
  await ria.waitFor(`hydrated && !reloading && !state.ride`, "reloaded: gone", 10000);
  await ria.eval(`(window.__ok(), true)`);
  await new Promise((r) => setTimeout(r, 300));
  const told = await ria.eval(`window.__banners.filter((t) => t === "Request cancelled").length`);
  check(told === 1, "'Request cancelled' once", told);
  check(ria.errors.length === 0, "no page errors", ria.errors);
});
