// The chat list, newest on top, opens at the top (owner, 2026-11-07): with
// more chats than fit on screen it opened at the bottom — the oldest — from
// 💬, from ‹, and again whenever a message came in. Redrawn while you're in
// it, it stays where you were; a size change (the keyboard) doesn't move it;
// no ↓ in the list.
import { journey, step, check, server } from "./cdp.mjs";

await journey("chatlistscroll: the chat list opens at the top", async (browser) => {
  step("Sam has 15 chats, more than fit on screen (P15 the newest)");
  const sam = await browser.person("BT-Sam");
  await sam.waitFor(`hydrated && !reloading`, "loaded");
  await sam.eval(`(() => { const t0 = Date.now(); for (let i = 1; i <= 15; i++) { const p = ensurePeer({ id: 900000 + i, name: "P" + i }); const c = chatFor(p); c.msgs.push({ text: "m" + i, mine: false, at: t0 - (16 - i) * 60000 }); c.lastAt = t0 - (16 - i) * 60000; } return true; })()`);
  const frame = () => sam.eval(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))`);
  const look = () =>
    sam.eval(`(() => {
      const b = document.getElementById("chat-messages"), br = b.getBoundingClientRect();
      const rows = [...b.querySelectorAll(".chat-item")];
      const seen = rows.filter((r) => { const x = r.getBoundingClientRect(); return x.top >= br.top - 1 && x.bottom <= br.bottom + 1; }).map((r) => r.querySelector("strong").textContent);
      return { rows: rows.length, overflows: b.scrollHeight > b.clientHeight + 100, top: Math.round(b.scrollTop), first: rows[0] && rows[0].querySelector("strong").textContent, seen, jump: !document.getElementById("chat-jump").classList.contains("hidden") };
    })()`);

  step("💬 Chat: the list at the top, the newest in view");
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list open");
  await frame();
  const opened = await look();
  check(opened.rows === 15 && opened.overflows, "15 rows, more than fit", opened);
  check(opened.top === 0 && opened.first === "P15" && opened.seen[0] === "P15" && !opened.jump, "at the top: P15 in view, no ↓", opened);

  step("into P3's chat, then ‹: the list at the top again");
  await sam.eval(`openChat(realPeersById.get(900003)), true`);
  await sam.waitFor(`state.chatView !== "list"`, "P3's chat");
  await frame();
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await frame();
  const back = await look();
  check(back.top === 0 && back.seen[0] === "P15" && !back.jump, "at the top: P15 in view, no ↓", back);

  step("the box shrinks (as the keyboard): the list stays at the top");
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.style.maxHeight = (b.clientHeight - 60) + "px"; return true; })()`);
  await frame();
  await frame();
  const shrunk = await look();
  await sam.eval(`document.getElementById("chat-messages").style.maxHeight = "", true`);
  await frame();
  check(shrunk.top === 0 && shrunk.seen[0] === "P15", "still at the top", shrunk);

  step("Sam scrolls down the list, then back up a way (as when reading a chat): no ↓; P5 writes — the list stays where he is");
  const scrollTo = (top) => sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = ${top}; b.dispatchEvent(new Event("scroll")); return Math.round(b.scrollTop); })()`);
  await scrollTo(100000);
  await frame();
  const at = await scrollTo((await look()).top - 300);
  await frame();
  const down = await look();
  check(down.top === at && at > 0 && !down.jump, "scrolled down, then 300px up: no ↓ (the list has no bottom to come back to)", down);
  await sam.eval(`receiveMsg(realPeersById.get(900005), "again"), true`);
  await frame();
  const news = await look();
  check(news.first === "P5" && news.top === at && !news.jump, "P5 now first in the list; Sam still where he was, no ↓", news);

  step("closed while scrolled down, 💬 Chat again: at the top");
  await sam.eval(`closeChat(), true`);
  await frame();
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list open");
  await frame();
  const reopened = await look();
  check(reopened.top === 0 && reopened.seen[0] === "P5" && !reopened.jump, "at the top: P5 in view, no ↓", reopened);

  step("in a long chat Sam scrolls up (↓ showing), then ‹: the list, no ↓");
  await sam.eval(`(() => { const c = chatFor(realPeersById.get(900003)); for (let i = 1; i <= 40; i++) c.msgs.push({ text: "line " + i, mine: false, at: c.lastAt }); return true; })()`);
  await sam.eval(`openChat(realPeersById.get(900003)), true`);
  await sam.waitFor(`state.chatView !== "list"`, "P3's chat");
  await frame();
  await frame();
  await scrollTo(0);
  await frame();
  check(await sam.eval(`!document.getElementById("chat-jump").classList.contains("hidden")`), "scrolled up in the chat: ↓ showing");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await frame();
  const listAgain = await look();
  check(!listAgain.jump && listAgain.top === 0, "the list: at the top, no ↓", listAgain);
  await sam.eval(`closeChat(), true`);

  // real chats (the made-up ones above are gone after a reload)
  step("15 people write Sam; the list open, scrolled down: a reload leaves it where he was, W15 first");
  await server(`fifteen_write ${await sam.id()}`);
  await sam.eval(`softReload(), true`);
  await sam.waitFor(`hydrated && !reloading && chats.size === 15`, "reloaded: the 15 real chats", 15000);
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list open");
  await frame();
  const real = await look();
  check(real.rows === 15 && real.overflows && real.top === 0 && real.first === "BT-W15", "15 rows, at the top, W15 first", real);
  await scrollTo(100000);
  await frame();
  const mid = await scrollTo((await look()).top - 300);
  await frame();
  await sam.eval(`softReload(), true`);
  await sam.waitFor(`hydrated && !reloading`, "reloaded");
  await frame();
  const after = await look();
  check(after.rows === 15 && after.first === "BT-W15" && after.top === mid && mid > 0 && !after.jump, "after the reload: where he was, W15 first, no ↓", { after, mid });
});
