// A request this phone ENDED itself whose answer was lost (cross-feature
// review round 4, 2026-11-25):
// 1. she blocks the driver she asked; the answer and the server's word of
//    the withdrawn request lost; a quick reconnect's reload (before the
//    push's 10 s timeout) finds the request gone: not "your ride request
//    was lost, please ask again";
// 2. she cancels it herself; the answer lost; a reload finds it gone: no
//    "please ask again", and his last-known block kept (no ride happened);
// 3. a driver who blocked a rider mid-request: her request announced late
//    makes no new chat with her.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

// (a push sent for real whose answer never comes — as a connection lost
// right after it; one only)
const loseAnswer = (p, event) =>
  p.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== ${JSON.stringify(event)}) return orig(ev, payload, t);
      userChannel.push = orig;
      orig(ev, payload, t);
      const lost = { receive: () => lost };
      return lost;
    };
    return true;
  })()`);
const watchBanners = (p) =>
  p.eval(`(() => {
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    return true;
  })()`);

await journey("lostanswers: a request she ended herself (block, cancel), its answer lost — never 'please ask again'; a blocked rider's late request makes no chat", async (browser) => {
  step("Lia asks Dov; she blocks him — the answer and the withdrawal's word lost; a quick reconnect's reload: no 'please ask again'");
  const lia = await browser.person("BT-LostLia");
  const dov = await browser.person("BT-LostDov", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  const eli = await browser.person("BT-LostEli", { latitude: HOME.latitude - 0.004, longitude: HOME.longitude });
  await goOnline(dov);
  await goOnline(eli);
  const [dovId, eliId, liaId] = [await dov.id(), await eli.id(), await lia.id()];
  await sees(lia, dovId, "(Dov's car)");
  await sees(lia, eliId, "(Eli's car)");
  await openChatWith(lia, dovId);
  await lia.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await lia.click("btn-ride-action");
  await lia.waitFor(`state.ride && state.ride.status === "requested"`, "requested Dov");
  await dov.waitFor(`realPeersById.get(${liaId}) && realPeersById.get(${liaId}).pending === true`, "Dov has her request");
  await lia.eval(`(userChannel.off("request_withdrawn"), true)`);
  await watchBanners(lia);
  await loseAnswer(lia, "block");
  await lia.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Dov's chat");
  await lia.click("chat-block");
  await lia.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await lia.click("block-yes");
  await dov.waitFor(`realPeersById.get(${liaId}).pending !== true`, "the server did it: Dov's side withdrawn");
  await lia.eval(`(softReload(), true)`);
  await lia.waitFor(`hydrated && !reloading && !state.ride`, "reloaded: the request gone", 10000);
  const b1 = await lia.eval(`window.__banners`);
  check(!b1.some((t) => t.includes("please ask again")), "no 'please ask again' for the driver she blocked", b1);
  await lia.eval(`(closeBlockSheet(), closeChat(), true)`);

  step("Lia asks Eli; she cancels it herself — the answer lost; a reload: never a false reason");
  await openChatWith(lia, eliId);
  await lia.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride (Eli)");
  await lia.click("btn-ride-action");
  await lia.waitFor(`state.ride && state.ride.status === "requested" && state.ride.peer.id === ${eliId}`, "requested Eli");
  await eli.waitFor(`realPeersById.get(${liaId}) && realPeersById.get(${liaId}).pending === true`, "Eli has her request");
  await lia.eval(`(realPeersById.get(${eliId}).lastSeen = { lat: ${HOME.latitude - 0.004}, lng: ${HOME.longitude}, at: Date.now() - 300_000 }, true)`);
  await watchBanners(lia);
  await loseAnswer(lia, "cancel_request");
  await lia.click("btn-endride");
  await eli.waitFor(`realPeersById.get(${liaId}).pending !== true`, "the server did it: Eli's side withdrawn");
  await lia.eval(`(softReload(), true)`);
  await lia.waitFor(`hydrated && !reloading && !state.ride`, "reloaded: the request gone", 10000);
  const b2 = await lia.eval(`window.__banners`);
  check(!b2.some((t) => t.includes("please ask again")), "no 'please ask again' after her own cancel", b2);
  // (a request gone: his old block dropped whatever the reason — a reload
  // can't tell her cancel from a ride: owner, 2026-11-26; his car fills it in)

  step("Dov (driver) blocked a rider mid-request; her request announced late: no new chat with her");
  const late = await dov.eval(`(() => {
    const p = ensurePeer({ id: 900000008, name: "T8" });
    p.pending = true;
    p.pendingReq = 55;
    afterBlocked(p);
    userChannel.trigger("request", { from: { id: p.id, name: p.name, photo: null }, spot: null, req: 55, after_id: null });
    const out = { chat: chats.has(p), pending: p.pending };
    chats.delete(p);
    return out;
  })()`);
  check(!late.chat && late.pending !== true, "no chat, not pending", late);
  check(lia.errors.length === 0 && dov.errors.length === 0, "no page errors", [lia.errors, dov.errors]);
});
