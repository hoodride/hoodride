// After YOU end a chat (End chat, Block) with other chats left — even one —
// the chat list; with none left, closed (owner, 2026-11-17). A car tapped
// on the map with a chat open: the chat goes, their card (or the pile's
// list) shows in front — never behind the chat.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

const where = (p) =>
  p.eval(`(() => document.getElementById("chat").classList.contains("hidden") ? "closed" : state.chatView === "list" ? "list" : "chat")()`);
const listNames = (p) => p.eval(`[...document.querySelectorAll("#chat-messages .chat-item strong")].map((s) => s.textContent)`);
const shown = (id) => `!document.getElementById(${JSON.stringify(id)}).classList.contains("hidden")`;

await journey("endtolist: you end or block a chat — the list, even with one left; none left: closed; a car tapped with a chat open shows in front", async (browser) => {
  step("Dan and Eve drive; Rita writes to both");
  const dan = await browser.person("BT-ListDan");
  const eve = await browser.person("BT-ListEve");
  const rita = await browser.person("BT-ListRita");
  const danId = await dan.id();
  const eveId = await eve.id();
  await goOnline(dan);
  await goOnline(eve);
  await sees(rita, danId);
  await sees(rita, eveId);
  for (const id of [danId, eveId]) {
    await openChatWith(rita, id);
    await typeText(rita, "hi");
    await send(rita);
    await rita.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.id != null)`, "delivered");
  }

  step("a car tapped with Eve's chat open: the chat goes, Dan's card (or the pile's list) in front");
  check((await where(rita)) === "chat", "Eve's chat open");
  await rita.eval(`(() => { for (const pm of pileMarkers.values()) if (pm.ids.includes(${danId})) { pm.el.click(); return true; } throw new Error("Dan's marker not drawn"); })()`);
  check((await where(rita)) === "closed", "the chat panel gone");
  check(await rita.eval(`${shown("peer-card")} || ${shown("pile-sheet")}`), "the card or the pile's list shows");
  check(await rita.eval(`chats.has(realPeersById.get(${eveId}))`), "Eve's chat kept");
  await rita.eval(`(closePeerCard(), closePileSheet(), true)`);

  step("End chat in Dan's, Eve's left: the list — with Eve in it");
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await rita.waitFor(shown("chat-end"), "End chat shown");
  await rita.click("chat-end");
  await rita.click("chat-end");
  await rita.waitFor(`!chats.has(realPeersById.get(${danId}))`, "Dan's chat gone");
  check((await where(rita)) === "list", "the list", await where(rita));
  check(JSON.stringify(await listNames(rita)) === JSON.stringify(["BT-ListEve"]), "only Eve", await listNames(rita));

  step("Block Eve from her chat — none left: closed");
  await rita.eval(`(document.querySelector("#chat-messages .chat-item").click(), true)`);
  await rita.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === ${eveId}`, "Eve's chat");
  await rita.waitFor(shown("chat-block"), "Block shown");
  await rita.click("chat-block");
  await rita.waitFor(shown("block-sheet"), "the sheet");
  await rita.click("block-yes");
  await rita.waitFor(`!chats.has(realPeersById.get(${eveId})) && !${shown("block-sheet")}`, "Eve's chat gone");
  check((await where(rita)) === "closed", "nothing left: closed", await where(rita));
});
