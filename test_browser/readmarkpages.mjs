// Read marks for chats on later pages (2026-11-19). Every app open
// rewrote this phone's "read up to" marks keeping only the chats loaded so
// far (the first page): a chat read on this phone whose "read" never reached
// the server (offline, a failed send) came back unread once its page loaded
// — the server had no mark to put it back. The phone's own marks for chats
// not loaded yet are kept now, while older pages remain.
import { journey, step, check, server } from "./cdp.mjs";

const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
};
const loadOlder = async (p) => {
  await p.eval(`loadOlderChats(), true`);
  await p.waitFor(`chats.size === 35 && !chatsMore && !olderLoading`, `${p.name}: the older chats loaded`, 10000);
};
const peerNamed = (name) => `[...realPeersById.values()].find((p) => p.name === "${name}")`;
const note = (p) => p.eval(`HoodReadStore.read(window.localStorage, state.realUser.id) || {}`);

await journey("readmarkpages: this phone's read marks for chats past the first page survive a reload", async (browser) => {
  step("35 people message Sam; all loaded; Sam reads the quietest — the server never told");
  const sam = await browser.person("BT-Sam");
  const samId = await sam.id();
  await server(`chat_crowd 35 ${samId}`);
  await reload(sam);
  await loadOlder(sam);
  // (the "read" that would tell the server goes nowhere: as offline)
  await sam.eval(`(() => {
    const push = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => (ev === "read" ? { receive() { return this; } } : push(ev, payload, t));
    return true;
  })()`);
  const c1 = await sam.eval(`${peerNamed("BT-C1")}.id`);
  await sam.eval(`openChat(realPeersById.get(${c1})), true`);
  await sam.waitFor(`chats.get(realPeersById.get(${c1})).loaded === true && chats.get(realPeersById.get(${c1})).unread === 0`, "read here");
  await sam.eval(`closeChat(), true`);
  check(!(await sam.eval(`chats.get(realPeersById.get(${c1})).serverRead`)), "the server has no mark for it");
  check(!!(await note(sam))[c1], "this phone has", await note(sam));

  step("a reload: BT-C1 is past the first page — this phone's mark is kept");
  await reload(sam);
  check((await sam.eval(`chats.has(realPeersById.get(${c1}))`)) === false, "BT-C1 not in the first page");
  check(!!(await note(sam))[c1], "its mark still on this phone", Object.keys(await note(sam)).length);

  step("its page loads: read, not unread");
  await loadOlder(sam);
  check((await sam.eval(`chats.get(realPeersById.get(${c1})).unread`)) === 0, "BT-C1: 0 unread",
    await sam.eval(`chats.get(realPeersById.get(${c1})).unread`));
  const others = await sam.eval(`[...chats.entries()].filter(([p]) => p.id !== ${c1}).every(([, c]) => c.unread === 1)`);
  check(others, "the 34 others still 1 unread each");

  step("every page loaded: a mark for a chat that no longer exists is let go");
  await sam.eval(`(() => {
    const s = window.localStorage, id = state.realUser.id;
    HoodReadStore.save(s, id, { ...HoodReadStore.read(s, id), 999999999: [1, 1] });
    applyReadState();
    return true;
  })()`);
  check(!(await note(sam))["999999999"], "gone", await note(sam));
});
