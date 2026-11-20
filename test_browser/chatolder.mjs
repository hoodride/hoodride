// Chats older than the pages loaded so far (review of the block journeys,
// 2026-11-20; owner: "deal with them … fix any bugs reviewers find"). The
// app loads the 30 most recent chats; an older one isn't here until the
// list is scrolled, its unread counted apart (unreadRest).
//   - opened before it's loaded (from someone's card on the map): its
//     history wasn't fetched — an empty chat — and its unread stayed in the
//     💬 count after reading it. Now: fetched, read, counted once;
//   - someone with no chat at all, opened the same way: a new empty chat,
//     never closed as "gone";
//   - a message to an older chat while a page of older chats is on its
//     way: the page brought back the unread the message had taken over;
//   - a reload while a page is on its way: "Loading older chats…" stuck.
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

await journey("chatolder: chats older than the pages loaded — opened early, a page on its way, a reload meanwhile", async (browser) => {
  step("Pam: 35 chats; she opens one of the 5 older ones before it's loaded (as from someone's card): its history comes, it's read, counted once");
  const { p: pam } = await crowded(browser, "BT-OlPam", 35);
  const olderId = await pam.eval(`[...unreadRest.keys()].sort((a, b) => a - b)[0]`);
  const olderUnread = await pam.eval(`unreadRest.get(${olderId})`);
  const before = await total(pam);
  await pam.eval(`openChat(ensurePeer({ id: ${olderId}, name: "BT-Older" })), true`);
  await pam.waitFor(`state.chatPeer && state.chatPeer.id === ${olderId} && chats.get(state.chatPeer).loaded === true`, "its history loaded", 15000);
  const texts = await pam.eval(`chats.get(state.chatPeer).msgs.map((m) => m.text)`);
  check(texts.length === 1 && texts[0].startsWith("hi from BT-C"), "its earlier message shown — not an empty chat", texts);
  check(!(await pam.eval(`unreadRest.has(${olderId})`)), "no longer counted apart");
  check((await total(pam)) === before - olderUnread, "read: the 💬 count dropped by its unread — once", { before, after: await total(pam), olderUnread });
  await pam.eval(`closeChat(), true`);
  check(await pam.eval(`chats.has(realPeersById.get(${olderId}))`), "kept in the list after closing (the server has it)");

  step("…someone she's never chatted with, opened the same way: a new empty chat — open, not closed as 'gone'");
  const ned = await browser.person("BT-OlNed");
  const nedId = await ned.id();
  await pam.eval(`openChat(ensurePeer({ id: ${nedId}, name: "BT-OlNed" })), true`);
  await pam.waitFor(`state.chatPeer && state.chatPeer.id === ${nedId} && chats.get(state.chatPeer).loaded === true`, "settled", 15000);
  await new Promise((r) => setTimeout(r, 300));
  check(await pam.eval(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${nedId}`), "still open");
  check((await pam.eval(`chats.get(state.chatPeer).msgs.length`)) === 0, "empty");
  check(!(await pam.eval(`document.getElementById("banner").textContent.includes("ended")`)), "no 'ended' line", await pam.eval(`document.getElementById("banner").textContent`));
  await pam.eval(`closeChat(), true`);
  check(pam.errors.length === 0 && ned.errors.length === 0, "no page errors", [...pam.errors, ...ned.errors]);
  await ned.close();
  await pam.close();

  step("Ray: 65 chats; page 2 on its way while the oldest (past page 2) gets a NEW message: counted once, not its old unread twice");
  const { p: ray, id: rayId } = await crowded(browser, "BT-OlRay", 65);
  const held = await ray.holdResponses("*/api/chats?before=*");
  await scrollList(ray);
  for (let i = 0; i < 100 && held.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(held.count() === 1, "page 2's answer held", held.count());
  const beforeRay = await total(ray);
  // BT-C1: the crowd's oldest — past page 2
  await server(`crowd_says 1 ${rayId} one more thing`);
  await ray.waitFor(`[...chats.values()].some((c) => c.restUnread === 1 && c.unread === 2)`, "the message took its older chat over", 10000);
  check((await total(ray)) === beforeRay + 1, "the count: one more", { before: beforeRay, after: await total(ray) });
  await held.release();
  await ray.waitFor(`!olderLoading && chats.size === 61`, "page 2 arrived: 60 + the one taken over", 10000);
  check((await total(ray)) === beforeRay + 1, "still one more — its old unread not counted again", { before: beforeRay, after: await total(ray) });
  check((await ray.eval(`unreadRest.size`)) === 4, "4 still past page 2", await ray.eval(`unreadRest.size`));
  check(ray.errors.length === 0, "no page errors", ray.errors);
  await ray.close();

  step("Sid: 35 chats; a reload while page 2 is on its way: the older chats still load when the list is scrolled");
  const { p: sid } = await crowded(browser, "BT-OlSid", 35);
  const sidHeld = await sid.holdResponses("*/api/chats?before=*");
  await scrollList(sid);
  for (let i = 0; i < 100 && sidHeld.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(sidHeld.count() === 1, "page 2's answer held", sidHeld.count());
  await sid.eval(`softReload(), true`);
  await sid.waitFor(`hydrated && !reloading && chats.size === 30`, "reloaded: the first page again");
  await sidHeld.release();
  // the list still OPEN, "Loading older chats…" already in view at its end:
  // the older ones load by themselves — the row isn't left stuck (its watcher
  // looked while the old load still ran; nothing redrew it after)
  check(await sid.eval(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`), "the list still open");
  await sid.waitFor(`chats.size === 35 && !document.querySelector("#chat-messages .chat-more")`, "the older chats loaded — no row stuck", 10000);
  check(sid.errors.length === 0, "no page errors", sid.errors);
  // (review, 2026-11-20) a page of older chats must never touch a chat that's
  // already here: it emptied one opened from a card (its live message lost)
  // or left it "Loading…" with Send doing nothing
  step("Quinn: an older chat (read, so nothing counted for it), opened from a card; a page on its way AND its own messages on their way when it gets a new message: the message stays");
  const { p: quinn, id: quinnId } = await crowded(browser, "BT-OlQuinn", 35);
  await scrollList(quinn);
  await quinn.waitFor(`chats.size === 35 && !olderLoading`, "all 35 loaded", 10000);
  const c1 = await quinn.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  await quinn.eval(`closeChat(), openChat(realPeersById.get(${c1})), true`);
  await quinn.waitFor(`chats.get(realPeersById.get(${c1})).loaded === true && chats.get(realPeersById.get(${c1})).unread === 0`, "BT-C1 read");
  await quinn.waitFor(`!!chats.get(realPeersById.get(${c1})).serverRead`, "the server told");
  await quinn.eval(`closeChat(), true`);
  await quinn.eval(`softReload(), true`);
  await quinn.waitFor(`hydrated && !reloading && chats.size === 30 && !chats.has(realPeersById.get(${c1})) && !unreadRest.has(${c1})`, "BT-C1 past the page again, nothing counted for it");
  const quinnHeld = await quinn.holdResponses(["*/api/chats?before=*", "*/api/chat?peer=*"]);
  await scrollList(quinn);
  for (let i = 0; i < 100 && quinnHeld.count("/api/chats?before") === 0; i++) await new Promise((r) => setTimeout(r, 50));
  await quinn.eval(`openChat(ensurePeer({ id: ${c1}, name: "BT-C1" })), true`);
  for (let i = 0; i < 100 && quinnHeld.count("/api/chat?peer") === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(quinnHeld.count("/api/chats?before") === 1 && quinnHeld.count("/api/chat?peer") === 1, "the page and its messages both held", [quinnHeld.count("/api/chats?before"), quinnHeld.count("/api/chat?peer")]);
  await server(`crowd_says 1 ${quinnId} live one`);
  await quinn.waitFor(`chats.get(realPeersById.get(${c1})).msgs.some((m) => m.text === "live one")`, "the live message held in it", 10000);
  await quinnHeld.release("/api/chats?before");
  await quinn.waitFor(`!olderLoading`, "the page arrived", 10000);
  await quinnHeld.release();
  await quinn.waitFor(`chats.get(realPeersById.get(${c1})).loaded === true`, "its messages arrived", 10000);
  const c1Texts = await quinn.eval(`chats.get(realPeersById.get(${c1})).msgs.map((m) => m.text)`);
  check(c1Texts.includes("live one") && c1Texts.some((t) => t.startsWith("hi from BT-C1")), "its earlier message AND the live one — nothing lost", c1Texts);
  check(quinn.errors.length === 0, "no page errors", quinn.errors);
  await quinn.close();

  // (review, 2026-11-20) an older chat opened from a card takes its unread
  // over; a page fetched AFTER that still carried its count — counted twice
  step("Rex: 65 chats; one past page 2 (with unread) opened from a card, its messages slow; then page 2 loads: its unread counted once");
  const { p: rex } = await crowded(browser, "BT-OlRex", 65);
  const beyond = await rex.eval(`fetch("/api/chats?before=" + encodeURIComponent(chatsMore)).then((r) => r.json()).then((b) => Object.keys(b.unread_rest).map(Number))`);
  check(beyond.length === 5, "5 past page 2", beyond);
  const x = beyond[0];
  const beforeRex = await total(rex);
  const rexHeld = await rex.holdResponses("*/api/chat?peer=*");
  await rex.eval(`openChat(ensurePeer({ id: ${x}, name: "BT-Far" })), true`);
  await rex.waitFor(`chats.has(realPeersById.get(${x})) && chats.get(realPeersById.get(${x})).unread === 1 && !unreadRest.has(${x})`, "its unread taken over");
  check((await total(rex)) === beforeRex, "counted once so far", { before: beforeRex, after: await total(rex) });
  await rex.eval(`closeChat(), true`);
  await scrollList(rex);
  await rex.waitFor(`!olderLoading && chats.size >= 61`, "page 2 arrived", 10000);
  check(!(await rex.eval(`unreadRest.has(${x})`)), "not counted apart again");
  check((await total(rex)) === beforeRex, "the 💬 count: still once", { before: beforeRex, after: await total(rex) });
  await rexHeld.release();
  check(rex.errors.length === 0, "no page errors", rex.errors);
  // (review, 2026-11-20) a draft in an older chat, carried over a reload:
  // the chat came back as an empty shell "loaded" — a page then never
  // filled it (it never touches a chat that's here): no history, ever
  step("Una: a draft in an older chat, then a reload: the chat keeps its history (fetched when opened) and the draft");
  const { p: una } = await crowded(browser, "BT-OlUna", 35);
  await scrollList(una);
  await una.waitFor(`chats.size === 35 && !olderLoading`, "all 35 loaded", 10000);
  const unaC1 = await una.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  await una.eval(`closeChat(), openChat(realPeersById.get(${unaC1})), true`);
  await una.waitFor(`chats.get(realPeersById.get(${unaC1})).loaded === true`, "BT-C1 open");
  await una.eval(`(() => { const i = document.getElementById("chat-input"); i.value = "a draft for C1"; i.dispatchEvent(new Event("input")); return true; })()`);
  await una.eval(`closeChat(), true`);
  check((await una.eval(`chats.get(realPeersById.get(${unaC1})).draft`)) === "a draft for C1", "the draft kept");
  await una.eval(`softReload(), true`);
  await una.waitFor(`hydrated && !reloading && chats.size === 31`, "reloaded: page 1 + the drafted chat");
  await scrollList(una);
  await una.waitFor(`!olderLoading && chats.size === 35`, "page 2 arrived", 10000);
  await una.eval(`closeChat(), openChat(realPeersById.get(${unaC1})), true`);
  await una.waitFor(`chats.get(realPeersById.get(${unaC1})).loaded === true`, "opened", 15000);
  const unaTexts = await una.eval(`chats.get(realPeersById.get(${unaC1})).msgs.map((m) => m.text)`);
  check(unaTexts.some((t) => t.startsWith("hi from BT-C1")), "its history shown — not an empty chat", unaTexts);
  check((await una.eval(`document.getElementById("chat-input").value`)) === "a draft for C1", "the draft in the box");
  check(una.errors.length === 0, "no page errors", una.errors);
});
