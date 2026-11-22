// The chat list in pages (owner, 2026-11-14). Nothing capped how many
// chats other people start with you, and every app open and reconnect
// brought every one. Now the first page comes (the 30 most recent), older
// ones as the list is scrolled ("Loading older chats…"), and the 💬 badge
// still counts every unread message — the ones in chats not loaded yet
// counted on the server, from a "read up to" the app keeps there too.
import { journey, step, check, server } from "./cdp.mjs";

const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
};
const badge = (p) => p.eval(`document.getElementById("btn-chat").textContent`);
// the unread count the 💬 button shows, as the app counts it
const unreadTotal = (p) => p.eval(`[...chats.values()].reduce((s, c) => s + c.unread, 0) + unreadMore`);
const rows = (p) => p.eval(`document.querySelectorAll("#chat-messages .chat-item").length`);
const moreRow = (p) => p.eval(`(document.querySelector("#chat-messages .chat-more") || {}).textContent || null`);

await journey("chatpages: the chat list in pages; the 💬 badge counts every chat's unread", async (browser) => {
  step("35 people message Sam; a reload brings the 30 most recent — the badge still says 35");
  const sam = await browser.person("BT-Sam");
  const samId = await sam.id();
  await server(`chat_crowd 35 ${samId}`);
  await reload(sam);
  check((await sam.eval(`chats.size`)) === 30, "30 chats loaded", await sam.eval(`chats.size`));
  check((await sam.eval(`unreadMore`)) === 5, "5 unread in the chats not loaded", await sam.eval(`unreadMore`));
  check((await unreadTotal(sam)) === 35, "the badge counts all 35");
  check((await badge(sam)).includes("35"), "…and shows it", await badge(sam));

  step("the list: 30 rows, then older chats load as it's scrolled to the end — 35, nothing twice");
  await sam.click("btn-chat");
  await sam.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length >= 30`, "the list drawn");
  check((await moreRow(sam)) !== null, "a row for older chats at the end", await moreRow(sam));
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
  await sam.waitFor(`chats.size === 35 && !document.querySelector("#chat-messages .chat-more")`, "the older chats loaded", 10000);
  check((await rows(sam)) === 35, "35 rows", await rows(sam));
  const names = await sam.eval(`[...document.querySelectorAll("#chat-messages .chat-item strong")].map((s) => s.textContent)`);
  check(new Set(names).size === 35, "each chat once", names);
  check(names.at(-1) === "BT-C1", "the quietest last", names.at(-1));
  check((await sam.eval(`unreadMore`)) === 0, "nothing left unloaded");
  check((await unreadTotal(sam)) === 35, "still 35 unread in all");

  step("Sam reads the quietest chat; after a reload it's past the first page again — the server knows it's read");
  const c1 = await sam.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C1").id`);
  await sam.eval(`openChat(realPeersById.get(${c1})), true`);
  await sam.waitFor(`chats.get(realPeersById.get(${c1})).loaded === true && chats.get(realPeersById.get(${c1})).unread === 0`, "read");
  await sam.waitFor(`!!chats.get(realPeersById.get(${c1})).serverRead`, "the server told");
  await sam.eval(`closeChat(), true`);
  // (this phone's own bookmark gone — as on another phone: only the server's counts)
  await sam.eval(`HoodReadStore.forget(window.localStorage, state.realUser.id), true`);
  await reload(sam);
  check((await sam.eval(`chats.has(realPeersById.get(${c1}))`)) === false, "BT-C1 not in the first page");
  check((await sam.eval(`unreadMore`)) === 4, "4 unread past the page, not 5", await sam.eval(`unreadMore`));
  check((await unreadTotal(sam)) === 34, "the badge: 34", await unreadTotal(sam));

  // (owner, 2026-11-14 — "it's accurate?": it wasn't. A chat not loaded
  // came back as a NEW empty one: its earlier messages missing on screen,
  // and its unread stayed in the server's count after it was read)
  step("BT-C3 — not loaded — writes again: on top, its whole history when opened, the badge right before and after");
  await server(`crowd_says 3 ${samId} are you around?`);
  await sam.waitFor(`[...chats.keys()].some((p) => p.name === "BT-C3")`, "BT-C3's chat here");
  check((await unreadTotal(sam)) === 35, "the badge: 35 (its 1 old + 1 new)", await unreadTotal(sam));
  const c3 = await sam.eval(`[...realPeersById.values()].find((p) => p.name === "BT-C3").id`);
  await sam.eval(`openChat(realPeersById.get(${c3})), true`);
  await sam.waitFor(`chats.get(realPeersById.get(${c3})).loaded === true`, "its messages loaded", 10000);
  const texts = await sam.eval(`chats.get(realPeersById.get(${c3})).msgs.map((m) => m.text)`);
  check(texts.includes("hi from BT-C3") && texts.includes("are you around?"), "its earlier message too", texts);
  check(texts.filter((x) => x === "are you around?").length === 1, "the new one once", texts);
  // (marked read once SEEN — readSeen, on the frame after it's drawn: not
  // the moment its messages load. Checked at once, a busy machine's late
  // frame read 35 — precommit, 2026-11-22)
  await sam.waitFor(`[...chats.values()].reduce((s, c) => s + c.unread, 0) + unreadMore === 33`, "read: the badge 33");
  await sam.eval(`closeChat(), true`);
  // BT-C4 too, left unopened: its 1 old + 1 new stay counted when the older
  // chats load (the recount)
  await server(`crowd_says 4 ${samId} still there?`);
  await sam.waitFor(`[...chats.keys()].some((p) => p.name === "BT-C4")`, "BT-C4's chat here");
  check((await unreadTotal(sam)) === 34, "the badge: 34", await unreadTotal(sam));

  step("the older chats can't load: said so, and a tap tries again");
  await sam.eval(`(() => {
    const f = window.fetch.bind(window);
    window.__failChats = true;
    window.fetch = (u, o) => (String(u).startsWith("/api/chats?") && window.__failChats ? Promise.resolve(new Response("{}", { status: 503 })) : f(u, o));
    return true;
  })()`);
  await sam.click("btn-chat");
  await sam.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
  await sam.waitFor(`(document.querySelector("#chat-messages .chat-more") || {}).textContent === t("Couldn't load older chats — tap to try again")`, "the failure said");
  await sam.eval(`window.__failChats = false, document.querySelector("#chat-messages .chat-more").click(), true`);
  await sam.waitFor(`chats.size === 35 && !document.querySelector("#chat-messages .chat-more")`, "loaded on the tap", 10000);
  check((await unreadTotal(sam)) === 34, "still 34 with every chat loaded", await unreadTotal(sam));
});
