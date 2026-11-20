// A reload's verdict on the chat you had open (review of the older chats,
// 2026-11-20 — chatgone.mjs is the plain case):
//   - ‹ back to the list, that chat ended while away: the line, and the
//     LIST stays (it closed the whole panel, other chats and all);
//   - your first message to someone sent while a reload's answer was on
//     its way (that answer from before it): the chat stays, the message in
//     it (a reviewer's worry — already safe: what you send counts as news,
//     tapNews, so the reload asks again);
//   - a chat found gone when opened: the neutral line, not "away a while";
//   - a page confirming a chat opened ahead of it: no longer "maybe new";
//   - a request's note from someone with no chat: not taken as the server's;
//   - a page asked for before a reload, landing after it: dropped.
import { journey, step, check, server } from "./cdp.mjs";
import { openChatWith, typeText, send, dropAndWait, restoreAndWait, goOnline, sees } from "./app.mjs";

const watchBanners = (p) =>
  p.eval(`(window.__banners = [], new MutationObserver(() => window.__banners.push(document.getElementById("banner").textContent)).observe(document.getElementById("banner"), { childList: true, characterData: true, subtree: true }), true)`);

await journey("chatreload: a reload's 'ended' keeps the list, never takes a message just sent; a chat found gone says so plainly", async (browser) => {
  step("Cal: 3 chats; BT-C1's opened, ‹ back to the list; away, it ends; back: the line — and the list stays, with the other two");
  const cal = await browser.person("BT-RlCal");
  const calId = await cal.id();
  await server(`chat_crowd 3 ${calId}`);
  await cal.eval(`softReload(), true`);
  await cal.waitFor(`hydrated && !reloading && chats.size === 3 && chatsMore === null`, "3 chats, all here");
  const c1 = await cal.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  await cal.click("btn-chat");
  await cal.eval(`openChat(realPeersById.get(${c1})), true`);
  await cal.waitFor(`chats.get(realPeersById.get(${c1})).loaded === true`, "BT-C1 open");
  await cal.click("chat-back");
  await cal.waitFor(`state.chatView === "list"`, "‹ back to the list");
  await dropAndWait(cal);
  await server(`crowd_close 1 ${calId}`);
  await watchBanners(cal);
  await restoreAndWait(cal);
  await cal.waitFor(`hydrated && !reloading && chats.size === 2`, "back: BT-C1's chat gone", 10000);
  await cal.waitFor(`window.__banners.includes("Chat with BT-C1 ended")`, "the line said", 5000);
  check(await cal.eval(`!document.getElementById("chat").classList.contains("hidden") && state.chatView === "list"`), "the list still open");
  check((await cal.eval(`document.querySelectorAll("#chat-messages .chat-item").length`)) === 2, "the other two in it");
  check(cal.errors.length === 0, "no page errors", cal.errors);
  await cal.close();

  step("Dot: her first message to Bo sent while a reload's answer (from before it) is on its way: the chat stays, her message in it");
  const bo = await browser.person("BT-RlBo");
  const dot = await browser.person("BT-RlDot");
  const boId = await bo.id();
  await goOnline(bo);
  await sees(dot, boId, "(his car)");
  await openChatWith(dot, boId);
  const held = await dot.holdResponses("*/api/state*");
  await dot.eval(`softReload(), true`);
  for (let i = 0; i < 100 && held.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(held.count() === 1, "the reload's answer held (made before the message)", held.count());
  await typeText(dot, "hi Bo");
  await send(dot);
  await dot.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.text === "hi Bo" && m.id != null)`, "sent: the server has it");
  await watchBanners(dot);
  await held.release();
  await dot.waitFor(`hydrated && !reloading`, "reloaded", 15000);
  await new Promise((r) => setTimeout(r, 500));
  check(!(await dot.eval(`window.__banners`)).some((b) => b.includes("ended")), "never 'ended'", await dot.eval(`window.__banners`));
  check(await dot.eval(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${boId}`), "the chat still open");
  await dot.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.text === "hi Bo")`, "her message in it", 10000);
  check(dot.errors.length === 0, "no page errors", dot.errors);
  await dot.close();
  await bo.close();

  step("Eve: a chat found gone when she opens it: 'Chat with BT-C1 ended' — not 'they've been away a while'");
  const eve = await browser.person("BT-RlEve");
  const eveId = await eve.id();
  await server(`chat_crowd 3 ${eveId}`);
  await eve.eval(`softReload(), true`);
  await eve.waitFor(`hydrated && !reloading && chats.size === 3`, "3 chats");
  const e1 = await eve.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  check(await eve.eval(`chats.get(realPeersById.get(${e1})).loaded === false`), "BT-C1's: a summary (its messages fetched when opened)");
  // (as if it ended a moment ago, its news not here yet: the server has none)
  const gone = await eve.answerWith("*/api/chat?peer=*", JSON.stringify({ error: "none" }), 1, [], { status: 404, type: "application/json" });
  await watchBanners(eve);
  await eve.click("btn-chat");
  await eve.eval(`openChat(realPeersById.get(${e1})), true`);
  await eve.waitFor(`!chats.has(realPeersById.get(${e1}))`, "closed", 10000);
  check(gone.count() === 1, "answered: none");
  await eve.waitFor(`window.__banners.length > 0`, "a line said", 5000);
  check((await eve.eval(`window.__banners`)).includes("Chat with BT-C1 ended"), "the neutral line", await eve.eval(`window.__banners`));
  check(eve.errors.length === 0, "no page errors", eve.errors);
  await eve.close();

  // (review, 2026-11-20) a page confirmed a chat opened from a card ahead of
  // it, but it stayed "maybe new": had it ended before its messages came, a
  // "none" turned it into a NEW empty chat — not closed
  step("Fay: a page-2 chat opened from a card, its messages slow; page 2 then has it: no longer 'maybe new'");
  const fay = await browser.person("BT-RlFay");
  const fayId = await fay.id();
  await server(`chat_crowd 35 ${fayId}`);
  await fay.eval(`softReload(), true`);
  await fay.waitFor(`hydrated && !reloading && chats.size === 30 && unreadRest.size === 5`, "30 loaded, 5 counted apart");
  // (BT-C1, on page 2, read first: nothing unread — so the app can't know
  // the server has it; then a reload, page 1 only)
  await fay.click("btn-chat");
  await fay.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
  await fay.waitFor(`chats.size === 35 && !olderLoading`, "all 35", 10000);
  const f = await fay.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  await fay.eval(`openChat(realPeersById.get(${f})), true`);
  await fay.waitFor(`chats.get(realPeersById.get(${f})).unread === 0 && !!chats.get(realPeersById.get(${f})).serverRead`, "BT-C1 read");
  await fay.eval(`closeChat(), softReload(), true`);
  await fay.waitFor(`hydrated && !reloading && chats.size === 30 && !unreadRest.has(${f})`, "page 1 only; BT-C1 past it, nothing unread");
  const slow = await fay.holdResponses("*/api/chat?peer=*");
  await fay.eval(`openChat(ensurePeer({ id: ${f}, name: "BT-Page2" })), true`);
  await fay.waitFor(`chats.has(realPeersById.get(${f}))`, "opened");
  check(await fay.eval(`chats.get(realPeersById.get(${f})).maybeNew === true`), "maybe new (older chats not all here)");
  // (kept open — closed, a chat with nothing in it yet is let go; page 2
  // fetched as scrolling the list would)
  await fay.eval(`loadOlderChats(), true`);
  await fay.waitFor(`chats.size === 35 && !olderLoading`, "page 2 arrived, with it", 10000);
  check(await fay.eval(`chats.get(realPeersById.get(${f})) === chats.get(state.chatPeer)`), "the same chat (not replaced)");
  check(await fay.eval(`chats.get(realPeersById.get(${f})).maybeNew === false`), "page 2 had it: not new — a later 'none' means it ended");
  await slow.release();
  check(fay.errors.length === 0, "no page errors", fay.errors);
  await fay.close();

  // (review, 2026-11-20) a request (a note, no message) from someone with no
  // chat, older chats not all here: the chat was taken as the server's —
  // opened, "none": "Chat with … ended", the note gone
  step("Gus: 35 chats; a ride request from Ray (no chat between them): the chat opens with its note — never 'ended'");
  const ray = await browser.person("BT-RlRay");
  const rayId = await ray.id();
  const gus = await browser.person("BT-RlGus");
  const gusId = await gus.id();
  await server(`chat_crowd 35 ${gusId}`);
  await gus.eval(`softReload(), true`);
  await gus.waitFor(`hydrated && !reloading && chats.size === 30 && !!chatsMore`, "30 loaded, more to come");
  await gus.eval(`userChannel.trigger("request", { from: { id: ${rayId}, name: "BT-RlRay", photo: null } }), true`);
  await gus.waitFor(`chats.has(realPeersById.get(${rayId}))`, "a chat with Ray, the note in it");
  await watchBanners(gus);
  await gus.click("btn-chat");
  await gus.eval(`openChat(realPeersById.get(${rayId})), true`);
  await gus.waitFor(`chats.has(realPeersById.get(${rayId})) && chats.get(realPeersById.get(${rayId})).loaded === true`, "its messages asked for — none: a new chat", 10000);
  check(!(await gus.eval(`window.__banners`)).some((b) => b.includes("ended")), "never 'ended'", await gus.eval(`window.__banners`));
  check(await gus.eval(`state.chatPeer && state.chatPeer.id === ${rayId} && !document.getElementById("chat").classList.contains("hidden")`), "the chat open");
  check(await gus.eval(`chats.get(state.chatPeer).msgs.some((m) => m.text.includes("requested a ride"))`), "the note kept");
  check(gus.errors.length === 0, "no page errors", gus.errors);
  await gus.close();
  await ray.close();

  // (review, 2026-11-20) a page of older chats asked for before a reload,
  // landing after it (the same cursor: nothing new on page 1): applied — a
  // chat that ended while away came back
  step("Hal: page 2 on its way; he drops off; a page-2 chat ends; back (a reload); then page 2 lands: that chat stays gone");
  const hal = await browser.person("BT-RlHal");
  const halId = await hal.id();
  await server(`chat_crowd 35 ${halId}`);
  await hal.eval(`softReload(), true`);
  await hal.waitFor(`hydrated && !reloading && chats.size === 30 && !!chatsMore`, "30 loaded, more to come");
  const restBefore = await hal.eval(`[...unreadRest.keys()]`);
  const cursorBefore = await hal.eval(`chatsMore`);
  const page2 = await hal.holdResponses("*/api/chats?before=*");
  await hal.eval(`loadOlderChats(), true`);
  for (let i = 0; i < 100 && page2.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(page2.count() === 1, "page 2 (with BT-C1) held", page2.count());
  await dropAndWait(hal);
  await server(`crowd_close 1 ${halId}`);
  await restoreAndWait(hal);
  await hal.waitFor(`hydrated && !reloading && unreadRest.size === 4`, "back: reloaded, BT-C1 gone from the counts", 10000);
  const h1 = (await hal.eval(`${JSON.stringify(restBefore)}.find((id) => !unreadRest.has(id))`));
  check(typeof h1 === "number", "the one that ended: known", h1);
  check((await hal.eval(`chatsMore`)) === cursorBefore, "the same cursor (page 1 unchanged)");
  await page2.release();
  await hal.waitFor(`!olderLoading`, "the old page landed", 10000);
  check(!(await hal.eval(`chats.has(realPeersById.get(${h1}))`)), "BT-C1 not back");
  check(!(await hal.eval(`unreadRest.has(${h1})`)), "nor its unread");
  check(hal.errors.length === 0, "no page errors", hal.errors);
  await hal.close();

  // (review, 2026-11-20) a page asked for before a reload failing after it:
  // the NEW list said "Couldn't load older chats — tap to try again"
  step("Ida: page 2 on its way; a reload; then that old request fails: the new list doesn't say it couldn't load");
  const ida = await browser.person("BT-RlIda");
  const idaId = await ida.id();
  await server(`chat_crowd 35 ${idaId}`);
  await ida.eval(`softReload(), true`);
  await ida.waitFor(`hydrated && !reloading && chats.size === 30 && !!chatsMore`, "30 loaded, more to come");
  // (this page's request fails — but only when let go: after the reload)
  await ida.eval(`(() => { const real = window.fetch; window.__failPage = null; window.fetch = (u, o) => String(u).includes("/api/chats?before=") && !window.__pageFailed ? new Promise((_, no) => { window.__failPage = () => { window.__pageFailed = true; no(new TypeError("Failed to fetch")); }; }) : real(u, o); return true; })()`);
  await ida.eval(`loadOlderChats(), true`);
  await ida.waitFor(`olderLoading && !!window.__failPage`, "page 2 on its way");
  await ida.eval(`softReload(), true`);
  await ida.waitFor(`hydrated && !reloading && chats.size === 30`, "reloaded");
  await ida.eval(`window.__failPage(), true`);
  await ida.waitFor(`!olderLoading`, "the old request failed");
  check(!(await ida.eval(`olderFailed`)), "the new list: no 'couldn't load'");
  check(ida.errors.length === 0, "no page errors", ida.errors);
});
