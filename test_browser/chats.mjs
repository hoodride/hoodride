// Chats across a reconnect or reopening the app (owner, 2026-10-30): a new
// chat and its text survive a reconnect; the text belongs to its person;
// what came while you were away is unread; the two "can't message them"
// refusals close the chat (text kept / dropped).
import { journey, step, check, BASE } from "./cdp.mjs";
import {
  goOnline,
  sees,
  openChatWith,
  typeText,
  box,
  send,
  chatOpenWith,
  closeChatPanel,
  textsFrom,
  unreadFrom,
  bannerIs,
  dropAndWait,
  restoreAndWait,
  signOut,
  shown,
  showsIcon,
} from "./app.mjs";

await journey("chats: across a reconnect or a reopen", async (browser) => {
  step("Rita (rider), Dan and Eve (drivers, online) sign in");
  const rita = await browser.person("BT-Rita");
  const dan = await browser.person("BT-Dan");
  const eve = await browser.person("BT-Eve");
  await goOnline(dan, { color: "Gray", make: "Honda", model: "Civic" });
  await goOnline(eve, { color: "Red", make: "Kia", model: "Soul" });
  const [ritaId, danId, eveId] = [await rita.id(), await dan.id(), await eve.id()];
  await sees(rita, danId);
  await sees(rita, eveId);

  // no photos here: each person is their initial on a colour of their own
  // (avatar.js; owner, 2026-11-01) — never a smiley
  step("no photo: the initial (Rita's top bar, Dan's chat header); a photo that fails: the initial too");
  const pic = (sel) => `(() => { const s = document.querySelector(${JSON.stringify(sel)}).src; return s.startsWith("data:image/svg+xml,") ? decodeURIComponent(s.slice(19)) : s; })()`;
  check((await rita.eval(pic("#account-photo"))).includes(">B</text>"), "Rita's top bar: B", await rita.eval(pic("#account-photo")));
  await openChatWith(rita, danId);
  check((await rita.eval(pic("#chat-photo"))).includes(">B</text>"), "Dan in the chat header: B", await rita.eval(pic("#chat-photo")));
  await rita.eval(`closeChat(), true`);
  await rita.eval(`(() => { for (const [id, name] of [["t-zed", "Zed"], ["t-emoji", "\u{1F60E}"]]) { const i = new Image(); i.id = id; i.className = "avatar"; i.dataset.name = name; document.body.append(i); i.src = "/no-such-photo.png"; } return true; })()`);
  await rita.waitFor(`${pic("#t-zed")}.includes(">Z</text>")`, "a photo that failed: Zed's initial");
  await rita.waitFor(`${pic("#t-emoji")}.startsWith("<svg") && !${pic("#t-emoji")}.includes("<text")`, "a name with no letter: the silhouette");
  await rita.eval(`document.getElementById("t-zed").remove(), document.getElementById("t-emoji").remove(), true`);

  step("Rita opens Dan's chat, types, sends nothing — the connection drops and comes back");
  await openChatWith(rita, danId);
  await typeText(rita, "draft for Dan");
  await dropAndWait(rita);
  await restoreAndWait(rita);
  check((await chatOpenWith(rita)) === danId, "Dan's chat is still open", await chatOpenWith(rita));
  check((await box(rita)) === "draft for Dan", "the text is still there", await box(rita));

  step("closed and reopened: the text is still there; Eve's chat: an empty box");
  await closeChatPanel(rita);
  await openChatWith(rita, danId);
  check((await box(rita)) === "draft for Dan", "kept for Dan", await box(rita));
  await openChatWith(rita, eveId);
  check((await box(rita)) === "", "Eve's box is empty (never Dan's text)", await box(rita));

  step("Rita messages Dan; Dan gets it");
  await openChatWith(rita, danId);
  await typeText(rita, "hi Dan");
  await send(rita);
  await dan.waitFor(`chats.has(realPeersById.get(${ritaId})) && chatFor(realPeersById.get(${ritaId})).msgs.some(m => m.text === "hi Dan")`, "Dan has Rita's message");

  step("Rita's connection drops; Dan replies meanwhile; back — unread, on the button");
  await closeChatPanel(rita);
  await dropAndWait(rita);
  await dan.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await typeText(dan, "reply while you were away");
  await send(dan);
  await dan.waitFor(`chatFor(realPeersById.get(${ritaId})).msgs.some(m => m.text === "reply while you were away")`, "Dan's reply shown as sent");
  await restoreAndWait(rita);
  await rita.waitFor(`chatFor(realPeersById.get(${danId})).msgs.some(m => m.text === "reply while you were away")`, "Rita has the reply");
  check((await unreadFrom(rita, danId)) === 1, "1 unread from Dan", await unreadFrom(rita, danId));
  check((await shown(rita, "#btn-chat")) === "💬 Chat (1)", "💬 Chat (1)", await shown(rita, "#btn-chat"));
  check(await showsIcon(rita, "#btn-chat", "chat.svg"), "Chat: the speech-balloon picture");

  step("Rita reads it; the app closes; Dan writes; the app opens — unread again");
  await openChatWith(rita, danId);
  check((await unreadFrom(rita, danId)) === 0, "read once opened");
  await closeChatPanel(rita);
  await rita.goto(`${BASE}/privacy`);
  await typeText(dan, "while your app was closed");
  await send(dan);
  await dan.waitFor(`chatFor(realPeersById.get(${ritaId})).msgs.some(m => m.text === "while your app was closed")`, "sent");
  await rita.open();
  await rita.waitFor(`realPeersById.has(${danId}) && chats.has(realPeersById.get(${danId}))`, "Rita's chats rebuilt");
  check((await unreadFrom(rita, danId)) === 1, "1 unread after reopening", await unreadFrom(rita, danId));
  check((await textsFrom(rita, danId)).includes("reply while you were away"), "the older reply is there too");

  // connected, but the message is lost on the way: no answer is not "sent"
  step("Rita's message to Dan never gets an answer: the bubble goes, the text comes back");
  await openChatWith(rita, danId);
  await typeText(rita, "lost on the way");
  await rita.eval(`(() => { const c = socket.conn; window.__send = c.send.bind(c); c.send = (d) => { if (!String(d).includes('"send_msg"')) window.__send(d); }; return true; })()`);
  await send(rita);
  check((await textsFrom(rita, danId)).includes("lost on the way"), "shown as sent at first");
  // Phoenix gives up on an answer after 10 s
  await rita.waitFor(`document.getElementById("banner").textContent === "Message didn't send — try again"`, "the no-answer message", 15000);
  await rita.eval(`(socket.conn.send = window.__send, true)`);
  check(!(await rita.eval(`chatFor(realPeersById.get(${danId})).msgs.some(m => m.mine && m.text === "lost on the way")`)), "not shown as sent");
  check((await box(rita)) === "lost on the way", "the text is back in the box", await box(rita));
  check(await rita.eval("liveNow()"), "still connected throughout");
  await typeText(rita, "");
  await closeChatPanel(rita);

  step("Eve isn't in view: the chat closes, Rita's text is kept for Eve");
  await sees(rita, eveId);
  await openChatWith(rita, eveId);
  await typeText(rita, "for Eve");
  const home = await rita.eval(`(() => { const c = map.getCenter(); return [c.lng, c.lat, map.getZoom()]; })()`);
  await rita.eval(`map.jumpTo({center: [-73.95, 40.65], zoom: ${home[2]}}), true`);
  await rita.waitFor(`!realEntries.has(${eveId})`, "Eve's car is off Rita's map");
  await send(rita);
  await bannerIs(rita, "BT-Eve isn't in view — zoom in and find their car again");
  check((await chatOpenWith(rita)) === null, "the chat closed");
  check((await box(rita)) === "for Eve", "the text kept", await box(rita));

  step("back in view, Eve goes offline: 'isn't available', the chat closes, the text is dropped");
  await rita.eval(`map.jumpTo({center: [${home[0]}, ${home[1]}], zoom: ${home[2]}}), true`);
  await sees(rita, eveId);
  await openChatWith(rita, eveId);
  check((await box(rita)) === "for Eve", "Eve's text is back", await box(rita));
  await eve.click("btn-online");
  await eve.waitFor("!state.online", "Eve offline");
  await rita.waitFor(`!realEntries.has(${eveId})`, "Eve's car gone from Rita's map");
  await send(rita);
  await bannerIs(rita, "BT-Eve isn't available right now");
  check((await chatOpenWith(rita)) === null, "the chat closed");
  check((await box(rita)) === "", "the text dropped", await box(rita));

  // the privacy page: "Signing out removes them" — which messages you've read
  step("Rita signs out: this device no longer knows which messages she read");
  const noteKey = await rita.eval(`HoodReadStore.key(state.realUser.id)`);
  check(await rita.eval(`localStorage.getItem(${JSON.stringify(noteKey)}) !== null`), "the read note exists before");
  await signOut(rita);
  check(await rita.eval(`localStorage.getItem(${JSON.stringify(noteKey)}) === null`), "the read note is gone");
  check(await rita.eval(`!Object.keys(localStorage).some((k) => k.startsWith("hoodride_read_"))`), "no read note for anyone");
});
