// The 💬 count when a chat ends that isn't loaded yet (review of the block
// journeys, 2026-11-20; owner: "as comprehensive as possible covering every
// edge case"). The app loads the 30 most recent chats; older ones' unread
// come as numbers (unreadRest) and count in the 💬 badge. A chat ended
// while not loaded kept its unread in the count — for a chat gone. Every
// way a chat ends, and never anything else's: a block either way, End
// chat, the cleanup, while away, a reload, an unknown id, a page of older
// chats on its way meanwhile, a message just before, inside another chat.
import { journey, step, check, server } from "./cdp.mjs";
import { dropAndWait, restoreAndWait } from "./app.mjs";

const total = (p) => p.eval(`[...chats.values()].reduce((s, c) => s + c.unread, 0) + unreadMore`);
const badgeShows = async (p, n) => {
  const text = await p.eval(`document.getElementById("btn-chat").textContent`);
  check(n === 0 ? !/\d/.test(text) : text.includes(String(n)), `${p.name}: the 💬 button shows ${n}`, text);
};
const push = (p, event, peer) =>
  p.eval(`new Promise((ok) => userChannel.push(${JSON.stringify(event)}, { peer: ${peer} }).receive("ok", () => ok("ok")).receive("error", (e) => ok(e.reason)).receive("timeout", () => ok("timeout")))`);
