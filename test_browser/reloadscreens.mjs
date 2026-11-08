// What's open on screen stays open across a reload (owner, 2026-11-07):
// every join of the connection reloads the app from the server — right
// after opening it, and after any blip. The list of who's in one block (a
// pile of cars) closed under your finger; the chat list was already kept,
// and now has a check too. (The chat, a person's card, a draft, Meet here:
// tapreload.mjs, chats.mjs, chatback.mjs.)
import { journey, step, check } from "./cdp.mjs";
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
  await sam.eval(`closePileSheet(), true`);

  // only a pile of two or more has a list — whoever asks for it (a reload
  // reopening it, after the pile shrank): one person is their card, none is
  // nothing (owner, 2026-11-07: an empty sheet otherwise)
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
  await sam.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, ...a) => {
      const p = orig(ev, ...a);
      if (ev !== "send_msg") return p;
      const rcv = p.receive.bind(p);
      p.receive = (status, cb) => rcv(status, status === "ok" ? (r) => setTimeout(() => { cb(r); window.__lateOk = true; }, 2500) : cb);
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
      p.receive = (status, cb) => rcv(status, status === "error" ? (r) => setTimeout(() => { cb(r); window.__lateNo = true; }, 2000) : cb);
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
});
