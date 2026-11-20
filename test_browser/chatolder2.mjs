// More on chats older than the pages loaded so far (review of the older
// chats, 2026-11-20 — the first part: chatolder.mjs).
//   - a chat on page 2 opened from a card before page 2 came (its messages
//     slow): the page's summary brought its unread AGAIN — counted twice;
//   - a chat from page 2 opened, then ‹ back to the list, then a reload
//     (page 1 only): the list said "Chat with … ended" — it hadn't.
import { journey, step, check, server } from "./cdp.mjs";

const total = (p) => p.eval(`[...chats.values()].reduce((s, c) => s + c.unread, 0) + unreadMore`);
async function crowded(browser, name, n) {
  const p = await browser.person(name);
  const id = await p.id();
  await server(`chat_crowd ${n} ${id}`);
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading && chats.size === 30 && unreadRest.size === ${n - 30}`, `${name}: 30 loaded, ${n - 30} counted apart`);
  return { p, id };
}
const scrollList = async (p) => {
  await p.click("btn-chat");
  await p.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length >= 30`, "the list drawn");
  await p.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
};

await journey("chatolder2: a page-2 chat opened early counted once; a reload never says a page-2 chat ended", async (browser) => {
  step("Vera: 35 chats; one on page 2 (with unread) opened from a card, its messages slow; page 2 then comes: its unread counted ONCE");
  const { p: vera } = await crowded(browser, "BT-Ol2Vera", 35);
  const x = await vera.eval(`[...unreadRest.keys()].sort((a, b) => a - b)[0]`);
  const before = await total(vera);
  const held = await vera.holdResponses("*/api/chat?peer=*");
  await vera.eval(`openChat(ensurePeer({ id: ${x}, name: "BT-Page2" })), true`);
  await vera.waitFor(`chats.has(realPeersById.get(${x})) && chats.get(realPeersById.get(${x})).unread === 1`, "its unread taken over");
  await vera.eval(`closeChat(), true`);
  await scrollList(vera);
  await vera.waitFor(`!olderLoading && chats.size === 35`, "page 2 arrived (with that chat)", 10000);
  check((await vera.eval(`chats.get(realPeersById.get(${x})).unread`)) === 1, "that chat: 1 unread, not 2", await vera.eval(`chats.get(realPeersById.get(${x})).unread`));
  check((await total(vera)) === before, "the 💬 count: the same — counted once", { before, after: await total(vera) });
  await held.release();
  await vera.waitFor(`chats.get(realPeersById.get(${x})).loaded === true`, "its messages arrived", 15000);
  check((await total(vera)) === before, "still once after they arrived", { before, after: await total(vera) });
  check(vera.errors.length === 0, "no page errors", vera.errors);
  await vera.close();

  step("Yara: a chat from page 2 opened, ‹ back to the list, then a reload: no 'ended' — the list stays, the chat still there");
  const { p: yara } = await crowded(browser, "BT-Ol2Yara", 35);
  await scrollList(yara);
  await yara.waitFor(`chats.size === 35 && !olderLoading`, "all 35 loaded", 10000);
  const y = await yara.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C2").id`);
  await yara.eval(`openChat(realPeersById.get(${y})), true`);
  await yara.waitFor(`chats.get(realPeersById.get(${y})).loaded === true`, "BT-C2 open");
  await yara.click("chat-back");
  await yara.waitFor(`state.chatView === "list"`, "‹ back to the list");
  await yara.eval(`(window.__banners = [], new MutationObserver(() => window.__banners.push(document.getElementById("banner").textContent)).observe(document.getElementById("banner"), { childList: true, characterData: true, subtree: true }), true)`);
  await yara.eval(`softReload(), true`);
  await yara.waitFor(`hydrated && !reloading`, "reloaded");
  await new Promise((r) => setTimeout(r, 500));
  const said = await yara.eval(`window.__banners`);
  check(!said.some((b) => b.includes("ended")), "never 'Chat with … ended'", said);
  check(await yara.eval(`!document.getElementById("chat").classList.contains("hidden") && state.chatView === "list"`), "the list still open");
  // its chat comes with page 2, as before
  await yara.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
  await yara.waitFor(`chats.has(realPeersById.get(${y}))`, "BT-C2 there again with its page", 10000);
  check(yara.errors.length === 0, "no page errors", yara.errors);
  await yara.close();

  // (review, 2026-11-20) the chat on screen came in full AND among the older
  // chats' unread (the server: chat_paging_test); the app never counts a
  // chat that's here apart either
  step("Zoe: an older chat's unread for a chat that's here: never counted apart");
  const { p: zoe } = await crowded(browser, "BT-Ol2Zoe", 35);
  const z = await zoe.eval(`[...chats.keys()][0].id`);
  const far = await zoe.eval(`[...unreadRest.keys()][0]`);
  await zoe.eval(`setUnreadRest({ [${z}]: 4, [${far}]: 1 }), true`);
  check(!(await zoe.eval(`unreadRest.has(${z})`)), "the chat that's here: not counted apart");
  check((await zoe.eval(`unreadRest.get(${far})`)) === 1, "one not here: counted apart");
  await zoe.close();

  // (review, 2026-11-20) a chat opened while a reconnect's answer was on its
  // way wasn't ASKED for in full: judged "ended" — it wasn't
  step("Abe: a reconnect's answer on its way; he opens a page-2 chat meanwhile: never 'ended' — it opens, with its history");
  const { p: abe } = await crowded(browser, "BT-Ol2Abe", 35);
  await scrollList(abe);
  await abe.waitFor(`chats.size === 35 && !olderLoading`, "all 35 loaded", 10000);
  const a = await abe.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C4").id`);
  const abeHeld = await abe.holdResponses("*/api/state*");
  await abe.eval(`(window.__banners = [], new MutationObserver(() => window.__banners.push(document.getElementById("banner").textContent)).observe(document.getElementById("banner"), { childList: true, characterData: true, subtree: true }), true)`);
  await abe.eval(`softReload(), true`);
  for (let i = 0; i < 100 && abeHeld.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(abeHeld.count() === 1, "the reconnect's answer held", abeHeld.count());
  await abe.eval(`openChat(realPeersById.get(${a})), true`);
  await abeHeld.release();
  await abe.waitFor(`hydrated && !reloading`, "reloaded", 15000);
  await abe.waitFor(`state.chatPeer && state.chatPeer.id === ${a} && state.chatView === "msgs" && chats.has(state.chatPeer) && chats.get(state.chatPeer).loaded === true`, "BT-C4 open, its messages here", 15000);
  check(!(await abe.eval(`window.__banners`)).some((b) => b.includes("ended")), "never 'ended'", await abe.eval(`window.__banners`));
  check((await abe.eval(`chats.get(state.chatPeer).msgs.map((m) => m.text)`)).some((t) => t.startsWith("hi")), "its history", await abe.eval(`chats.get(state.chatPeer).msgs.map((m) => m.text)`));
  check(abe.errors.length === 0, "no page errors", abe.errors);
  await abe.close();

  // (review, 2026-11-20) a chat's messages came without the server's "read
  // up to": loaded off screen on a phone with none of its own marks, every
  // kept message counted unread
  step("Bea: a page-2 chat read up to its first message, then a second; another phone (no marks of its own) opens it from a card, leaves before it loads: 1 unread, not 2");
  const { p: bea, id: beaId } = await crowded(browser, "BT-Ol2Bea", 35);
  await scrollList(bea);
  await bea.waitFor(`chats.size === 35 && !olderLoading`, "all 35 loaded", 10000);
  const b = await bea.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  await bea.eval(`openChat(realPeersById.get(${b})), true`);
  await bea.waitFor(`chats.get(realPeersById.get(${b})).unread === 0 && !!chats.get(realPeersById.get(${b})).serverRead`, "read, the server told");
  await bea.eval(`closeChat(), true`);
  await server(`crowd_says 1 ${beaId} second`);
  // (30 others write after it — a second later: a chat's time is in whole
  // seconds — back past page 1)
  await new Promise((r) => setTimeout(r, 1100));
  for (let i = 2; i <= 31; i++) await server(`crowd_says ${i} ${beaId} bump`);
  await bea.eval(`HoodReadStore.forget(window.localStorage, state.realUser.id), softReload(), true`);
  await bea.waitFor(`hydrated && !reloading && chats.size === 30`, "reloaded: page 1 only");
  check(!(await bea.eval(`chats.has(realPeersById.get(${b}))`)) && (await bea.eval(`unreadRest.get(${b})`)) === 1, "that chat: past the page, 1 unread (the server count)", await bea.eval(`[chats.has(realPeersById.get(${b})), unreadRest.get(${b}), [...chats.keys()].map((p) => p.name).slice(25)]`));
  const beaHeld = await bea.holdResponses("*/api/chat?peer=*");
  await bea.eval(`openChat(ensurePeer({ id: ${b}, name: "BT-C1" })), true`);
  await bea.waitFor(`chats.has(realPeersById.get(${b})) && chats.get(realPeersById.get(${b})).unread === 1`, "opened, its 1 taken over");
  await bea.eval(`closeChat(), true`);
  await beaHeld.release();
  await bea.waitFor(`chats.get(realPeersById.get(${b})).loaded === true`, "its messages arrived (off screen)", 15000);
  await scrollList(bea);
  await bea.waitFor(`chats.size === 35 && !olderLoading`, "page 2 arrived", 10000);
  await bea.eval(`applyReadState(), true`);
  check((await bea.eval(`chats.get(realPeersById.get(${b})).unread`)) === 1, "1 unread — the server's read mark kept, not every kept message", await bea.eval(`chats.get(realPeersById.get(${b})).unread`));
  check(bea.errors.length === 0, "no page errors", bea.errors);
});
