// Two riders ask the same driver; he takes one (owner, 2026-11-10): the
// server declines the other at once — and the driver's app must drop that
// request too (it used to keep a stale Accept for the other rider until a
// reload: tapping it said "Too late — the request was withdrawn").
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("ridetwo: two riders ask one driver; he takes one — the other's request is gone on his screen too", async (browser) => {
  step("Rita and Sam (riders), Dan (driver, online) sign in");
  const rita = await browser.person("BT-Rita");
  const sam = await browser.person("BT-Sam", { latitude: HOME.latitude - 0.002, longitude: HOME.longitude });
  const dan = await browser.person("BT-Dan", { latitude: HOME.latitude + 0.006, longitude: HOME.longitude });
  await goOnline(dan);
  const [ritaId, samId, danId] = [await rita.id(), await sam.id(), await dan.id()];
  await sees(rita, danId);
  await sees(sam, danId);

  step("both ask Dan for a ride: two requests waiting on Dan's screen");
  for (const p of [rita, sam]) {
    await openChatWith(p, danId);
    await p.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, `${p.name}: Request ride`);
    await p.click("btn-ride-action");
    await p.waitFor(`state.ride && state.ride.status === "requested"`, `${p.name}: requested`);
    await p.eval(`closeChat(), true`);
  }
  await dan.waitFor(`realPeersById.has(${ritaId}) && realPeersById.get(${ritaId}).pending && realPeersById.has(${samId}) && realPeersById.get(${samId}).pending`, "Dan has both requests");

  step("Dan takes Rita: Sam is declined — and Sam's request is gone from Dan's screen at once (no stale Accept)");
  await dan.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await dan.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await dan.click("btn-ride-action");
  await dan.waitFor(`state.ride && state.ride.status === "connected"`, "Dan in the ride");
  await sam.waitFor(`!state.ride`, "Sam's request declined");
  check(await dan.eval(`realPeersById.get(${samId}).pending === false`), "Sam's request gone from Dan's screen", await dan.eval(`({ pending: realPeersById.get(${samId}).pending })`));

  step("after the ride, Dan back online: Sam's chat offers no Accept");
  await dan.click("btn-endride");
  await dan.waitFor(`!state.ride`, "the ride ended");
  await dan.waitFor(`state.mode === "driver"`, "Dan a driver again");
  if (!(await dan.eval(`state.online`))) await goOnline(dan);
  // (Sam's empty chat may be gone by now — then there's nothing to accept)
  const has = await dan.eval(`realPeersById.has(${samId}) && chats.has(realPeersById.get(${samId}))`);
  let btn = { shown: false, text: "(no chat with Sam)" };
  if (has) {
    check(await dan.eval(`realPeersById.get(${samId}).pending === false`), "(Sam's request still gone)");
    await dan.eval(`openChat(realPeersById.get(${samId})), true`);
    await dan.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "Sam's chat open");
    btn = await dan.eval(`(() => { const b = document.getElementById("btn-ride-action"); return { shown: !b.classList.contains("hidden") && getComputedStyle(b).display !== "none", text: b.textContent }; })()`);
  }
  check(!(btn.shown && btn.text === "Accept ride"), "no Accept ride for Sam", btn);
});
