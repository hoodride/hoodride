// Block and End chat in the demo (owner, 2026-11-17: "i wanna see it"):
// played out on the phone alone — End chat (tap twice) closes the chat;
// Block hides the pretend driver from the map, closes their chat, keeps
// them quiet, lists them in Blocked people; Unblock brings them back.
import { journey, step, check, BASE } from "./cdp.mjs";
import { typeText, send } from "./app.mjs";

const chatOpen = `!document.getElementById("chat").classList.contains("hidden")`;
const shown = (id) => `!document.getElementById(${JSON.stringify(id)}).classList.contains("hidden")`;
async function message(p, peerExpr) {
  await p.eval(`(openPeerCard(${peerExpr}), true)`);
  await p.click("btn-msg");
  await p.waitFor(`${chatOpen} && state.chatPeer === ${peerExpr}`, "the chat open");
}

await journey("demoblock: in the demo, End chat closes the chat; Block hides them, Blocked people lists them, Unblock brings them back", async (browser) => {
  const dee = await browser.visitor("BT-DemoBlock");
  await dee.goto(`${BASE}/?demo`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 1`, "the demo's pretend drivers", 15000);
  // (close in: the cars are drawn at the markers' level)
  await dee.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 15 }), planDemoView(), true)`);
  await dee.waitFor(`drivers[0].visible`, "the first pretend car on the map", 10000);

  step("End chat: not for a chat nothing was said in (as the real app); once Dee writes, it shows; two taps close it");
  await message(dee, "drivers[0]");
  check(!(await dee.eval(shown("chat-end"))), "an empty chat: no End chat");
  await typeText(dee, "hi");
  await send(dee);
  await dee.waitFor(shown("chat-end"), "End chat shown");
  await dee.click("chat-end");
  check((await dee.eval(`document.getElementById("chat-end").textContent`)) === "Tap again to end", "the first tap asks again");
  await dee.click("chat-end");
  await dee.waitFor(`!${chatOpen} && !chats.has(drivers[0])`, "the chat gone");

  step("two chats, End chat in one: the list, with the other (owner, 2026-11-17)");
  await message(dee, "drivers[0]");
  await typeText(dee, "hi again");
  await send(dee);
  await message(dee, "drivers[2]");
  await typeText(dee, "hey");
  await send(dee);
  await dee.waitFor(shown("chat-end"), "End chat shown");
  await dee.click("chat-end");
  await dee.click("chat-end");
  await dee.waitFor(`!chats.has(drivers[2])`, "that chat gone");
  check(await dee.eval(`${chatOpen} && state.chatView === "list"`), "the list");
  check((await dee.eval(`[...document.querySelectorAll("#chat-messages .chat-item strong")].map((s) => s.textContent)`)).join() === (await dee.eval(`drivers[0].name`)), "the other chat in it");

  step("a car tapped with the list open: the list goes, their card in front");
  await dee.eval(`(drivers[1].marker.getElement().click(), true)`);
  check(!(await dee.eval(chatOpen)), "the chat panel gone");
  check(await dee.eval(`${shown("peer-card")} && state.cardPeer === drivers[1]`), "their card shows");
  await dee.eval(`(closePeerCard(), true)`);
  await dee.eval(`(chats.delete(drivers[0]), true)`);

  step("Block from the chat: the sheet, Block — the car gone from the map, the chat closed, the banner");
  await message(dee, "drivers[1]");
  await dee.waitFor(shown("chat-block"), "Block shown in the chat");
  await dee.click("chat-block");
  await dee.waitFor(shown("block-sheet"), "the Block sheet");
  await dee.click("block-yes");
  await dee.waitFor(`!${shown("block-sheet")} && !${chatOpen} && !chats.has(drivers[1])`, "sheet and chat closed");
  check(!(await dee.eval(`drivers[1].visible`)), "their car gone from the map");
  check((await dee.eval(`document.getElementById("banner").textContent`)).startsWith("Blocked."), "the Blocked banner");

  step("blocked: they say nothing more");
  await dee.eval(`(receiveMsg(drivers[1], "hello?"), true)`);
  check(!(await dee.eval(`chats.has(drivers[1])`)), "no chat from them");

  step("Blocked people: listed; Unblock — their car back on the map");
  await dee.eval(`(openSettings(), true)`);
  await dee.waitFor(shown("blocked-wrap"), "the Blocked people row");
  await dee.click("btn-blocked");
  await dee.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length === 1`, "one row");
  const name = await dee.eval(`document.querySelector("#blocked-list .blocked-row strong").textContent`);
  check(name === (await dee.eval(`drivers[1].name`)), "it's them", name);
  await dee.eval(`(document.querySelector("#blocked-list .blocked-row button").click(), true)`);
  await dee.waitFor(shown("block-sheet"), "the Unblock sheet");
  // ON TOP of the list, where a finger lands — not behind it (owner,
  // 2026-11-17: the Unblock question was behind the Blocked people list)
  check(
    await dee.eval(`(() => { const r = document.getElementById("block-yes").getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && document.getElementById("block-sheet").contains(hit); })()`),
    "the Unblock question in front of the list"
  );
  await dee.click("block-yes");
  await dee.waitFor(`!${shown("block-sheet")} && !!document.querySelector("#blocked-list .blocked-empty")`, "the list empty");
  check(!(await dee.eval(`drivers[1].blocked`)), "unblocked");
  await dee.eval(`(closeBlockedSheet(), true)`);
  await dee.waitFor(`drivers[1].visible`, "their car back on the map", 10000);
});
