// Chats that go while Sam's list or chat is open (owner, 2026-11-07/08; split
// from reloadscreens.mjs, 2026-11-08 — together they came near a
// journey's time): live, or heard only through a reload, and refusals for
// first messages around them: no empty "Chats" panel, the list never closed
// whole for one chat, no dead chat left behind, the 💬 button right.
import { journey, step, check, server as onServer } from "./cdp.mjs";
import { typeText, send } from "./app.mjs";

const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
  await new Promise((r) => setTimeout(r, 300));
};

await journey("chatsgone: chats that go while the list or a chat is open", async (browser) => {
  const sam = await browser.person("BT-Sam");
  await sam.waitFor(`hydrated && !reloading`, "Sam's app loaded");
  const samId = await sam.id();
  const goneAndReload = async () => {
    await onServer(`close_chats ${samId}`);
    await new Promise((r) => setTimeout(r, 500));
    check(await sam.eval(`!document.getElementById("chat").classList.contains("hidden")`), "(not heard live: still open)");
    await reload(sam);
    const closed = await sam.eval(`({ hidden: document.getElementById("chat").classList.contains("hidden"), chats: chats.size })`);
    check(closed.hidden && closed.chats === 0, "the list closed, no chats", closed);
  };

  step("on a fresh start, 💬 Chat: his list; everyone is gone, heard only through a reload: the list closes");
  await onServer(`fifteen_write ${samId}`);
  await sam.open();
  await sam.waitFor(`hydrated && !reloading && chats.size >= 2`, "loaded, his chats", 15000);
  await sam.eval(`(() => {
    const on = userChannel.trigger.bind(userChannel);
    userChannel.trigger = (ev, ...a) => (ev === "chat_closed" ? undefined : on(ev, ...a));
    return true;
  })()`);
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list open");
  check(await sam.eval(`!state.chatPeer`), "(no chat opened yet)");
  await goneAndReload();

  // live (no reload): chats closed by the server while the list shows
  const listNow = () =>
    sam.eval(`({ open: !document.getElementById("chat").classList.contains("hidden"), list: state.chatView === "list", rows: [...document.querySelectorAll("#chat-messages .chat-item strong")].map((e) => e.textContent) })`);
  step("‹ from W15's chat to the list; W15's chat closes live: the list stays, without it");
  await onServer(`fifteen_write ${samId}`);
  await sam.open();
  await sam.waitFor(`hydrated && !reloading && chats.size === 15`, "loaded, 15 chats", 15000);
  const w15 = await sam.eval(`[...chats.keys()].find((p) => p.name === "BT-W15").id`);
  await sam.eval(`openChat(realPeersById.get(${w15})), true`);
  await sam.waitFor(`state.chatView !== "list" && state.chatPeer && state.chatPeer.id === ${w15}`, "W15's chat open");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await onServer(`close_chat ${samId} ${w15}`);
  await sam.waitFor(`!chats.has(realPeersById.get(${w15}))`, "W15's chat closed");
  const afterW15 = await listNow();
  check(afterW15.open && afterW15.list && afterW15.rows.length === 14 && !afterW15.rows.includes("BT-W15"), "the list open, the 14 others", afterW15);

  // "not available" for a first message, after ‹ back to the list: the
  // list stays (it used to close whole), without that empty chat — and
  // only that one: Ray's, opened and not written in, stays too
  step("Sam opens Ray's chat, writes nothing, ‹; writes someone who isn't available, ‹ before the answer: the list stays, without them, Ray's still in it");
  await sam.eval(`openChat(ensurePeer({ id: 990007, name: "BT-Ray" })), true`);
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list" && [...document.querySelectorAll("#chat-messages .chat-item strong")].some((e) => e.textContent === "BT-Ray")`, "Ray's row in the list");
  await sam.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, ...a) => {
      const p = orig(ev, ...a);
      if (ev !== "send_msg") return p;
      const rcv = p.receive.bind(p);
      // (held 2 s — and while __holdNo is set, until the step lets it go)
      const give = (cb, r) => (window.__holdNo ? setTimeout(() => give(cb, r), 50) : (cb(r), (window.__no = r.reason)));
      p.receive = (status, cb) => rcv(status, status === "error" ? (r) => setTimeout(() => give(cb, r), 2000) : cb);
      return p;
    };
    window.__no = null;
    window.__holdNo = true;
    openChat(ensurePeer({ id: 990003, name: "BT-Nobody" }));
    return true;
  })()`);
  await typeText(sam, "hello?");
  await send(sam);
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await sam.eval(`window.__holdNo = false, true`);
  await sam.waitFor(`window.__no`, "the answer came", 6000);
  check((await sam.eval("window.__no")) === "unavailable", "not available", await sam.eval("window.__no"));
  const afterNobody = await listNow();
  check(afterNobody.open && afterNobody.list && afterNobody.rows.length === 15 && !afterNobody.rows.includes("BT-Nobody") && afterNobody.rows.includes("BT-Ray"), "the list open: the 14, and Ray's", afterNobody);

  // a reload rebuilds the chats: a first message still on its way isn't
  // one the server has, so its chat isn't in them — it fails afterwards:
  // the chat comes back, the text as its draft (only a chat the server
  // closed stays gone)
  step("Sam writes someone new, closes the chat, a reload comes, then the message fails: the chat is back, his text its draft");
  const keepMe = "a" + "́".repeat(31) + " keep me";
  await sam.eval(`(window.__no = null, window.__holdNo = true, openChat(ensurePeer({ id: 990008, name: "BT-Kim" }))), true`);
  await typeText(sam, keepMe);
  await send(sam);
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  check(!(await sam.eval(`chats.has(realPeersById.get(990008))`)) && !(await sam.eval("window.__no")), "(the reload came first: no chat, no answer yet)");
  await sam.eval(`window.__holdNo = false, true`);
  await sam.waitFor(`window.__no`, "the answer came", 6000);
  check((await sam.eval("window.__no")) === "stacked_marks", "(refused: too many marks on one letter)", await sam.eval("window.__no"));
  const kim = await sam.eval(`(() => { const c = chats.get(realPeersById.get(990008)); return c ? { draft: c.draft, msgs: c.msgs.length } : null; })()`);
  check(!!kim && kim.draft.endsWith(" keep me") && kim.msgs === 0, "the chat back, the text its draft", kim);

  // …but "not available" drops the text: after a reload, with the panel
  // closed, no empty chat with them is left (the 💬 button counted it)
  step("Sam writes someone new who isn't available, closes the chat, a reload comes, then the answer: no chat with them is left");
  await sam.eval(`(window.__no = null, window.__holdNo = true, openChat(ensurePeer({ id: 990010, name: "BT-Gone" }))), true`);
  await typeText(sam, "hello there?");
  await send(sam);
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  check(!(await sam.eval("window.__no")), "(the reload came first)");
  await sam.eval(`window.__holdNo = false, true`);
  await sam.waitFor(`window.__no`, "the answer came", 6000);
  check((await sam.eval("window.__no")) === "unavailable", "not available", await sam.eval("window.__no"));
  check(!(await sam.eval(`chats.has(realPeersById.get(990010))`)), "no chat with them left");

  step("every chat left closes live while the list shows: the list closes (no empty 'Chats')");
  // (Ray's and Kim's are only on this phone — not the server's to close)
  await sam.eval(`(chats.delete(realPeersById.get(990007)), chats.delete(realPeersById.get(990008)), document.getElementById("chat-input").value = "", true)`);
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list open");
  await onServer(`close_chats ${samId}`);
  await sam.waitFor(`document.getElementById("chat").classList.contains("hidden")`, "the list closed", 10000);
  check((await sam.eval("chats.size")) === 0, "no chats", await sam.eval("chats.size"));

  // the list shows two chats (‹ needs two); the other closes live while
  // Sam's first message to Nobody2 waits; then "not available": nothing
  // left — the list closes
  step("Sam writes Nobody2 (not available), ‹ to his list of two; the other chat closes live, then the answer: the list closes");
  await onServer(`quiet_chat ${samId}`);
  await reload(sam);
  await sam.waitFor(`[...chats.keys()].some((p) => p.name === "BT-Quiet")`, "the quiet chat back");
  await sam.eval(`(window.__no = null, window.__holdNo = true, openChat(ensurePeer({ id: 990009, name: "BT-Nobody2" }))), true`);
  await typeText(sam, "anyone?");
  await send(sam);
  await sam.waitFor(`!document.getElementById("chat-back").classList.contains("hidden")`, "‹ there (two chats)");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list" && document.querySelectorAll("#chat-messages .chat-item").length === 2`, "the list of two");
  await onServer(`close_chats ${samId}`);
  await sam.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length === 1 && !document.getElementById("chat").classList.contains("hidden")`, "the quiet chat closed live: Nobody2's row alone");
  await sam.eval(`window.__holdNo = false, true`);
  await sam.waitFor(`window.__no`, "the answer came", 6000);
  check((await sam.eval("window.__no")) === "unavailable", "not available", await sam.eval("window.__no"));
  check(await sam.eval(`document.getElementById("chat").classList.contains("hidden") && chats.size === 0`), "the list closed, no chats", await listNow());

  // the panel closed while the answer comes: the 💬 button goes with the
  // chat (it counted a chat that wasn't there any more)
  step("Sam writes someone new who isn't available and closes the chat: when the answer comes, no chat and no 💬 button");
  await sam.eval(`(window.__no = null, window.__holdNo = true, openChat(ensurePeer({ id: 990012, name: "BT-Gone2" }))), true`);
  await typeText(sam, "hi?");
  await send(sam);
  await sam.eval(`closeChat(), true`);
  check(await sam.eval(`!document.getElementById("btn-chat").classList.contains("hidden")`), "(the 💬 button while it waits)");
  await sam.eval(`window.__holdNo = false, true`);
  await sam.waitFor(`window.__no`, "the answer came", 6000);
  check((await sam.eval("window.__no")) === "unavailable", "not available", await sam.eval("window.__no"));
  check(await sam.eval(`chats.size === 0 && document.getElementById("btn-chat").classList.contains("hidden")`), "no chat, no 💬 button", await sam.eval(`({ chats: chats.size, button: !document.getElementById("btn-chat").classList.contains("hidden") })`));
});