// every "chat ended" this app heard (its own handler runs first: bound first)
const watchClosed = (p) => p.eval(`(window.__closed = [], userChannel.on("chat_closed", (m) => window.__closed.push(m.peer_id)), true)`);
const heardClosed = (p, id, what) => p.waitFor(`window.__closed.includes(${id})`, `${p.name}: ${what} — the close heard`, 10000);
// someone with 35 chats: 30 loaded, the 5 oldest counted apart (1 unread each)
async function crowded(browser, name) {
  const p = await browser.person(name);
  const id = await p.id();
  await server(`chat_crowd 35 ${id}`);
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading && chats.size === 30 && unreadRest.size === 5`, `${name}: 30 loaded, 5 counted apart`);
  await watchClosed(p);
  return { p, id, past: await p.eval(`[...unreadRest.keys()].sort((a, b) => a - b)`) };
}

await journey("chatunread: a chat ended while not loaded — its unread leaves the 💬 count, every way, nothing else's", async (browser) => {
  // the unread past the page drops by exactly its own (and the badge with it)
  const endsPast = async (p, id, what, act) => {
    const n = await p.eval(`unreadRest.get(${id}) || 0`);
    check(n > 0, `${what}: it had unread past the page`, n);
    const before = await total(p);
    await act();
    await heardClosed(p, id, what);
    check(!(await p.eval(`unreadRest.has(${id})`)), `${what}: its unread no longer counted`);
    const after = await total(p);
    check(after === before - n, `${what}: the 💬 count dropped by its unread — nothing else`, { before, after, n });
    await badgeShows(p, after);
  };

  step("Sam: 35 chats, 5 past the page; he blocks one (in his app)");
  const { p: sam, id: samId, past } = await crowded(browser, "BT-UnSam");
  await endsPast(sam, past[0], "Sam blocks", async () => check((await push(sam, "block", past[0])) === "ok", "blocked"));

  step("…one past the page blocks SAM");
  await endsPast(sam, past[1], "they block Sam", () => server(`block_pair ${past[1]} ${samId}`));

  step("…one past the page taps End chat");
  await endsPast(sam, past[2], "they end it", () => server(`end_chat ${past[2]} ${samId}`));

  step("…the cleanup ends one (someone away too long) — Sam inside another chat: the count beside ‹ drops too");
  const inside = await sam.eval(`[...chats.keys()][0].id`);
  await sam.eval(`openChat(realPeersById.get(${inside})), true`);
  await sam.waitFor(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${inside} && chats.get(state.chatPeer).loaded !== false`, "inside a chat");
  // (its own unread read once SEEN — readSeen, the frame after it's drawn —
  // before the count is taken: else that read landed inside the step and
  // the drop looked like two — precommit, 2026-11-22)
  await sam.waitFor(`chats.get(state.chatPeer).unread === 0`, "the chat she's in read");
  const besideBefore = await sam.eval(`document.getElementById("chat-back-count").textContent`);
  await endsPast(sam, past[3], "the cleanup", () => server(`close_chat ${past[3]} ${samId}`));
  const besideAfter = await sam.eval(`document.getElementById("chat-back-count").textContent`);
  check(Number(besideAfter) === Number(besideBefore) - 1, "the count beside ‹: one less", { besideBefore, besideAfter });
  await sam.eval(`closeChat(), true`);

  step("…Sam away (no connection) while the last one past the page ends: back, its unread gone");
  const beforeAway = await total(sam);
  const awayN = await sam.eval(`unreadRest.get(${past[4]})`);
  await dropAndWait(sam);
  await server(`close_chat ${past[4]} ${samId}`);
  await restoreAndWait(sam);
  await sam.waitFor(`!unreadRest.has(${past[4]})`, "gone after the rebuild", 10000);
  check((await total(sam)) === beforeAway - awayN, "the count dropped by its unread", { before: beforeAway, after: await total(sam), awayN });
  check((await sam.eval(`unreadMore`)) === 0 && (await sam.eval(`unreadRest.size`)) === 0, "nothing left counted apart");
  await watchClosed(sam);

  step("…a reload: the same count — the server's agrees with the app's");
  const beforeReload = await total(sam);
  await sam.eval(`softReload(), true`);
  await sam.waitFor(`hydrated && !reloading`, "reloaded");
  check((await total(sam)) === beforeReload, "the same after a reload", { before: beforeReload, after: await total(sam) });
  await badgeShows(sam, beforeReload);
  await watchClosed(sam);

  step("…a 'chat ended' about someone this app never heard of: nothing changes");
  const beforeUnknown = await total(sam);
  await sam.eval(`(userChannel.trigger("chat_closed", { peer_id: 987654321, reason: "ended" }), true)`);
  await heardClosed(sam, 987654321, "unknown");
  check((await total(sam)) === beforeUnknown && (await sam.eval(`unreadMore`)) === 0, "the count unchanged — never below what it was", await total(sam));
  check(sam.errors.length === 0, "no page errors", sam.errors);
  await sam.close();

  step("Tom: 35 chats; one past the page gets a NEW message, then ends — the count drops by both");
  const { p: tom, id: tomId, past: tomPast } = await crowded(browser, "BT-UnTom");
  const beforeSays = await total(tom);
  // (BT-C1: the oldest of the crowd — past the page whatever its id)
  await server(`crowd_says 1 ${tomId} one more thing`);
  await tom.waitFor(`${JSON.stringify(tomPast)}.some((id) => !unreadRest.has(id))`, "the new message took one past the page over", 10000);
  const saidId = await tom.eval(`${JSON.stringify(tomPast)}.find((id) => !unreadRest.has(id))`);
  const saidUnread = await tom.eval(`chatFor(realPeersById.get(${saidId})).unread`);
  check((await total(tom)) === beforeSays + 1 && saidUnread === 2, "the count: one more; that chat now 2", { before: beforeSays, after: await total(tom), saidUnread });
  const beforeSaid = await total(tom);
  await server(`close_chat ${saidId} ${tomId}`);
  await heardClosed(tom, saidId, "ended after its message");
  check((await total(tom)) === beforeSaid - saidUnread, "the count dropped by all its unread", { before: beforeSaid, after: await total(tom) });
  check(!(await tom.eval(`chats.has(realPeersById.get(${saidId}))`)), "the chat gone");

  step("…a page of older chats on its way (answered, not yet arrived) while one of them ends: it never comes back");
  const left = await tom.eval(`[...unreadRest.keys()].sort((a, b) => a - b)`);
  check(left.length === 4, "4 still past the page", left);
  const held = await tom.holdResponses("*/api/chats?before=*");
  await tom.click("btn-chat");
  await tom.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length >= 30`, "the list drawn");
  await tom.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
  for (let i = 0; i < 100 && held.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(held.count() === 1, "the page's answer held", held.count());
  const beforeHeld = await total(tom);
  await server(`close_chat ${left[0]} ${tomId}`);
  await heardClosed(tom, left[0], "ended while the page was on its way");
  check((await total(tom)) === beforeHeld - 1, "its unread left the count", { before: beforeHeld, after: await total(tom) });
  await held.release();
  await tom.waitFor(`!olderLoading && chatsMore === null`, "the page arrived", 10000);
  check(!(await tom.eval(`chats.has(realPeersById.get(${left[0]})) || unreadRest.has(${left[0]})`)), "the ended chat didn't come back — neither the chat nor its unread");
  check((await tom.eval(`chats.size`)) === 33, "33 chats: 35, less the two ended", await tom.eval(`chats.size`));
  check((await total(tom)) === beforeHeld - 1 && (await tom.eval(`unreadMore`)) === 0, "the count still right", { before: beforeHeld, after: await total(tom) });

  step("…all loaded now: one of the older ones ends — counted once, not twice");
  const loadedOne = await tom.eval(`chatFor(realPeersById.get(${left[1]})).unread`);
  check(loadedOne > 0, "it has unread", loadedOne);
  const beforeLoaded = await total(tom);
  await tom.eval(`closeChat(), true`);
  await server(`close_chat ${left[1]} ${tomId}`);
  await heardClosed(tom, left[1], "a loaded older one");
  check((await total(tom)) === beforeLoaded - loadedOne, "the count dropped by its unread once", { before: beforeLoaded, after: await total(tom), loadedOne });
  check((await tom.eval(`unreadMore`)) === 0, "nothing counted apart below zero");

  step("…an older chat READ, then past the page again after a reload (no unread): it ends — the count unchanged");
  await tom.eval(`openChat(realPeersById.get(${left[2]})), true`);
  await tom.waitFor(`chats.get(realPeersById.get(${left[2]})).loaded === true && chats.get(realPeersById.get(${left[2]})).unread === 0`, "read");
  await tom.waitFor(`!!chats.get(realPeersById.get(${left[2]})).serverRead`, "the server told");
  await tom.eval(`closeChat(), true`);
  await tom.eval(`softReload(), true`);
  await tom.waitFor(`hydrated && !reloading && !chats.has(realPeersById.get(${left[2]}))`, "past the page again");
  await watchClosed(tom);
  check(!(await tom.eval(`unreadRest.has(${left[2]})`)), "no unread counted for it");
  const beforeRead = await total(tom);
  await server(`close_chat ${left[2]} ${tomId}`);
  await heardClosed(tom, left[2], "a read one past the page");
  check((await total(tom)) === beforeRead, "the count unchanged", { before: beforeRead, after: await total(tom) });
  check((await tom.eval(`unreadMore`)) >= 0, "never below zero", await tom.eval(`unreadMore`));
  check(tom.errors.length === 0, "no page errors", tom.errors);
  await tom.close();

  // (the page coming brings the unread of the chats PAST it too: one of
  // those ended meanwhile mustn't come back into the count)
  step("Uma: 65 chats; page 2 on its way while the oldest — past page 2 too — ends: its unread never comes back");
  const uma = await browser.person("BT-UnUma");
  const umaId = await uma.id();
  await server(`chat_crowd 65 ${umaId}`);
  await uma.eval(`softReload(), true`);
  await uma.waitFor(`hydrated && !reloading && chats.size === 30 && unreadRest.size === 35`, "30 loaded, 35 counted apart");
  await watchClosed(uma);
  const umaHeld = await uma.holdResponses("*/api/chats?before=*");
  await uma.click("btn-chat");
  await uma.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length >= 30`, "the list drawn");
  await uma.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
  for (let i = 0; i < 100 && umaHeld.count() === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(umaHeld.count() === 1, "page 2's answer held", umaHeld.count());
  const beforeUma = await total(uma);
  // BT-C1: the crowd's oldest — past page 2
  await server(`crowd_close 1 ${umaId}`);
  await uma.waitFor(`window.__closed.length === 1`, "the close heard", 10000);
  const oldestId = await uma.eval(`window.__closed[0]`);
  check((await total(uma)) === beforeUma - 1, "its unread left the count", { before: beforeUma, after: await total(uma) });
  await umaHeld.release();
  await uma.waitFor(`!olderLoading && chats.size === 60`, "page 2 arrived: 60 loaded", 10000);
  check(!(await uma.eval(`unreadRest.has(${oldestId}) || chats.has(realPeersById.get(${oldestId}))`)), "the ended one: not back — not its unread, not the chat");
  check((await uma.eval(`unreadRest.size`)) === 4, "4 still past page 2", await uma.eval(`unreadRest.size`));
  check((await total(uma)) === beforeUma - 1, "the count still right", { before: beforeUma, after: await total(uma) });
  check(uma.errors.length === 0, "no page errors", uma.errors);
});
