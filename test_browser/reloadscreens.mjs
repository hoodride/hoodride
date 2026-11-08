// What's open on screen stays open across a reload (owner, 2026-11-07):
// every join of the connection reloads the app from the server — right
// after opening it, and after any blip. The list of who's in one block (a
// pile of cars) closed under your finger; the chat list was already kept,
// and now has a check too. (The chat, a person's card, a draft, Meet here:
// tapreload.mjs, chats.mjs, chatback.mjs.)
import { journey, step, check, server as onServer } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
  await new Promise((r) => setTimeout(r, 300));
};

await journey("reloadscreens: what's open on screen stays open across a reload", async (browser) => {
  step("Dora and Ed park in the same block: Sam opens the pile's list of names");
  const sam = await browser.person("BT-Sam");
  const dora = await browser.person("BT-Dora");
  const ed = await browser.person("BT-Ed");
  await goOnline(dora);
  await goOnline(ed, { color: "Red", make: "Kia", model: "Soul" });
  const [doraId, edId, samId] = [await dora.id(), await ed.id(), await sam.id()];
  await sees(sam, doraId);
  await sees(sam, edId);
  const key = await sam.waitFor(`[...pileMarkers.values()].find((pm) => pm.ids.length === 2)?.key`, "a pile of two");
  await sam.eval(`openPileSheet(${JSON.stringify(key)}), true`);
  const names = `["BT-Dora", "BT-Ed"].every((n) => document.getElementById("pile-list").textContent.includes(n))`;
  await sam.waitFor(names, "both names in the list", 15000);

  step("a reload: the list is still open, both names in it");
  await reload(sam);
  check(await sam.eval(`!document.getElementById("pile-sheet").classList.contains("hidden") && state.pileKey === ${JSON.stringify(key)}`), "the list still open");
  await sam.waitFor(names, "both names still in it");

  // a name the server refused (the person's name not to be had) stays so
  // across a reload — asking again each reload spent a name lookup every
  // time on a flaky connection; Sam opening the list himself asks again
  step("a name refused before stays refused across a reload; opening the list himself asks again");
  await sam.eval(`(realPeersById.get(${edId}).revealGone = true), true`);
  await reload(sam);
  check(await sam.eval(`!document.getElementById("pile-sheet").classList.contains("hidden") && realPeersById.get(${edId}).revealGone === true`), "after the reload: the list open, Ed still refused");
  await sam.eval(`(closePileSheet(), openPileSheet(${JSON.stringify(key)})), true`);
  check(await sam.eval(`realPeersById.get(${edId}).revealGone === false`), "opened by Sam: asked again");
  await sam.waitFor(names, "both names in it");

  // a busy block's list scrolls (here made short so two rows do): a reload
  // leaves it where Sam was reading — it went back to the top when the
  // reload laid the page out meanwhile (Dora's chat open beside it: drawing
  // it again does)
  step("Dora's chat open, and the list of a busy block scrolled down: a reload leaves the list where Sam was");
  await sam.eval(`openChat(realPeersById.get(${doraId})), true`);
  await sam.eval(`openPileSheet(${JSON.stringify(key)}), true`);
  await sam.waitFor(names, "both names in it");
  const pileAt = await sam.eval(`(() => { const l = document.getElementById("pile-list"); l.style.maxHeight = "40px"; l.scrollTop = 30; return { top: Math.round(l.scrollTop), scrolls: l.scrollHeight > l.clientHeight, chat: !document.getElementById("chat").classList.contains("hidden") }; })()`);
  check(pileAt.chat, "(Dora's chat open beside it)", pileAt);
  check(pileAt.scrolls && pileAt.top > 0, "(the list scrolls; Sam scrolled down)", pileAt);
  await reload(sam);
  const pileBack = await sam.eval(`({ open: !document.getElementById("pile-sheet").classList.contains("hidden"), top: Math.round(document.getElementById("pile-list").scrollTop) })`);
  check(pileBack.open && pileBack.top === pileAt.top, "the list open, where he was", { pileAt, pileBack });
  await sam.eval(`(document.getElementById("pile-list").style.maxHeight = "", closePileSheet(), closeChat()), true`);

  // only a pile of two or more has a list — whoever asks for it (a reload
  // reopening it, after the pile shrank): one person is their card, none is
  // nothing (owner, 2026-11-07: an empty sheet otherwise)
  step("Sam closed the pile's list; a reload: it stays closed");
  await reload(sam);
  check(await sam.eval(`document.getElementById("pile-sheet").classList.contains("hidden") && state.pileKey === null`), "the list still closed");

  step("the list of a pile that's down to one, or gone: it doesn't open");
  const sheetOpen = `!document.getElementById("pile-sheet").classList.contains("hidden")`;
  const downToOne = await sam.eval(`(() => {
    const pm = pileMarkers.get(${JSON.stringify(key)}); const all = pm.ids;
    pm.ids = [all[0]]; openPileSheet(pm.key); const open = ${sheetOpen};
    pm.ids = all; return { open, pileKey: state.pileKey };
  })()`);
  check(!downToOne.open && downToOne.pileKey === null, "down to one: no list", downToOne);
  const gone = await sam.eval(`(() => { openPileSheet("driver:nowhere"); return { open: ${sheetOpen}, pileKey: state.pileKey }; })()`);
  check(!gone.open && gone.pileKey === null, "gone: no list", gone);
  await sam.eval(`openPileSheet(${JSON.stringify(key)}), true`);
  await sam.waitFor(names, "two: the list, both names");
  await sam.eval(`closePileSheet(), true`);

  step("Sam's chat list is open; Dora's answer reaches him only through a reload: it's in the list, and her row opens her chat");
  await openChatWith(sam, doraId);
  await typeText(sam, "hi Dora");
  await send(sam);
  await sam.eval(`closeChat(), true`);
  await openChatWith(sam, edId);
  await typeText(sam, "hi Ed");
  await send(sam);
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the chat list open");
  // his live connection doesn't deliver her answer
  await sam.eval(`(() => { window.__drop = true; const on = userChannel.trigger.bind(userChannel); userChannel.trigger = (ev, ...a) => (window.__drop && ev === "msg") ? undefined : on(ev, ...a); return true; })()`);
  await dora.waitFor(`realPeersById.has(${samId}) && chats.has(realPeersById.get(${samId}))`, "Dora has Sam's message");
  await dora.eval(`openChat(realPeersById.get(${samId})), true`);
  await typeText(dora, "yes?");
  await send(dora);
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await sam.eval(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "yes?")`)), "(not heard live)");
  await sam.eval(`window.__drop = false, true`);
  await reload(sam);
  check(await sam.eval(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`), "the list still open");
  const top = await sam.eval(`(() => { const r = document.querySelector("#chat-messages .chat-item"); return r && { name: r.querySelector("strong").textContent, unread: r.querySelector(".unread-dot")?.textContent ?? null, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
  check(JSON.stringify(top) === JSON.stringify({ name: "BT-Dora", unread: "1", line: "yes?" }), "Dora on top: 1 unread, 'yes?'", top);
  await sam.eval(`([...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === "BT-Dora").click(), true)`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === ${doraId}`, "her row opens her chat");

  // a message Sam's live connection doesn't deliver: he gets it only from
  // the reload
  const unheard = async (from, text) => {
    await sam.eval(`(() => { if (!window.__deaf) { const on = userChannel.trigger.bind(userChannel); userChannel.trigger = (ev, ...a) => (window.__drop && ev === "msg") ? undefined : on(ev, ...a); window.__deaf = true; } window.__drop = true; return true; })()`);
    await from.waitFor(`realPeersById.has(${samId}) && chats.has(realPeersById.get(${samId}))`, `${from.name} has Sam's chat`);
    await from.eval(`openChat(realPeersById.get(${samId})), true`);
    await typeText(from, text);
    await send(from);
    await new Promise((r) => setTimeout(r, 1500));
    await sam.eval(`window.__drop = false, true`);
  };
  const row = (name) =>
    sam.eval(`(() => { const r = [...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === ${JSON.stringify(name)}); return r && { unread: r.querySelector(".unread-dot")?.textContent ?? null, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);

  // the list showing, the last chat Ed's (‹ from it): the reload must not
  // mark his news read — Sam hasn't seen it
  step("‹ from Ed's chat to the list; Ed writes, Sam gets it only from a reload: Ed's row says 1 unread");
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list (from Ed's chat)");
  await unheard(ed, "you there?");
  await reload(sam);
  check(JSON.stringify(await row("BT-Ed")) === JSON.stringify({ unread: "1", line: "you there?" }), "Ed's row: 1 unread", await row("BT-Ed"));
  check((await sam.eval(`chatFor(realPeersById.get(${edId})).unread`)) === 1, "counted unread");

  step("inside Ed's chat, his next message arrives only through a reload: read (it's on screen)");
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer.id === ${edId}`, "Ed's chat open");
  await unheard(ed, "ok?");
  await reload(sam);
  check(await sam.eval(`state.chatView !== "list" && state.chatPeer.id === ${edId} && chatFor(state.chatPeer).msgs.some((m) => m.text === "ok?")`), "Ed's chat open, 'ok?' in it");
  check((await sam.eval(`chatFor(realPeersById.get(${edId})).unread`)) === 0, "read");
  await sam.eval(`closeChat(), true`);

  // the list opened from 💬 Chat on a fresh start, before any chat was: a
  // reload left the old rows on screen
  step("the app opened afresh, 💬 Chat: the list; Dora writes, Sam gets it only from a reload: it's in the list");
  await sam.open();
  await sam.waitFor(`hydrated && !reloading && chats.size === 2`, "loaded, two chats");
  // (the reload before marked Ed's "ok?" read on screen — saved too: the
  // app opened afresh still counts it read)
  check((await sam.eval(`chatFor(realPeersById.get(${edId})).unread`)) === 0, "Ed's 'ok?' still read after the app opened afresh", await sam.eval(`chatFor(realPeersById.get(${edId})).unread`));
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden") && !state.chatPeer`, "the list, no chat opened yet");
  await unheard(dora, "still there?");
  await reload(sam);
  check(await sam.eval(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`), "the list still open");
  check(JSON.stringify(await row("BT-Dora")) === JSON.stringify({ unread: "1", line: "still there?" }), "Dora's row: 1 unread, 'still there?'", await row("BT-Dora"));

  // server times are whole seconds: two last messages in the same second
  // tied, and the older chat could sit on top after a reload (the gate
  // caught it on a busy machine, owner 2026-11-07). Both orders, so a tie
  // left to chance fails one of them
  const say = (p, text) =>
    p.eval(`new Promise((done) => userChannel.push("send_msg", { to: ${samId}, text: ${JSON.stringify(text)} }).receive("ok", done).receive("error", (e) => done({ error: e.reason })).receive("timeout", () => done({ error: "timeout" })))`);
  const sameSecond = async (first, second, live = false) => {
    for (let tries = 1; tries <= 5; tries++) {
      if (!live) await sam.eval(`window.__drop = true, true`);
      // just after a second starts: both land inside it
      await first.eval(`new Promise((done) => setTimeout(() => done(true), 1020 - (Date.now() % 1000)))`);
      const a = await say(first, `${first.name} first ${tries}`);
      const b = await say(second, `${second.name} next ${tries}`); // after the first's answer: later on the server
      check(!a.error && !b.error, "both sent", { a, b });
      await new Promise((r) => setTimeout(r, 1000));
      await sam.eval(`window.__drop = false, true`);
      if (a.ts === b.ts) return `${second.name} next ${tries}`;
    }
    check(false, "two messages in one second (5 tries)");
  };
  for (const [first, second] of [
    [ed, dora],
    [dora, ed],
  ]) {
    step(`${first.name}, then ${second.name}, write in the same second; Sam gets both only from a reload: ${second.name}'s on top`);
    const last = await sameSecond(first, second);
    await reload(sam);
    const tie = await sam.eval(`chatFor(realPeersById.get(${doraId})).lastAt === chatFor(realPeersById.get(${edId})).lastAt`);
    check(tie, "(the same time on both)");
    const onTop = await sam.eval(`(() => { const r = document.querySelector("#chat-messages .chat-item"); return r && { name: r.querySelector("strong").textContent, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
    check(JSON.stringify(onTop) === JSON.stringify({ name: second.name, line: last }), `${second.name} on top`, onTop);
  }

  // the same, heard live (no reload): each message brings its id
  for (const [first, second] of [
    [ed, dora],
    [dora, ed],
  ]) {
    step(`live: ${first.name}, then ${second.name}, write in the same second while Sam's list is open: ${second.name}'s on top`);
    const last = await sameSecond(first, second, true);
    await sam.waitFor(`[...chats.values()].some((c) => c.msgs.some((m) => m.text === ${JSON.stringify(last)}))`, "Sam heard both");
    check(await sam.eval(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`), "the list still open");
    const tie = await sam.eval(`chatFor(realPeersById.get(${doraId})).lastAt === chatFor(realPeersById.get(${edId})).lastAt`);
    check(tie, "(the same time on both)");
    const onTop = await sam.eval(`(() => { const r = document.querySelector("#chat-messages .chat-item"); return r && { name: r.querySelector("strong").textContent, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
    check(JSON.stringify(onTop) === JSON.stringify({ name: second.name, line: last }), `${second.name} on top`, onTop);
  }

  // yours had this phone's exact time, theirs the start of its second: Sam
  // writes Ed at :00.3, Dora's comes at :00.5 stamped :00.0 — Ed stayed on
  // top (owner, 2026-11-07). Once the server confirms Sam's, it's timed as
  // theirs are
  step("live: Sam writes Ed, then Dora writes Sam in the same second: Dora's on top");
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer.id === ${edId}`, "Ed's chat open");
  let dorasLast = null;
  for (let tries = 1; tries <= 5 && !dorasLast; tries++) {
    await sam.eval(`new Promise((done) => setTimeout(() => done(true), 1020 - (Date.now() % 1000)))`);
    await typeText(sam, `to Ed ${tries}`);
    await send(sam);
    const mine = await sam.waitFor(`(() => { const m = chatFor(realPeersById.get(${edId})).msgs.at(-1); return m.text === "to Ed ${tries}" && m.id != null && m; })()`, "the server confirmed Sam's");
    const theirs = await say(dora, `Dora after ${tries}`);
    check(!theirs.error, "Dora's sent", theirs);
    await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "Dora after ${tries}")`, "Sam heard Dora");
    if (mine.ts === theirs.ts) dorasLast = `Dora after ${tries}`;
  }
  check(!!dorasLast, "Sam's and Dora's in one second (5 tries)");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  const top2 = await sam.eval(`(() => { const r = document.querySelector("#chat-messages .chat-item"); return r && { name: r.querySelector("strong").textContent, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
  check(JSON.stringify(top2) === JSON.stringify({ name: "BT-Dora", line: dorasLast }), "Dora on top", top2);

  // a slow connection: Ed's reply arrives before the server's "sent" for
  // Sam's message — that "sent" mustn't make Sam's the chat's last again
  step("Sam's 'sent' comes late, after Ed's reply: Ed's reply stays the chat's last");
  await sam.eval(`window.__okMs = 5000, true`);
  await sam.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, ...a) => {
      const p = orig(ev, ...a);
      if (ev !== "send_msg") return p;
      const rcv = p.receive.bind(p);
      p.receive = (status, cb) => rcv(status, status === "ok" ? (r) => setTimeout(() => { cb(r); window.__lateOk = true; }, window.__okMs ?? 2500) : cb);
      return p;
    };
    return true;
  })()`);
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await typeText(sam, "slow to Ed");
  await send(sam);
  await ed.waitFor(`chatFor(realPeersById.get(${samId})).msgs.some((m) => m.text === "slow to Ed")`, "Ed has it");
  const reply = await say(ed, "Ed's quick reply");
  check(!reply.error, "Ed's reply sent", reply);
  await sam.waitFor(`chatFor(realPeersById.get(${edId})).msgs.at(-1).text === "Ed's quick reply"`, "Sam heard Ed's reply");
  check(!(await sam.eval(`!!window.__lateOk`)), "(Sam's 'sent' not here yet)");
  await sam.waitFor(`window.__lateOk`, "Sam's 'sent' came", 6000);
  const edChat = await sam.eval(`(() => { const c = chatFor(realPeersById.get(${edId})); const mine = c.msgs.find((m) => m.text === "slow to Ed"); return { lastId: c.lastId, lastAt: c.lastAt, replyId: c.msgs.at(-1).id, replyAt: c.msgs.at(-1).at, mineId: mine.id }; })()`);
  check(edChat.mineId != null, "Sam's message got its server id", edChat);
  check(edChat.lastId === reply.id && edChat.lastAt === edChat.replyAt, "Ed's reply still the chat's last", edChat);
  await sam.eval(`window.__okMs = undefined, true`);

  // a refused message is taken back — and so is the chat's time: it put the
  // chat on top of the list, "now", with nothing sent (owner, 2026-11-07).
  // A real refusal (a letter with 31 marks stacked on it), its answer held
  // 2 s: Sam is back on the list when it comes
  const refused = "a" + "́".repeat(31);
  step("Dora writes; Sam writes Ed something the server refuses, and goes back to the list before the answer: Dora's back on top, Ed's row a draft");
  const doraNews = await say(dora, "Dora again");
  check(!doraNews.error, "Dora's sent", doraNews);
  await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "Dora again")`, "Sam heard Dora");
  await sam.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, ...a) => {
      const p = orig(ev, ...a);
      if (ev !== "send_msg") return p;
      const rcv = p.receive.bind(p);
      p.receive = (status, cb) => rcv(status, status === "error" ? (r) => setTimeout(() => { cb(r); window.__lateNo = true; }, window.__noMs ?? 2000) : cb);
      return p;
    };
    return true;
  })()`);
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await typeText(sam, refused);
  await send(sam);
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  const rowNames = () => sam.eval(`[...document.querySelectorAll("#chat-messages .chat-item strong")].map((e) => e.textContent)`);
  check((await rowNames())[0] === "BT-Ed", "(the list before the answer: Ed on top, as if sent)", await rowNames());
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  await new Promise((r) => setTimeout(r, 100));
  const afterNo = await sam.eval(`(() => { const rows = [...document.querySelectorAll("#chat-messages .chat-item")]; const ed = rows.find((r) => r.querySelector("strong").textContent === "BT-Ed"); return { names: rows.map((r) => r.querySelector("strong").textContent), edDraft: !!ed.querySelector(".chat-draft"), edLastIsReply: chatFor(realPeersById.get(${edId})).lastId === ${reply.id} }; })()`);
  check(afterNo.names[0] === "BT-Dora" && afterNo.edDraft && afterNo.edLastIsReply, "Dora on top again; Ed's row: the draft; Ed's chat timed by his reply", afterNo);

  step("a brand-new chat whose first message is refused: its time is when it was opened again");
  await sam.eval(`(() => { openChat(ensurePeer({ id: 990001, name: "BT-New" })); return true; })()`);
  const opened = await sam.eval(`chatFor(realPeersById.get(990001)).lastAt`);
  await new Promise((r) => setTimeout(r, 50));
  await sam.eval(`window.__lateNo = false, true`);
  await typeText(sam, refused);
  await send(sam);
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  const fresh = await sam.eval(`(() => { const c = chatFor(realPeersById.get(990001)); return { msgs: c.msgs.length, lastAt: c.lastAt, draft: c.draft.length }; })()`);
  check(fresh.msgs === 0 && fresh.lastAt === opened && fresh.draft > 0, "no message, the draft kept, the time back to its opening", { fresh, opened });

  // (from here Sam's "sent" comes 2.5 s late and a refusal 2 s late — the
  // two holds above stay on)
  step("a brand-new chat, two messages refused in a row: its time is when it was started");
  await sam.eval(`(() => { openChat(ensurePeer({ id: 990002, name: "BT-New2" })); return true; })()`);
  const opened2 = await sam.eval(`chatFor(realPeersById.get(990002)).lastAt`);
  await new Promise((r) => setTimeout(r, 50));
  for (const n of [1, 2]) {
    await typeText(sam, refused + n);
    await send(sam);
  }
  await sam.waitFor(`chatFor(realPeersById.get(990002)).msgs.length === 0`, "both refused", 8000);
  const fresh2 = await sam.eval(`chatFor(realPeersById.get(990002)).lastAt`);
  check(fresh2 === opened2, "the time back to when it was started", { fresh2, opened2 });

  step("Sam writes Ed twice quickly, the second refused before the first's 'sent': the chat's time is the first's");
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer.id === ${edId}`, "Ed's chat open");
  await sam.eval(`(window.__noMs = 1000, window.__lateOk = false, window.__lateNo = false), true`);
  await typeText(sam, "first of two");
  await send(sam);
  await typeText(sam, refused);
  await send(sam);
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  const two = await sam.eval(`(() => { const c = chatFor(realPeersById.get(${edId})); const m = c.msgs.at(-1); return { text: m.text, lastAt: c.lastAt, firstAt: m.at, sentYet: !!window.__lateOk }; })()`);
  check(two.text === "first of two" && !two.sentYet && two.lastAt === two.firstAt, "the chat's time: the first message's", two);
  await sam.waitFor(`window.__lateOk`, "the first's 'sent' came", 6000);
  const twoSent = await sam.eval(`(() => { const c = chatFor(realPeersById.get(${edId})); const m = c.msgs.at(-1); return { text: m.text, id: m.id, at: m.at, lastId: c.lastId, lastAt: c.lastAt }; })()`);
  check(twoSent.text === "first of two" && twoSent.id != null && twoSent.lastId === twoSent.id && twoSent.lastAt === twoSent.at, "then its 'sent': the chat timed by it", twoSent);
  await sam.eval(`(window.__noMs = undefined, document.getElementById("chat-input").value = "", chatFor(realPeersById.get(${edId})).draft = ""), true`);

  // the confirm stores YOUR message's id: Dora's comes first in the second,
  // Sam's after — his is the later, Ed's chat goes on top
  step("live: Dora writes Sam, then Sam writes Ed in the same second: Ed's on top");
  let samsLast = null;
  for (let tries = 1; tries <= 5 && !samsLast; tries++) {
    await sam.eval(`new Promise((done) => setTimeout(() => done(true), 1020 - (Date.now() % 1000)))`);
    const theirs = await say(dora, `Dora first ${tries}`);
    check(!theirs.error, "Dora's sent", theirs);
    await typeText(sam, `Sam after ${tries}`);
    await send(sam);
    const mine = await sam.waitFor(`(() => { const m = chatFor(realPeersById.get(${edId})).msgs.at(-1); return m.text === "Sam after ${tries}" && m.id != null && m; })()`, "the server confirmed Sam's", 8000);
    await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "Dora first ${tries}")`, "Sam heard Dora");
    if (mine.ts === theirs.ts) samsLast = `Sam after ${tries}`;
  }
  check(!!samsLast, "Dora's and Sam's in one second (5 tries)");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  const top3 = await sam.eval(`(() => { const r = document.querySelector("#chat-messages .chat-item"); return r && { name: r.querySelector("strong").textContent, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
  check(JSON.stringify(top3) === JSON.stringify({ name: "BT-Ed", line: samsLast }), "Ed on top", top3);

  const edChatOpen = async () => {
    await sam.eval(`openChat(realPeersById.get(${edId})), true`);
    await sam.waitFor(`state.chatView !== "list" && state.chatPeer.id === ${edId}`, "Ed's chat open");
  };
  const clearBox = () => sam.eval(`(document.getElementById("chat-input").value = "", chatFor(realPeersById.get(${edId})).draft = ""), true`);

  // the first's "sent" comes while the second is still the last (so it
  // isn't recorded), then the second is refused: the chat is the first's
  // again — its time AND its id
  step("Sam writes Ed twice; the first's 'sent' comes, then the second is refused: the chat's time and id are the first's");
  await edChatOpen();
  await sam.eval(`(window.__noMs = 4000, window.__lateOk = false, window.__lateNo = false), true`);
  await typeText(sam, "first, sent");
  await send(sam);
  await typeText(sam, refused);
  await send(sam);
  check(!(await sam.eval("window.__lateOk")), "(the second sent before the first's 'sent' came)");
  await sam.waitFor(`window.__lateOk`, "the first's 'sent' came", 6000);
  await sam.waitFor(`window.__lateNo`, "then the refusal", 8000);
  const firstSent = await sam.eval(`(() => { const c = chatFor(realPeersById.get(${edId})); const m = c.msgs.at(-1); return { text: m.text, id: m.id, at: m.at, lastId: c.lastId, lastAt: c.lastAt }; })()`);
  check(firstSent.text === "first, sent" && firstSent.id != null && firstSent.lastId === firstSent.id && firstSent.lastAt === firstSent.at, "the chat's time and id: the first message's", firstSent);
  await sam.eval(`window.__noMs = undefined, true`);
  await clearBox();

  // ‹ before "sent": the list shows Ed on top (this phone's exact time); a
  // message Dora sends in the same second, after Sam's, is the newer — once
  // "sent" comes, the list says so
  step("Sam writes Ed and goes back to the list before 'sent'; Dora writes in the same second: when 'sent' comes, Dora's on top");
  let doraLast = null;
  for (let tries = 1; tries <= 5 && !doraLast; tries++) {
    await edChatOpen();
    await sam.eval(`window.__lateOk = false, true`);
    await sam.eval(`new Promise((done) => setTimeout(() => done(true), 1020 - (Date.now() % 1000)))`);
    await typeText(sam, `to Ed, then back ${tries}`);
    await send(sam);
    await sam.click("chat-back");
    await sam.waitFor(`state.chatView === "list"`, "the list");
    const theirs = await say(dora, `Dora meanwhile ${tries}`);
    check(!theirs.error, "Dora's sent", theirs);
    await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "Dora meanwhile ${tries}")`, "Sam heard Dora");
    const sentAlready = await sam.eval("window.__lateOk"); // (then the "sent" redraw wouldn't be what puts her on top)
    await sam.waitFor(`window.__lateOk`, "Sam's 'sent' came", 6000);
    const mine = await sam.eval(`chatFor(realPeersById.get(${edId})).msgs.find((m) => m.text === "to Ed, then back ${tries}")`);
    if (mine.ts === theirs.ts && mine.id < theirs.id && !sentAlready) doraLast = `Dora meanwhile ${tries}`;
  }
  check(!!doraLast, "Sam's, then Dora's, in one second (5 tries)");
  const top4 = await sam.eval(`(() => { const r = document.querySelector("#chat-messages .chat-item"); return r && { name: r.querySelector("strong").textContent, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
  check(JSON.stringify(top4) === JSON.stringify({ name: "BT-Dora", line: doraLast }), "Dora on top", top4);

  // the list isn't the only thing a refusal could redraw: in a chat, it
  // must leave you where you're reading
  step("a refusal comes while Sam is scrolled up in a long chat: he stays where he is");
  await sam.eval(`(() => { const c = chatFor(realPeersById.get(${edId})); for (let i = 40; i >= 1; i--) c.msgs.unshift({ text: "old " + i, mine: false, at: 0, ts: null, id: null }); return true; })()`);
  await edChatOpen();
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  await sam.eval(`window.__lateNo = false, true`);
  await typeText(sam, refused);
  await send(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = 200; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const reading = await sam.eval(`(() => { const b = document.getElementById("chat-messages"); return { top: Math.round(b.scrollTop), fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) }; })()`);
  check(Math.abs(reading.top - 200) <= 2 && reading.fromBottom > 300, "still where he was reading", reading);
  await clearBox();

  // …and so must a late "sent" (it redraws the list, never a chat)
  step("a late 'sent' comes while Sam is scrolled up in the long chat: he stays where he is");
  await sam.eval(`window.__lateOk = false, true`);
  await typeText(sam, "sent late, read up");
  await send(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = 200; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await sam.waitFor(`window.__lateOk`, "the 'sent' came", 6000);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const readingOk = await sam.eval(`(() => { const b = document.getElementById("chat-messages"); return { top: Math.round(b.scrollTop), fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) }; })()`);
  check(Math.abs(readingOk.top - 200) <= 2 && readingOk.fromBottom > 300, "still where he was reading", readingOk);
  await clearBox();

  const boxIs = () => sam.eval(`document.getElementById("chat-input").value`);
  const doraChatOpen = async () => {
    await sam.eval(`openChat(realPeersById.get(${doraId})), true`);
    await sam.waitFor(`state.chatView !== "list" && state.chatPeer.id === ${doraId}`, "Dora's chat open");
  };

  // the chat drawn again before the answer (‹ and back): the refused
  // message's bubble was a new one — the old one was taken back, the new
  // one stayed, looking sent
  step("Sam writes Ed something refused, goes ‹ and back into Ed's chat before the answer: the refused message isn't left on screen");
  const bubbleText = refused + " (bubble)";
  await sam.eval(`(window.__noMs = 4000, window.__lateNo = false), true`);
  await typeText(sam, bubbleText);
  await send(sam);
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await edChatOpen();
  check(!(await sam.eval("window.__lateNo")), "(back in Ed's chat before the answer)");
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  const mineOnScreen = await sam.eval(`[...document.querySelectorAll("#chat-messages .msg.me")].some((e) => e.textContent === ${JSON.stringify(bubbleText)})`);
  check(!mineOnScreen, "the refused message not on screen");
  await clearBox();

  // a refusal for Ed while Dora's chat is open: the text goes back to Ed's
  // draft — not into the box, which is Dora's now
  step("Sam writes Ed something refused and opens Dora's chat before the answer: Dora's box stays empty, Ed's draft has the text");
  await sam.eval(`window.__lateNo = false, true`);
  await typeText(sam, refused + " (for Ed)");
  await send(sam);
  await doraChatOpen();
  check(!(await sam.eval("window.__lateNo")), "(Dora's chat open before the answer)");
  await sam.waitFor(`window.__lateNo`, "the refusal came", 8000);
  check((await boxIs()) === "", "Dora's box empty", await boxIs());
  check((await sam.eval(`chatFor(realPeersById.get(${edId})).draft`)) === refused + " (for Ed)", "Ed's draft: the text", await sam.eval(`chatFor(realPeersById.get(${edId})).draft`));
  await sam.eval(`(chatFor(realPeersById.get(${edId})).draft = ""), true`);

  // typed something new while the refusal was on its way: kept, the
  // refused text doesn't overwrite it
  step("Sam writes Ed something refused, then types new words before the answer: his new words stay");
  await edChatOpen();
  await sam.eval(`window.__lateNo = false, true`);
  await typeText(sam, refused + " (old)");
  await send(sam);
  await typeText(sam, "new words");
  check(!(await sam.eval("window.__lateNo")), "(typed before the answer)");
  await sam.waitFor(`window.__lateNo`, "the refusal came", 8000);
  check((await boxIs()) === "new words" && (await sam.eval(`chatFor(realPeersById.get(${edId})).draft`)) === "new words", "the box and the draft: his new words", { box: await boxIs(), draft: await sam.eval(`chatFor(realPeersById.get(${edId})).draft`) });
  await clearBox();

  // "not available" for someone new while Ed's chat is open: what's typed
  // for Ed isn't wiped
  step("Sam writes someone who isn't available, opens Ed's chat and types before the answer: his words for Ed stay");
  await sam.eval(`(window.__lateNo = false, openChat(ensurePeer({ id: 990013, name: "BT-Away" }))), true`);
  await typeText(sam, "hello?");
  await send(sam);
  await edChatOpen();
  await typeText(sam, "for Ed, keep this");
  check(!(await sam.eval("window.__lateNo")), "(typed before the answer)");
  await sam.waitFor(`window.__lateNo`, "the answer came", 8000);
  check((await sam.banner()).includes("isn't available"), "the answer: not available", await sam.banner());
  check((await boxIs()) === "for Ed, keep this", "his words for Ed still in the box", await boxIs());
  await sam.eval(`window.__noMs = undefined, true`);
  await clearBox();

  // a reload while reading a chat: still there (it went to the newest; the
  // "New messages" line and ↓ gone) — at the line, and scrolled up
  step("30 new from Dora; Sam opens her chat at the 'New messages' line; a reload: the line still there, where he was");
  await sam.eval(`(window.__drop = true), true`); // (heard only through the reload)
  await onServer(`many_msgs ${doraId} ${samId} 30`);
  await new Promise((r) => setTimeout(r, 1000));
  await sam.eval(`(window.__drop = false), true`);
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  check((await sam.eval(`chatFor(realPeersById.get(${doraId})).unread`)) === 30, "30 unread from Dora", await sam.eval(`chatFor(realPeersById.get(${doraId})).unread`));
  await doraChatOpen();
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const lineAt = () => sam.eval(`(() => { const b = document.getElementById("chat-messages"); const l = b.querySelector(".chat-line"); return { line: l ? Math.round(l.getBoundingClientRect().top - b.getBoundingClientRect().top) : null, above: l && l.nextElementSibling ? l.nextElementSibling.textContent : null, top: Math.round(b.scrollTop), fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), jump: !document.getElementById("chat-jump").classList.contains("hidden") }; })()`);
  const atLine = await lineAt();
  check(atLine.line !== null && atLine.fromBottom > 100 && atLine.jump, "(opened at the line, ↓ showing)", atLine);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const afterLine = await lineAt();
  check(afterLine.line !== null && afterLine.above === atLine.above && Math.abs(afterLine.top - atLine.top) <= 2 && afterLine.jump, "the line still there, above the same message, where he was, ↓ showing", { atLine, afterLine });

  step("at the newest in Dora's chat (↓ tapped), the line still on screen; a reload: at the newest, the line still there");
  await sam.click("chat-jump");
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const atNewest = await lineAt();
  check(atNewest.fromBottom <= 2 && atNewest.line !== null && !atNewest.jump, "(at the newest, the line on screen above)", atNewest);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const newestAfter = await lineAt();
  check(newestAfter.fromBottom <= 2 && newestAfter.line !== null && newestAfter.above === atNewest.above && !newestAfter.jump, "at the newest, the line above the same message, no ↓", { atNewest, newestAfter });

  step("scrolled up in Dora's chat, a reload: still where he was, ↓ showing");
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = 150; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const upBefore = await lineAt();
  check(upBefore.fromBottom > 100, "(scrolled up)", upBefore);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const upAfter = await lineAt();
  check(Math.abs(upAfter.top - upBefore.top) <= 2 && upAfter.jump, "still where he was, ↓ showing", { upBefore, upAfter });

  step("…‹ to his list while scrolled up there; a reload: the list, no ↓ over it");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  check(await sam.eval(`document.getElementById("chat-jump").classList.contains("hidden")`), "(no ↓ on the list)");
  await reload(sam);
  const listAfter = await sam.eval(`({ list: state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden"), jump: !document.getElementById("chat-jump").classList.contains("hidden") })`);
  check(listAfter.list && !listAfter.jump, "the list, no ↓", listAfter);
  await sam.eval(`closeChat(), true`);

  // more than the server's last 50 on Sam's phone (heard live): a reload
  // brings only 50 — what's above him changes. Still the same message
  // where it was; the 3 that came while it loaded count on ↓
  step("60 from Dora heard live, Sam scrolled up to one of them; 3 more while a reload loads: the same message where it was, ↓ 3");
  await doraChatOpen();
  await onServer(`many_msgs ${doraId} ${samId} 60 c`);
  await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.filter((m) => m.text.startsWith("c") && !isNaN(Number(m.text.slice(1)))).length === 60`, "the 60 heard live");
  check((await sam.eval(`chatFor(realPeersById.get(${doraId})).msgs.length`)) > 50, "(more than 50 on his phone)");
  const pinned = await sam.eval(`(() => {
    const b = document.getElementById("chat-messages");
    const el = [...b.querySelectorAll(".msg")].find((e) => e.textContent === "c40");
    b.scrollTop += el.getBoundingClientRect().top - b.getBoundingClientRect().top - 20;
    b.dispatchEvent(new Event("scroll"));
    return { offset: Math.round(el.getBoundingClientRect().top - b.getBoundingClientRect().top), fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) };
  })()`);
  check(pinned.fromBottom > 100, "(scrolled up: c40 near the top)", pinned);
  await sam.eval(`(window.__drop = true), true`); // (the 3 heard only through the reload)
  await onServer(`many_msgs ${doraId} ${samId} 3 d`);
  await new Promise((r) => setTimeout(r, 800));
  await sam.eval(`(window.__drop = false), true`);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const capped = await sam.eval(`(() => {
    const b = document.getElementById("chat-messages");
    const el = [...b.querySelectorAll(".msg")].find((e) => e.textContent === "c40");
    const badge = document.getElementById("chat-jump-count");
    return { msgs: chatFor(realPeersById.get(${doraId})).msgs.length, offset: el ? Math.round(el.getBoundingClientRect().top - b.getBoundingClientRect().top) : null, badge: badge.classList.contains("hidden") ? null : badge.textContent };
  })()`);
  check(capped.msgs === 50 && capped.offset !== null && Math.abs(capped.offset - pinned.offset) <= 2, "the same message where it was (the server's 50)", { pinned, capped });
  check(capped.badge === "3", "↓ 3: the ones that came while it loaded", capped);

  // ↓ adds up: 2 heard live while scrolled up (already on it), 1 missed
  // and brought by the reload
  step("scrolled up: 2 from Dora heard live and 2 notes, then 1 missed; a reload: ↓ 3 (the notes gone, not counted)");
  await sam.click("chat-jump");
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = Math.max(0, b.scrollHeight - b.clientHeight - 400); b.dispatchEvent(new Event("scroll")); return true; })()`);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  await onServer(`many_msgs ${doraId} ${samId} 2 e`);
  await sam.waitFor(`document.getElementById("chat-jump-count").textContent === "2"`, "↓ 2: heard live");
  await sam.eval(`(() => { const p = realPeersById.get(${doraId}); receiveMsg(p, "📩 note a"); receiveMsg(p, "📩 note b"); return true; })()`);
  check((await sam.eval(`document.getElementById("chat-jump-count").textContent`)) === "4", "(↓ 4 with the notes)", await sam.eval(`document.getElementById("chat-jump-count").textContent`));
  await sam.eval(`(window.__drop = true), true`);
  await onServer(`many_msgs ${doraId} ${samId} 1 f`);
  await new Promise((r) => setTimeout(r, 800));
  await sam.eval(`(window.__drop = false), true`);
  await reload(sam);
  const addsUp = await sam.eval(`(() => { const badge = document.getElementById("chat-jump-count"); return badge.classList.contains("hidden") ? null : badge.textContent; })()`);
  check(addsUp === "3", "↓ 3: the 2 heard live and the 1 missed — not the notes", addsUp);

  // this app's notes ("📩 requested a ride") aren't the server's: a reload
  // drops them. Sam scrolled up a little into them, reading them: after the
  // reload they're gone and he's at the newest — no ↓ (he isn't "scrolled
  // up" any more), and what comes next follows
  step("notes come in at the bottom of Dora's chat; Sam scrolls up a little into them; a reload drops them: at the newest, no ↓, the next message follows");
  await sam.click("chat-jump");
  await sam.eval(`(() => { const p = realPeersById.get(${doraId}); for (let i = 1; i <= 15; i++) receiveMsg(p, "📩 a note " + i); return true; })()`);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = Math.max(0, b.scrollHeight - b.clientHeight - 150); b.dispatchEvent(new Event("scroll")); return true; })()`);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const amongNotes = await sam.eval(`(() => { const b = document.getElementById("chat-messages"), bt = b.getBoundingClientRect().top; const firstSeen = [...b.querySelectorAll(".msg")].find((e) => e.getBoundingClientRect().bottom > bt); return { first: firstSeen ? firstSeen.textContent : null, fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), jump: !document.getElementById("chat-jump").classList.contains("hidden") }; })()`);
  check(amongNotes.first && amongNotes.first.startsWith("📩") && amongNotes.fromBottom > 100 && amongNotes.jump, "(scrolled up among the notes, ↓ showing)", amongNotes);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const notesGone = await sam.eval(`(() => { const b = document.getElementById("chat-messages"); return { fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), jump: !document.getElementById("chat-jump").classList.contains("hidden"), notes: chatFor(realPeersById.get(${doraId})).msgs.filter((m) => m.text.startsWith("📩")).length }; })()`);
  check(notesGone.notes === 0 && notesGone.fromBottom <= 2 && !notesGone.jump, "the notes gone: at the newest, no ↓", notesGone);
  await onServer(`many_msgs ${doraId} ${samId} 1 g`);
  await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "g1")`, "Dora's next message");
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const followed = await sam.eval(`(() => { const b = document.getElementById("chat-messages"); return { fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), jump: !document.getElementById("chat-jump").classList.contains("hidden") }; })()`);
  check(followed.fromBottom <= 2 && !followed.jump, "it followed: at the newest, no ↓", followed);

  // the first unread is a note ("📩 requested a ride"): the line above it;
  // the reload drops the note — the line goes above the next real message
  step("away from Dora's chat: a note, then 30 from her; opened at the line (above the note); a reload: the line above her first message");
  await sam.eval(`closeChat(), true`);
  await sam.eval(`(receiveMsg(realPeersById.get(${doraId}), "📩 a note first"), true)`);
  await onServer(`many_msgs ${doraId} ${samId} 30 k`);
  await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "k30")`, "the 30 heard");
  await doraChatOpen();
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const noteLine = await lineAt();
  check(noteLine.above === "📩 a note first", "(the line above the note)", noteLine);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const kLine = await lineAt();
  check(kLine.line !== null && kLine.above === "k1", "the line above her first message", { noteLine, kLine });

  // the message he was on is older than the server's last 50: gone after
  // the reload — the list stays where it was (not sent to the top, nor to
  // the newest)
  step("scrolled up to a message older than the server's last 50; a reload: at the top (the oldest kept, the nearest to it), ↓ showing");
  await onServer(`many_msgs ${doraId} ${samId} 60 h`);
  await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "h60")`, "the 60 heard live");
  const oldPlace = await sam.eval(`(() => {
    const b = document.getElementById("chat-messages");
    const el = [...b.querySelectorAll(".msg")].find((e) => e.textContent === "h3");
    b.scrollTop += el.getBoundingClientRect().top - b.getBoundingClientRect().top - 20;
    b.dispatchEvent(new Event("scroll"));
    return { top: Math.round(b.scrollTop), fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) };
  })()`);
  check(oldPlace.fromBottom > 300 && oldPlace.top > 300, "(h3 near the top: far up)", oldPlace);
  await reload(sam);
  await sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const oldAfter = await sam.eval(`(() => { const b = document.getElementById("chat-messages"); return { top: Math.round(b.scrollTop), fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), h3: [...b.querySelectorAll(".msg")].some((e) => e.textContent === "h3"), jump: !document.getElementById("chat-jump").classList.contains("hidden") }; })()`);
  check(!oldAfter.h3 && oldAfter.top === 0 && oldAfter.fromBottom > 300 && oldAfter.jump, "h3 gone (older than 50): at the top, ↓ showing", { oldPlace, oldAfter });
  await sam.eval(`closeChat(), true`);

  // the chat is gone (closed by the server) before Sam's "sent" comes: no
  // error
  step("Sam's chat with Ed is closed before his 'sent' comes: no error");
  await sam.eval(`openChat(realPeersById.get(${edId})), true`);
  await sam.eval(`(() => { window.__errs = []; window.addEventListener("error", (e) => __errs.push(String(e.message))); window.__lateOk = false; return true; })()`);
  await typeText(sam, "one more");
  await send(sam);
  await sam.eval(`(closeChat(), chats.delete(realPeersById.get(${edId}))), true`);
  await sam.waitFor(`window.__lateOk || __errs.length > 0`, "the 'sent' came", 6000);
  const after = await sam.eval(`({ errs: __errs, sent: !!window.__lateOk })`);
  check(after.sent && after.errs.length === 0, "no error", after);
  check(!(await sam.eval(`chats.has(realPeersById.get(${edId}))`)), "and the chat not brought back");

  // the server closes the chat (she left) while Sam's message is on its way;
  // then it fails: nothing to keep the chat for — it stays gone (it used to
  // come back on top of the list, as a draft to someone who'd gone)
  step("Sam's message to Dora fails after the server closed their chat: the chat stays gone");
  await sam.eval(`openChat(realPeersById.get(${doraId})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === ${doraId}`, "Dora's chat open");
  await sam.eval(`(window.__noMs = 4000, window.__lateNo = false), true`);
  await typeText(sam, refused);
  await send(sam);
  await onServer(`close_chat ${samId} ${doraId}`);
  await sam.waitFor(`!chats.has(realPeersById.get(${doraId}))`, "Sam's app: the chat closed");
  check(!(await sam.eval("window.__lateNo")), "(closed before the refusal came)");
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  await new Promise((r) => setTimeout(r, 200));
  check(!(await sam.eval(`chats.has(realPeersById.get(${doraId}))`)), "the chat not brought back");
  await sam.eval(`window.__noMs = undefined, true`);
  // a chat with her again (she writes, or Sam opens one) is a new one: no
  // longer "closed by the server" — a failure in it keeps the text again
  check(await sam.eval(`(() => { const p = realPeersById.get(${doraId}); const was = p.chatClosed; chatFor(p); const now = p.chatClosed; chats.delete(p); return was === true && now === false; })()`), "a new chat with her: no longer 'closed'");

  // a chat with no message in it yet comes from the server with only its
  // start time (a ride opens one): a refused first message, after a reload,
  // goes back to that — not to the reload
  step("a chat with no message yet, after a reload: a refused first message leaves it at the time it was opened");
  await onServer(`quiet_chat ${samId}`);
  await new Promise((r) => setTimeout(r, 1200));
  await reload(sam);
  const quietId = await sam.waitFor(`(() => { const e = [...chats].find(([p]) => p.name === "BT-Quiet"); return e && e[1].msgs.length === 0 && e[0].id; })()`, "the quiet chat");
  const openedAt = await sam.eval(`fetch("/api/state").then((r) => r.json()).then((s) => HoodChatList.localAt(s.conversations.find((c) => c.peer.id === ${quietId}).last_activity, chatSkew))`);
  await sam.eval(`(window.__lateNo = false, openChat(realPeersById.get(${quietId}))), true`);
  await typeText(sam, refused);
  await send(sam);
  await sam.waitFor(`window.__lateNo`, "the refusal came", 6000);
  const quietAt = await sam.eval(`chatFor(realPeersById.get(${quietId})).lastAt`);
  check(quietAt === openedAt, "its time: when it was opened", { quietAt, openedAt });

  // everyone he talked to has gone while his list was open, and he learns
  // it only from a reload: no empty "Chats" panel left — the list reached
  // from a chat (here BT-Quiet's), then from 💬 on a fresh start
  step("from a chat to his list; everyone Sam talked to is gone, heard only through a reload: the list closes");
  await sam.eval(`(() => {
    // (a draft keeps its chat across a reload, on purpose: nothing typed is lost)
    document.getElementById("chat-input").value = "";
    for (const [p, c] of [...chats]) {
      c.draft = "";
      if (!c.server) chats.delete(p);
    }
    const on = userChannel.trigger.bind(userChannel);
    userChannel.trigger = (ev, ...a) => (ev === "chat_closed" ? undefined : on(ev, ...a));
    return true;
  })()`);
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list open");
  check(await sam.eval(`!!state.chatPeer`), "(reached from a chat)");
  const goneAndReload = async () => {
    await onServer(`close_chats ${samId}`);
    await new Promise((r) => setTimeout(r, 500));
    check(await sam.eval(`!document.getElementById("chat").classList.contains("hidden")`), "(not heard live: still open)");
    await reload(sam);
    const closed = await sam.eval(`({ hidden: document.getElementById("chat").classList.contains("hidden"), chats: chats.size })`);
    check(closed.hidden && closed.chats === 0, "the list closed, no chats", closed);
  };
  await goneAndReload();

});
