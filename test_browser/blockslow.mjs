// A Block the server is slow to save — 45 s, a database stuck on a lock
// (cross-feature review rounds 10–11, 2026-11-25): the push times out, its
// retry queues behind it in the channel and times out too. The block then
// goes through: the sheet mustn't have said "Couldn't block", nor the chat
// "Chat with … ended" — and once it's known (the server asked), what a
// block ends is ended here too: a driver's pending request from the rider
// he blocked gone, her chat closed.
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("blockslow: a Block saved 45 s late — never 'Couldn't block', no 'Chat with … ended'; settled: the request and chat gone", async (browser) => {
  step("Sal asks Dov for a ride; Dov opens her chat; the server's block saves take 45 s; he blocks her");
  const sal = await browser.person("BT-SlowSal");
  const dov = await browser.person("BT-SlowDov", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dov);
  const [dovId, salId] = [await dov.id(), await sal.id()];
  await sees(sal, dovId, "(Dov's car)");
  await openChatWith(sal, dovId);
  await sal.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await sal.click("btn-ride-action");
  await dov.waitFor(`realPeersById.get(${salId}) && realPeersById.get(${salId}).pending === true`, "Dov has her request");
  await dov.eval(`(openChat(realPeersById.get(${salId})), true)`);
  await dov.eval(`(() => {
    window.__sheetSaid = [];
    window.__banners = [];
    const er = document.getElementById("block-error");
    new MutationObserver(() => er.textContent && window.__sheetSaid.push(er.textContent)).observe(er, { childList: true, characterData: true, subtree: true });
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    return true;
  })()`);
  await server("block_slow 45000");
  await dov.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Sal's chat");
  await dov.click("chat-block");
  await dov.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await dov.click("block-yes");

  step("saved at last (45 s), then known: Blocked — never 'Couldn't block', no 'Chat with … ended'; her request and chat gone");
  await dov.waitFor(`window.__banners.some((t) => t.startsWith("Blocked."))`, "Blocked. (settled)", 120000);
  await server("block_slow off");
  const said = await dov.eval(`({ sheet: window.__sheetSaid, banners: window.__banners })`);
  check(!said.sheet.some((t) => t.includes("Couldn't block")) && !said.banners.some((t) => t.includes("Couldn't block")), "never 'Couldn't block'", said);
  check(!said.banners.some((t) => t.startsWith("Chat with")), "no 'Chat with … ended' for his own block", said);
  const left = await dov.eval(`({ pending: realPeersById.get(${salId}) ? realPeersById.get(${salId}).pending : null, chat: chats.has(realPeersById.get(${salId})), blocking: realPeersById.get(${salId}) ? !!realPeersById.get(${salId}).blocking : null })`);
  check(left.pending !== true && !left.chat && !left.blocking, "her request gone, her chat closed, not 'being blocked' any more", left);
  check(dov.errors.length === 0, "no page errors", dov.errors);
});
