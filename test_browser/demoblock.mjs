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
  // (owner, 2026-11-20) on Dee's own message — not only once the pretend
  // driver answers (1.1 s later): it showed only then
  await dee.waitFor(shown("chat-end"), "End chat shown", 500);
  check((await dee.eval(`chats.get(state.chatPeer).msgs.length`)) === 1, "before any answer: only Dee's message");
  await dee.click("chat-end");
  check((await dee.eval(`document.getElementById("chat-end").textContent`)) === "Tap again to end", "the first tap asks again");
  // the second tap at once, once it's armed: two separate taps from the test
  // could be more than End chat's 3 s apart on a loaded machine (the
  // precommit, 2026-11-19) — the arming then lapsed and the tap re-armed
  await dee.eval(`(() => { const b = document.getElementById("chat-end"); if (b.textContent !== "Tap again to end") throw new Error("not armed: " + b.textContent); b.click(); return true; })()`);
  await dee.waitFor(`!${chatOpen} && !chats.has(drivers[0])`, "the chat gone");
  // (review, 2026-11-20) ended before the pretend driver's answer (1.1 s
  // after the send): it stays ended — the answer brought the chat back
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await dee.eval(`chats.has(drivers[0])`)), "still gone once the answer was due");

  step("two chats, End chat in one: the list, with the other (owner, 2026-11-17)");
  await message(dee, "drivers[0]");
  await typeText(dee, "hi again");
  await send(dee);
  await message(dee, "drivers[2]");
  await typeText(dee, "hey");
  await send(dee);
  await dee.waitFor(shown("chat-end"), "End chat shown");
  await dee.click("chat-end");
  // the second tap at once, once it's armed: two separate taps from the test
  // could be more than End chat's 3 s apart on a loaded machine (the
  // precommit, 2026-11-19) — the arming then lapsed and the tap re-armed
  await dee.eval(`(() => { const b = document.getElementById("chat-end"); if (b.textContent !== "Tap again to end") throw new Error("not armed: " + b.textContent); b.click(); return true; })()`);
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

  // (owner, 2026-11-21: "when you press Request ride everything at the top
  // shifts up when the Block button disappears") the demo hid Block with
  // your ride partner — the real app keeps it (blocking ends the ride) —
  // and with End chat hidden too, their row went: the header shifted up
  step("Request ride: the header stays put — Block still there (as the real app); blocking your ride partner ends the ride");
  await dee.eval(`(closeSettings(), true)`);
  await message(dee, "drivers[3]");
  await dee.waitFor(shown("chat-block"), "Block shown");
  const headerH = () => dee.eval(`Math.round(document.querySelector("#chat .chat-header").getBoundingClientRect().height)`);
  const nameTop = () => dee.eval(`Math.round(document.getElementById("chat-name").getBoundingClientRect().top)`);
  const before = { h: await headerH(), top: await nameTop() };
  await dee.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride");
  await dee.click("btn-ride-action");
  await dee.waitFor(`state.ride && state.ride.peer === drivers[3]`, "requested");
  check(await dee.eval(shown("chat-block")), "Block still shown once you've asked");
  const asked = { h: await headerH(), top: await nameTop() };
  check(asked.h === before.h && asked.top === before.top, "the header didn't move", { before, asked });
  // the header keeps its room even with both links hidden (a ride's chat
  // with nothing said: no End chat; Block hidden — as for no one to block)
  await dee.eval(`(document.getElementById("chat-block").classList.add("hidden"), true)`);
  check((await headerH()) === before.h, "no links showing: the header keeps its height", { before: before.h, now: await headerH() });
  await dee.eval(`(showEndChat(state.chatPeer), true)`);
  // block your ride partner: the ride ends, as the server does in the real app
  await dee.waitFor(`state.ride && state.ride.status === "connected"`, "accepted", 8000);
  await dee.click("chat-block");
  await dee.waitFor(shown("block-sheet"), "the Block sheet");
  await dee.click("block-yes");
  await dee.waitFor(`!state.ride && !${chatOpen} && drivers[3].blocked`, "blocked: the ride over, the chat closed");
  check(!(await dee.eval(`drivers[3].visible`)), "their car gone from the map");

  // (review, 2026-11-21) the pretend ✋ blocked, then offline and online
  // again: the same person's ✋ came back — the pretend request already
  // checked the blocked list, the ✋ never did
  step("driving, Dee blocks the pretend ✋; offline and online again: that ✋ never comes back");
  await dee.click("btn-mode");
  await dee.waitFor(`state.mode === "driver"`, "Drive mode");
  await dee.click("btn-online");
  await dee.waitFor(`state.online && !!mockHand && mockHand.visible`, "the ✋", 5000);
  await dee.eval(`(openBlockSheet(mockHand, "block", document.getElementById("chat-block")), true)`);
  await dee.waitFor(shown("block-sheet"), "the Block sheet");
  await dee.click("block-yes");
  await dee.waitFor(`!${shown("block-sheet")}`, "blocked");
  await dee.click("btn-online");
  await dee.waitFor(`!state.online`, "offline");
  await dee.click("btn-online");
  await dee.waitFor(`state.online`, "online again");
  await new Promise((r) => setTimeout(r, 2500));
  check(!(await dee.eval(`!!mockHand`)), "no ✋ from someone she blocked", await dee.eval(`mockHand && mockHand.name`));
  // (owner, 2026-11-21: "if you unblock they come back?") unblocked while
  // online: their ✋ back at once, as the real app (it came back only at the
  // next time online)
  await dee.eval(`(openSettings(), true)`);
  await dee.waitFor(shown("blocked-wrap"), "the Blocked people row");
  await dee.click("btn-blocked");
  await dee.waitFor(`[...document.querySelectorAll("#blocked-list .blocked-row strong")].some((s) => s.textContent === HAND_RIDER.name)`, "the ✋ rider listed");
  await dee.eval(`([...document.querySelectorAll("#blocked-list .blocked-row")].find((r) => r.querySelector("strong").textContent === HAND_RIDER.name).querySelector("button").click(), true)`);
  await dee.waitFor(shown("block-sheet"), "the Unblock sheet");
  await dee.click("block-yes");
  await dee.waitFor(`!${shown("block-sheet")}`, "unblocked");
  await dee.eval(`(closeBlockedSheet(), closeSettings(), true)`);
  await dee.waitFor(`!!mockHand && mockHand.visible`, "their ✋ back at once", 3000);
  check(dee.errors.length === 0, "no page errors", dee.errors);
});
