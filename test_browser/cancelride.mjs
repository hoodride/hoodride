// A Cancel answered "accepted" — then the Accept SUCCEEDS: a ride, started
// and ended while her phone heard nothing (cross-feature review round 18,
// 2026-11-26). Back, the reload must not say "Request cancelled": her cancel
// was refused, a ride happened.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("cancelride: a Cancel answered 'accepted', the ride started and ended unheard — never 'Request cancelled'", async (browser) => {
  step("Rae asks Dov; her cancel isn't sent, answered 'accepted'; then she hears nothing (and can't reload)");
  const rae = await browser.person("BT-CrdRae");
  const dov = await browser.person("BT-CrdDov", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dov);
  const [dovId, raeId] = [await dov.id(), await rae.id()];
  await sees(rae, dovId, "(Dov's car)");
  await openChatWith(rae, dovId);
  await rae.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await rae.click("btn-ride-action");
  await rae.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await dov.waitFor(`realPeersById.get(${raeId}) && realPeersById.get(${raeId}).pending === true`, "Dov has the request");
  await rae.eval(`(() => {
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    // (her reloads can't reach the server meanwhile)
    window.__offline = true;
    const f = window.fetch;
    window.fetch = (u, o) => (window.__offline && String(u).startsWith("/api/") ? Promise.reject(new TypeError("offline")) : f(u, o));
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "cancel_request") return orig(ev, payload, t);
      userChannel.push = orig;
      const ans = { receive: (st, cb) => (st === "error" && setTimeout(() => { cb({ reason: "accepted" }); socket.disconnect(); }, 50), ans) };
      return ans;
    };
    return true;
  })()`);
  await rae.click("btn-endride");
  await rae.waitFor(`!socket.isConnected()`, "Rae: away");

  step("Dov accepts — the ride starts — and ends it");
  await dov.eval(`(openChat(realPeersById.get(${raeId})), true)`);
  await dov.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride");
  await dov.click("btn-ride-action");
  await dov.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "Dov in the ride", 15000);
  await dov.click("btn-endride");
  await dov.waitFor(`!state.ride`, "the ride over");

  step("Rae back: no request, no ride — and never 'Request cancelled'");
  await new Promise((r) => setTimeout(r, 6000));
  await rae.eval(`(window.__offline = false, socket.connect(), true)`);
  await rae.waitFor(`socket.isConnected() && hydrated && !reloading && !state.ride`, "back", 20000);
  await new Promise((r) => setTimeout(r, 1500));
  const said = await rae.eval(`window.__banners`);
  check(!said.includes("Request cancelled"), "never 'Request cancelled' (a ride happened)", said);
  check(rae.errors.length === 0, "no page errors", rae.errors);
});
