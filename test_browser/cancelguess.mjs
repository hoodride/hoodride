// A reload never claims "Request cancelled" (cross-feature review round 19,
// 2026-11-26): the request gone from its snapshot doesn't say HOW — a
// decline, an Accept at work holding it, a ride — so only the server's own
// word does (the cancel's ok, or "cancel_done").
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("cancelguess: her cancel never sent, the request declined unheard — a reload doesn't say 'Request cancelled'", async (browser) => {
  step("Una asks Vik; she cancels — the push never sent; Vik declines (she doesn't hear it)");
  const una = await browser.person("BT-GuessUna");
  const vik = await browser.person("BT-GuessVik", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(vik);
  const [vikId, unaId] = [await vik.id(), await una.id()];
  await sees(una, vikId, "(Vik's car)");
  await openChatWith(una, vikId);
  await una.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await una.click("btn-ride-action");
  await una.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await vik.waitFor(`realPeersById.get(${unaId}) && realPeersById.get(${unaId}).pending === true`, "Vik has it");
  await una.eval(`(() => {
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    userChannel.off("request_declined");
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      userChannel.push = orig;
      const held = { receive: () => held };
      return held;
    };
    return true;
  })()`);
  await una.click("btn-endride");
  await vik.eval(`(openChat(realPeersById.get(${unaId})), true)`);
  await vik.waitFor(`!document.getElementById("btn-decline").classList.contains("hidden")`, "Decline");
  await vik.click("btn-decline");
  await vik.waitFor(`realPeersById.get(${unaId}).pending !== true`, "declined");

  step("a reload: the request gone — never 'Request cancelled' (it was declined)");
  await una.eval(`(softReload(), true)`);
  await una.waitFor(`hydrated && !reloading && !state.ride`, "reloaded: gone", 10000);
  await new Promise((r) => setTimeout(r, 500));
  const said = await una.eval(`window.__banners`);
  check(!said.includes("Request cancelled"), "no 'Request cancelled' (her cancel never went)", said);
  step("Una asks Vik again; she cancels as he declines — the decline first: her cancel finds nothing — never 'Request cancelled' over 'Driver can't take this one'");
  // (review round 20: a cancel that found nothing was answered a plain "ok")
  await new Promise((r) => setTimeout(r, 1500));
  await server("cooldown_over");
  await una.eval(`(() => {
    // (her decline handler back, as the app has it)
    location.reload();
    return true;
  })()`).catch(() => {});
  await una.waitFor(`typeof hydrated !== "undefined" && hydrated && !reloading`, "Una reloaded", 15000);
  await una.eval(`(() => {
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    return true;
  })()`);
  await sees(una, vikId, "(Vik's car, again)");
  await openChatWith(una, vikId);
  await una.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride (again)");
  await una.click("btn-ride-action");
  await una.waitFor(`state.ride && state.ride.status === "requested"`, "requested again");
  await vik.waitFor(`realPeersById.get(${unaId}) && realPeersById.get(${unaId}).pending === true`, "Vik has it again");
  await una.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      userChannel.push = orig;
      // (sent only once the decline was heard — the decline first)
      const hooks = [];
      const held = { receive: (st, cb) => (hooks.push([st, cb]), held) };
      const go = () => { let r = orig(ev, payload, t); hooks.forEach(([st, cb]) => (r = r.receive(st, cb))); };
      const wait = () => (state.ride ? setTimeout(wait, 50) : go());
      wait();
      return held;
    };
    return true;
  })()`);
  await una.click("btn-endride");
  await vik.eval(`(openChat(realPeersById.get(${unaId})), true)`);
  await vik.waitFor(`!document.getElementById("btn-decline").classList.contains("hidden")`, "Decline");
  await vik.click("btn-decline");
  await una.waitFor(`window.__banners.some((t) => t.startsWith("Driver can't take this one"))`, "Una: declined", 10000);
  await new Promise((r) => setTimeout(r, 1500));
  const said2 = await una.eval(`window.__banners`);
  check(!said2.includes("Request cancelled"), "no 'Request cancelled' — it was declined", said2);

  step("a late 'cancel_done' for Vik after a NEW request to him: the new request stays");
  const kept = await una.eval(`(() => {
    // (as a new request's tap leaves things: no cancel wish; the request on screen)
    cancelIntent = null;
    state.ride = { peer: realPeersById.get(${vikId}), status: "requested" };
    userChannel.trigger("cancel_done", { driver_id: ${vikId} });
    const out = state.ride && state.ride.status;
    state.ride = null;
    return out;
  })()`);
  check(kept === "requested", "the new request kept", kept);
  check(una.errors.length === 0, "no page errors", una.errors);
});
