// The greyed Request button's edges (reviews, 2026-11-24; each proven to
// fail without its fix, 2026-11-25):
// 1. the cancel link's tap landing just as the ride starts never ends the
//    ride (the link only cancels a request);
// 2. a block whose answer never comes (a timeout) — and the server's word
//    of the withdrawn request lost too — asks the server again: the
//    request it withdrew doesn't stay "Waiting for the driver…";
// 3. a driver blocking a rider who'd asked drops her request on his side.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("blockextra: the cancel link never ends a ride; a block's lost answer is asked again; a driver's block drops the rider's request", async (browser) => {
  step("Rita (rider), Dan and Eve (drivers, online); Rita asks Dan; Eve's chat shows the cancel link");
  const rita = await browser.person("BT-ExRita");
  const dan = await browser.person("BT-ExDan", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  const eve = await browser.person("BT-ExEve", { latitude: HOME.latitude - 0.004, longitude: HOME.longitude });
  await goOnline(dan);
  await goOnline(eve);
  const [danId, eveId, ritaId] = [await dan.id(), await eve.id(), await rita.id()];
  await sees(rita, danId, "(Dan's car)");
  await sees(rita, eveId, "(Eve's car)");
  await openChatWith(rita, danId);
  await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  await rita.eval(`closeChat(), true`);
  await openChatWith(rita, eveId);
  await rita.waitFor(`!document.getElementById("chat-cancel-other").classList.contains("hidden")`, "the cancel link");

  step("the link's tap lands just as the ride starts (its news applied, the screen not redrawn yet): the ride isn't ended");
  const tapped = await rita.eval(`(() => {
    window.__joins = 0;
    const j = joinRideChannel;
    window.joinRideChannel = function () { window.__joins++; return j.apply(this, arguments); };
    state.ride.status = "connected";
    document.getElementById("chat-cancel-other").click();
    const out = { joins: window.__joins, ride: !!state.ride, status: state.ride && state.ride.status };
    window.joinRideChannel = j;
    state.ride.status = "requested";
    return out;
  })()`);
  check(tapped.joins === 0 && tapped.ride, "no End ride sent, the ride kept", tapped);
  await rita.eval(`closeChat(), true`);

  step("Rita blocks Dan — the answer never comes (timeout) and the server's word of the withdrawn request is lost: asked again, the request's gone; the sheet checks, then says Blocked — never 'Couldn't block'");
  await rita.eval(`(() => {
    // (every banner from here: a block that went through isn't "your ride
    // request was lost, please ask again" — cross-feature review, 2026-11-25)
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    // (what the sheet says, all along: a block that went through isn't
    // "Couldn't block" — owner, 2026-11-25)
    window.__sheetSaid = [];
    const er = document.getElementById("block-error");
    new MutationObserver(() => er.textContent && window.__sheetSaid.push(er.textContent)).observe(er, { childList: true, characterData: true, subtree: true });
    userChannel.off("request_withdrawn");
    const orig = userChannel.push.bind(userChannel);
    // (this one answer lost: the block goes, its answer never comes)
    userChannel.push = (ev, payload, t) => {
      const real = orig(ev, payload, t);
      if (ev !== "block") return real;
      userChannel.push = orig;
      const lost = { receive: (st, cb) => (st === "timeout" && setTimeout(cb, 300), lost) };
      return lost;
    };
    return true;
  })()`);
  await openChatWith(rita, danId);
  await rita.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Dan's chat");
  await rita.click("chat-block");
  await rita.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await rita.click("block-yes");
  await rita.waitFor(`!state.ride`, "the request gone (the server asked again)", 15000);
  await rita.waitFor(`hydrated && !reloading`, "the reload done");
  const banners = await rita.eval(`window.__banners`);
  check(!banners.some((t) => t.includes("please ask again")), "no 'please ask again' for the driver she blocked", banners);
  await rita.waitFor(`document.getElementById("block-sheet").classList.contains("hidden")`, "the sheet closed (checked: blocked)", 40000);
  const said = await rita.eval(`({ sheet: window.__sheetSaid, banners: window.__banners })`);
  check(!said.sheet.some((t) => t.includes("Couldn't block")) && said.banners.some((t) => t.startsWith("Blocked.")), "never 'Couldn't block'; 'Blocked.' said", said);

  step("Rita asks Eve; Eve blocks her: Rita's request is no longer pending on Eve's side");
  await rita.eval(`(!document.getElementById("block-sheet").classList.contains("hidden") && document.getElementById("block-cancel").click(), true)`);
  await openChatWith(rita, eveId);
  await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride (Eve)");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested" && state.ride.peer.id === ${eveId}`, "requested Eve");
  await eve.waitFor(`realPeersById.get(${ritaId}) && realPeersById.get(${ritaId}).pending === true`, "Eve has Rita's request");
  await eve.eval(`(openChat(realPeersById.get(${ritaId})), true)`);
  await eve.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Rita's chat");
  await eve.click("chat-block");
  await eve.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await eve.click("block-yes");
  await eve.waitFor(`!chats.has(realPeersById.get(${ritaId}))`, "the chat closed", 10000);
  check((await eve.eval(`realPeersById.get(${ritaId}).pending`)) !== true, "Rita's request: not pending on Eve's side", await eve.eval(`realPeersById.get(${ritaId}).pending`));
  step("Rita unblocks Dan from her drawer — the answer lost: checked, then done — never 'Couldn't unblock'");
  await rita.eval(`(() => {
    window.__sheetSaid = [];
    const er = document.getElementById("block-error");
    new MutationObserver(() => er.textContent && window.__sheetSaid.push(er.textContent)).observe(er, { childList: true, characterData: true, subtree: true });
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      const real = orig(ev, payload, t);
      if (ev !== "unblock") return real;
      userChannel.push = orig;
      const lost = { receive: (st, cb) => (st === "timeout" && setTimeout(cb, 300), lost) };
      return lost;
    };
    return true;
  })()`);
  await rita.click("btn-account");
  await rita.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "the drawer open");
  await rita.click("btn-blocked");
  await rita.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length === 1`, "the list: Dan");
  await rita.eval(`document.querySelector("#blocked-list .blocked-row button").click(), true`);
  await rita.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await rita.click("block-yes");
  await rita.waitFor(`document.querySelector("#blocked-list .blocked-empty")`, "nobody left in the list (checked: unblocked)", 40000);
  const unsaid = await rita.eval(`window.__sheetSaid`);
  check(!unsaid.some((t) => t.includes("Couldn't unblock")), "never 'Couldn't unblock'", unsaid);
  check(rita.errors.length === 0 && eve.errors.length === 0, "no page errors", [rita.errors, eve.errors]);
});
