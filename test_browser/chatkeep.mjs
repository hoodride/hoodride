// An open chat keeps what the server keeps (growth inventory, 2026-11-19):
// the newest 20 messages (Limits.chat_history — CHAT_KEEP in app.js). It
// kept every message that arrived while the page stayed open — a long
// ride, a phone left on the chat, a flood at the pair limit. Played in the
// demo: a pretend driver writes 25 times; the chat holds the newest 20,
// shows the newest last, and Dee's own reply still goes on the end.
import { journey, step, check, BASE } from "./cdp.mjs";
import { typeText, send } from "./app.mjs";

const chatOpen = `!document.getElementById("chat").classList.contains("hidden")`;

await journey("chatkeep: an open chat keeps the newest 20 messages, as the server does", async (browser) => {
  const dee = await browser.visitor("BT-ChatKeep");
  await dee.goto(`${BASE}/?demo`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 1`, "the demo's pretend drivers", 15000);

  step("a chat open; the pretend driver writes 25 times");
  await dee.eval(`(openPeerCard(drivers[0]), true)`);
  await dee.click("btn-msg");
  await dee.waitFor(`${chatOpen} && state.chatPeer === drivers[0]`, "the chat open");
  await dee.eval(`(() => { for (let i = 1; i <= 25; i++) receiveMsg(drivers[0], "line " + i); return true; })()`);

  step("the newest 20 kept, the oldest 5 gone, the newest last");
  const texts = await dee.eval(`chats.get(drivers[0]).msgs.map((m) => m.text)`);
  check(texts.length === 20, "20 kept", texts.length);
  check(texts[0] === "line 6" && texts[19] === "line 25", "lines 6 to 25, in order", JSON.stringify([texts[0], texts[19]]));
  check((await dee.eval(`CHAT_KEEP`)) === 20, "the app's limit is the server's (20)");
  // the screen too: an open chat shows the same 20 (else a flood still grew the page)
  const bubbles = await dee.eval(`[...document.querySelectorAll("#chat-messages .msg")].map((b) => b.textContent)`);
  check(bubbles.length === 20, "20 bubbles on screen", bubbles.length);
  check(bubbles[0].includes("line 6") && bubbles[19].includes("line 25"), "lines 6 to 25 on screen, the oldest gone", JSON.stringify([bubbles[0], bubbles[19]]));

  // where a message sits in the chat box (px from its top edge)
  const at = (expr) => `(${expr}).getBoundingClientRect().top - document.getElementById("chat-messages").getBoundingClientRect().top`;

  step("scrolled up reading (far up, and just a nudge up): a new message drops the oldest — what you're reading stays put");
  // (scrolled as a person does: from the newest, upward — the app reads an
  // upward move that isn't its own as "reading", even 30 px up; its own
  // scroll near the bottom would read as "still at the bottom")
  const frames = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`;
  for (const [how, up] of [
    ["a third of the way down", `Math.round(box.scrollHeight * 2 / 3)`],
    ["30 px up from the newest", `30`],
  ]) {
    await dee.eval(`(chatScrollTo(document.getElementById("chat-messages").scrollHeight), chatStick.stuck = true, true)`);
    await dee.eval(frames);
    await dee.eval(`(() => {
      const box = document.getElementById("chat-messages");
      // (the browser's own scroll event follows — one, as a finger's would)
      box.scrollTop = box.scrollTop - ${up};
      return true;
    })()`);
    await dee.eval(frames);
    check(!(await dee.eval(`chatStick.stuck`)), `${how}: reading, not at the newest`);
    const place = await dee.eval(`(() => {
      const box = document.getElementById("chat-messages");
      window.__reading = [...box.querySelectorAll(".msg")][12];
      return ${at("window.__reading")};
    })()`);
    await dee.eval(`(receiveMsg(drivers[0], "read " + Math.random()), true)`);
    const placeAfter = await dee.eval(at("window.__reading"));
    check(Math.abs(placeAfter - place) <= 2, `${how}: the message read stays where it was`, JSON.stringify([place, placeAfter]));
  }

  step("after a reload, scrolled up: the ↓ count never past what's kept");
  const below = await dee.eval(`(() => {
    chatScrollTo(0);
    backToReadingPlace({ below: 30, lastId: 0, anchor: null }, chats.get(drivers[0]).msgs);
    return chatBelow;
  })()`);
  check(below === 20, "30 below: 20 shown", below);
  await dee.eval(`(chatScrollTo(document.getElementById("chat-messages").scrollHeight), chatStick.stuck = true, chatBelow = 0, updateChatJump(), true)`);

  step("the copy chip open on a message: a new one drops the oldest — the chip stays beside ITS message");
  const chip = await dee.eval(`(() => {
    const el = [...document.querySelectorAll("#chat-messages .msg")][12];
    el.click();
    window.__copied = el;
    const gap = () => copyChip.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const before = gap();
    receiveMsg(drivers[0], "under the chip");
    return [msgCopy.openOn(el), before, gap()];
  })()`);
  check(chip[0], "still open on it", JSON.stringify(chip));
  check(Math.abs(chip[2] - chip[1]) <= 2, "still beside it", JSON.stringify(chip));
  await dee.eval(`(msgCopy.close(), true)`);

  step("…and stays open when ANOTHER chat (one opened before: its bubbles exist) drops its oldest");
  await dee.eval(`(openPeerCard(drivers[1]), true)`);
  await dee.click("btn-msg");
  await dee.waitFor(`${chatOpen} && state.chatPeer === drivers[1]`, "the other chat open");
  await dee.eval(`(() => { for (let i = 1; i <= 3; i++) receiveMsg(drivers[1], "other " + i); return true; })()`);
  await dee.eval(`(openChat(drivers[0]), true)`);
  await dee.waitFor(`${chatOpen} && state.chatPeer === drivers[0]`, "back in the first chat");
  const copyKept = await dee.eval(`(() => {
    const el = [...document.querySelectorAll("#chat-messages .msg")].pop();
    el.click();
    const before = msgCopy.openOn(el);
    for (let i = 4; i <= 25; i++) receiveMsg(drivers[1], "other " + i);
    return [before, msgCopy.openOn(el), chats.get(drivers[1]).msgs.length];
  })()`);
  check(copyKept[0] && copyKept[1], "still open", JSON.stringify(copyKept));
  check(copyKept[2] === 20, "(the other chat did drop its oldest)", JSON.stringify(copyKept));
  await dee.eval(`(msgCopy.close(), true)`);

  step("a closed chat: 25 more arrive — the badge says 20 (all that's kept), the 'New messages' line above them all");
  await dee.eval(`(closeChat(), true)`);
  await dee.eval(`(() => { for (let i = 26; i <= 50; i++) receiveMsg(drivers[0], "line " + i); return true; })()`);
  check((await dee.eval(`chats.get(drivers[0]).unread`)) === 20, "unread 20, never past what's kept", await dee.eval(`chats.get(drivers[0]).unread`));
  check((await dee.eval(`HoodChatScroll.firstUnread(chats.get(drivers[0]).msgs, chats.get(drivers[0]).unread)`)) === 0, "the line above the first kept message");
  await dee.eval(`(openChat(drivers[0]), true)`);
  await dee.waitFor(`${chatOpen} && state.chatPeer === drivers[0]`, "the chat open again");
  check(await dee.eval(`!!document.querySelector("#chat-messages .new-line, #chat-messages [data-new-line]") || [...document.querySelectorAll("#chat-messages *")].some((e) => e.textContent === t("New messages"))`), "the 'New messages' line shown");
  // one more while it's open: the line's own message drops off — the line
  // moves to the first of theirs left (a reconnect redraws it from there)
  await dee.eval(`(receiveMsg(drivers[0], "line 51"), true)`);
  check(await dee.eval(`!!chatLineMsg && chats.get(drivers[0]).msgs.includes(chatLineMsg)`), "the line on a message still kept");
  // …and ON SCREEN above it — even when the first message left is one of
  // yours (the line goes above THEIR first, not yours)
  const lineAbove = await dee.eval(`(() => {
    const msgs = chats.get(drivers[0]).msgs;
    chatLineMsg = msgs[0];
    const line = document.querySelector("#chat-messages .chat-line");
    document.getElementById("chat-messages").insertBefore(line, bubbleOf.get(msgs[0]));
    msgs[1].mine = true; // (the next one: yours)
    receiveMsg(drivers[0], "line 52");
    const el = bubbleOf.get(chatLineMsg);
    return [!chatLineMsg.mine, document.querySelector("#chat-messages .chat-line").nextElementSibling === el];
  })()`);
  check(lineAbove[0] && lineAbove[1], "the line above their first message left", JSON.stringify(lineAbove));

  step("Dee replies: her message on the end, still 20");
  await typeText(dee, "ok!");
  await send(dee);
  const after = await dee.eval(`chats.get(drivers[0]).msgs.map((m) => m.text)`);
  check(after.length === 20 && after[19] === "ok!" && after[0] === "line 34", "her reply last, the oldest dropped", JSON.stringify([after.length, after[0], after[19]]));
});
