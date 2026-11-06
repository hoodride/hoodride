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

  // in one chat, another's message never waits unseen: its count beside ‹
  // (owner, 2026-11-05: iPhone Messages, Telegram)
  // (Fay, not Eve: Eve stays someone Rita never wrote to — the "isn't in
  // view" step below needs a first contact)
  step("in Dan's chat, Fay writes: ‹ 1; the banner and the list don't read it — opening her chat does");
  const fay = await browser.person("BT-Fay");
  await goOnline(fay, { color: "Blue", make: "Ford", model: "Focus" });
  const fayId = await fay.id();
  await sees(rita, fayId);
  const backCount = () => rita.eval(`(() => { const b = document.getElementById("chat-back"), c = document.getElementById("chat-back-count"); return { shown: !b.classList.contains("hidden") && !c.classList.contains("hidden"), count: c.textContent, inside: b.contains(c), height: c.getBoundingClientRect().height }; })()`);
  const fayRow = () => rita.eval(`(() => { const r = [...document.querySelectorAll("#chat-list .chat-item, .chat-item")].find((i) => i.querySelector("strong")?.textContent === "BT-Fay"); return r ? { bold: r.classList.contains("unread"), dot: r.querySelector(".unread-dot")?.textContent ?? null } : null; })()`);
  await openChatWith(rita, fayId);
  await typeText(rita, "hi Fay");
  await send(rita);
  await fay.waitFor(`chats.has(realPeersById.get(${ritaId})) && chatFor(realPeersById.get(${ritaId})).msgs.some(m => m.text === "hi Fay")`, "Fay has Rita's message");
  await openChatWith(rita, danId);
  check(!(await backCount()).shown, "nothing waiting: a plain ‹", await backCount());
  await fay.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await typeText(fay, "hi Rita");
  await send(fay);
  await rita.waitFor(`chatFor(realPeersById.get(${fayId})).msgs.some(m => m.text === "hi Rita")`, "Rita has Fay's message");
  // the banner popped up — and reading it isn't reading the chat
  await rita.waitFor(`document.getElementById("banner").textContent.includes("BT-Fay: hi Rita")`, "the banner: Fay's message");
  const waiting = await backCount();
  check(waiting.shown && waiting.count === "1" && waiting.inside && waiting.height > 0, "‹ 1: Fay's message, seen from Dan's chat", waiting);
  check((await chatOpenWith(rita)) === danId, "still in Dan's chat", await chatOpenWith(rita));
  check((await unreadFrom(rita, fayId)) === 1, "the banner didn't read it");
  // the list shows it — bold, its number — and showing it isn't reading it
  await rita.click("chat-back");
  check(JSON.stringify(await fayRow()) === JSON.stringify({ bold: true, dot: "1" }), "the list: Fay bold, 1", await fayRow());
  check((await unreadFrom(rita, fayId)) === 1, "the list didn't read it");
  // opening her chat does — everywhere: ‹, the list, 💬 Chat
  await openChatWith(rita, fayId);
  check((await unreadFrom(rita, fayId)) === 0, "read once her chat opens");
  await openChatWith(rita, danId);
  check(!(await backCount()).shown, "back in Dan's chat: a plain ‹ again", await backCount());
  await rita.click("chat-back");
  check(JSON.stringify(await fayRow()) === JSON.stringify({ bold: false, dot: null }), "the list: Fay no longer bold, no number", await fayRow());
  await closeChatPanel(rita);
  check((await shown(rita, "#btn-chat")) === "💬 Chat", "💬 Chat, no count", await shown(rita, "#btn-chat"));

  // a long chat opens on its newest message (owner, 2026-11-05) — and again
  // after reading back to the top and closing it. All THEIR messages: your
  // own always pull the chat down, which hid a missing scroll
  step("a long chat (40 messages) opens at the bottom — again after scrolling up");
  await rita.eval(`(() => { const c = chatFor(realPeersById.get(${fayId})); for (let i = 1; i <= 40; i++) c.msgs.push({ text: "line " + i, mine: false, at: Date.now(), ts: null, id: null }); return true; })()`);
  const scroll = () => rita.eval(`(() => { const b = document.getElementById("chat-messages"); const last = [...b.querySelectorAll(".msg")].pop(); const lr = last?.getBoundingClientRect(), br = b.getBoundingClientRect(); return { scrolls: b.scrollHeight > b.clientHeight + 100, fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), lastText: last?.textContent, lastInView: !!lr && lr.bottom <= br.bottom + 1 && lr.top >= br.top - 1 }; })()`);
  // opened from the map (the panel closed): at the newest message at once
  // and in the FIRST painted frame — never the oldest first, then a jump
  // (it used to: drawn while the panel was hidden)
  const firstFrame = await rita.eval(`new Promise((done) => { closeChat(); openChat(realPeersById.get(${fayId})); const b = document.getElementById("chat-messages"); const at = () => Math.round(b.scrollHeight - b.scrollTop - b.clientHeight); const now = at(); requestAnimationFrame(() => requestAnimationFrame(() => done({ now, afterFirstPaint: at() }))); })`);
  check(firstFrame.now <= 2 && firstFrame.afterFirstPaint <= 2, "the first painted frame: the newest message (no jump)", firstFrame);
  await closeChatPanel(rita);
  await openChatWith(rita, fayId);
  const opened = await scroll();
  check(opened.scrolls && opened.fromBottom <= 2 && opened.lastText === "line 40" && opened.lastInView, "opened at the newest message", opened);
  // scrolling up only once the opening has SETTLED: while the box is
  // resizing (the panel just shown), a scroll counts as the resize's and the
  // app keeps a reader at the bottom (HoodChatScroll's stick) — a finger
  // can't land in that one frame, but code can: on a busy machine (a full
  // gate) the test's scroll-up did, and was pulled back down (owner,
  // 2026-11-05 — caught: onChatResize's scroll, 2 ms after)
  const settled = () => rita.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 20))))`);
  const scrollUp = async () => {
    await settled();
    await rita.eval(`(document.getElementById("chat-messages").scrollTop = 0, document.getElementById("chat-messages").dispatchEvent(new Event("scroll")), true)`);
    await rita.waitFor(`chatStick.stuck === false`, "Rita reading back (scrolled up)");
  };
  await scrollUp();
  const up = await scroll();
  check(up.fromBottom > 100, "scrolled up to the top", up);
  await closeChatPanel(rita);
  await openChatWith(rita, fayId);
  const reopened = await scroll();
  check(reopened.fromBottom <= 2 && reopened.lastInView, "reopened: at the newest message again", reopened);
  // and from the list (the panel stays open — no resize puts it right: the
  // open's own scroll must)
  await rita.click("chat-back");
  await openChatWith(rita, fayId);
  const fromList = await scroll();
  check(fromList.fromBottom <= 2 && fromList.lastInView, "from the list: at the newest message too", fromList);
  // scrolled up, then a chat opened straight away, the panel open (Message
  // on a car), in a chat with none of YOUR messages (someone wrote first;
  // no reply yet): only the open's own scroll brings it down. (Your own
  // message, redrawn, pulls the chat down by itself — "yours always
  // follows" — which hid this: measured, owner 2026-11-05. Rita's own
  // taken out of her screen's copy only; nothing sent)
  await rita.eval(`(() => { const c = chatFor(realPeersById.get(${fayId})); c.msgs = c.msgs.filter((m) => !m.mine); openChat(realPeersById.get(${fayId})); return true; })()`);
  await scrollUp();
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  const direct = await scroll();
  check(direct.fromBottom <= 2 && direct.lastInView, "opened straight from a scrolled-up chat: at the newest message", direct);
  await closeChatPanel(rita);

  // more than a screen unread (owner, 2026-11-05 — as Telegram, Slack,
  // Discord): the chat opens at the first of them, a "New messages" line
  // just above; it stays put while you're there, and goes when you reply.
  // ↓ (the bottom corner) whenever you're scrolled up, counting what comes
  // in below you; a tap: the newest. A few unread: the newest, no line.
  // (Fay's messages arrive as the socket hands them over: receiveMsg)
  step("Fay sends 30 while Rita's away: they open at a 'New messages' line; ↓ down; ↓ 3 when more come; a reply ends the line");
  const view = () => rita.eval(`(() => {
    const b = document.getElementById("chat-messages"), br = b.getBoundingClientRect();
    const line = b.querySelector(".chat-line");
    const next = line && line.nextElementSibling;
    const j = document.getElementById("chat-jump"), jr = j.getBoundingClientRect();
    const badge = document.getElementById("chat-jump-count");
    return {
      line: line ? { text: line.textContent, fromTop: Math.round(line.getBoundingClientRect().top - br.top), lines: b.querySelectorAll(".chat-line").length } : null,
      after: next ? next.textContent : null,
      fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
      jump: !j.classList.contains("hidden"),
      badge: badge.classList.contains("hidden") ? null : badge.textContent,
      corner: jr.right <= br.right && br.right - jr.right < 40 && jr.left > br.left + br.width / 2,
    };
  })()`);
  const fayWrites = (prefix, n) => rita.eval(`(() => { const p = realPeersById.get(${fayId}); for (let i = 1; i <= ${n}; i++) receiveMsg(p, "${prefix} " + i); return true; })()`);
  await fayWrites("new", 30);
  check((await unreadFrom(rita, fayId)) === 30, "30 unread from Fay", await unreadFrom(rita, fayId));
  await openChatWith(rita, fayId);
  await settled();
  const atLine = await view();
  check(!!atLine.line && atLine.line.lines === 1 && atLine.line.text === "New messages" && atLine.after === "new 1", "a 'New messages' line, just above the first new one", atLine);
  check(atLine.line.fromTop >= 0 && atLine.line.fromTop < 40 && atLine.fromBottom > 100, "opened at the line, near the top — not the newest", atLine);
  check(atLine.jump && atLine.badge === null && atLine.corner, "↓ in the bottom corner, no count: nothing came in since", atLine);
  check((await unreadFrom(rita, fayId)) === 0, "opening read them all");

  await rita.click("chat-jump");
  const down = await view();
  check(down.fromBottom <= 2 && !down.jump, "↓ tapped: at the newest, the button gone", down);
  check(!!down.line && down.line.lines === 1, "the line stays put while she's here", down);

  await scrollUp();
  const upAgain = await view();
  check(upAgain.jump && upAgain.badge === null, "scrolled up: ↓, no count", upAgain);
  await fayWrites("more", 3);
  const three = await view();
  check(three.jump && three.badge === "3" && three.fromBottom > 100, "3 came in below: ↓ 3, and Rita stays where she's reading", three);
  await rita.click("chat-jump");
  const down3 = await view();
  check(down3.fromBottom <= 2 && !down3.jump && down3.badge === null, "↓ 3 tapped: at the newest; the button and its count gone", down3);

  await typeText(rita, "thanks Fay");
  await send(rita);
  const replied = await view();
  check(replied.line === null, "Rita replies: caught up, the line goes", replied);

  await closeChatPanel(rita);
  await fayWrites("few", 2);
  await openChatWith(rita, fayId);
  await settled();
  const few = await view();
  check(few.line === null && few.fromBottom <= 2 && !few.jump, "2 unread: they fit — the newest, no line, no ↓", few);
  // …and from the list, the panel already open (nothing resizing to hide
  // it): taking the line back out shortened the chat, the browser moved the
  // list up to fit, and that move read as Rita scrolling up — ↓ at the
  // bottom (the gate caught it, owner 2026-11-05: only on a busy machine)
  await rita.click("chat-back");
  await fayWrites("list", 2);
  await openChatWith(rita, fayId);
  await settled();
  const fromList2 = await view();
  check(fromList2.line === null && fromList2.fromBottom <= 2 && !fromList2.jump, "from the list, 2 unread: the newest, no line, no ↓", fromList2);
  await closeChatPanel(rita);

  // two other chats add up; opening one takes off ALL of its messages at
  // once — a whole chat, never one message at a time (owner, 2026-11-05)
  step("in Dan's chat: Fay writes 3, Gus 2 — ‹ 5; Fay's opened → ‹ 2; Gus's → plain ‹");
  const gus = await browser.person("BT-Gus");
  await goOnline(gus, { color: "Black", make: "Mazda", model: "3" });
  const gusId = await gus.id();
  await sees(rita, gusId);
  await openChatWith(rita, gusId);
  await typeText(rita, "hi Gus");
  await send(rita);
  await gus.waitFor(`chats.has(realPeersById.get(${ritaId})) && chatFor(realPeersById.get(${ritaId})).msgs.some(m => m.text === "hi Gus")`, "Gus has Rita's message");
  await gus.eval(`openChat(realPeersById.get(${ritaId})), true`);
  await openChatWith(rita, danId);
  for (const n of [1, 2, 3]) {
    await typeText(fay, `fay ${n}`);
    await send(fay);
  }
  for (const n of [1, 2]) {
    await typeText(gus, `gus ${n}`);
    await send(gus);
  }
  await rita.waitFor(`chatFor(realPeersById.get(${fayId})).unread === 3 && chatFor(realPeersById.get(${gusId})).unread === 2`, "Rita: 3 unread from Fay, 2 from Gus");
  const five = await backCount();
  check(five.shown && five.count === "5", "‹ 5: both chats, added up", five);
  await rita.click("chat-back");
  await openChatWith(rita, fayId);
  check((await unreadFrom(rita, fayId)) === 0, "all 3 of Fay's read at once");
  await openChatWith(rita, danId);
  const two = await backCount();
  check(two.shown && two.count === "2", "‹ 2: Gus's left", two);
  await rita.click("chat-back");
  await openChatWith(rita, gusId);
  await openChatWith(rita, danId);
  check(!(await backCount()).shown, "Gus's read too: a plain ‹", await backCount());
  await closeChatPanel(rita);
  await gus.close();
  await fay.close();

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
