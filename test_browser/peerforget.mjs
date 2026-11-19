// People this page no longer needs (owner, 2026-11-19): the app kept one
// record per person met — name, photo, car, the block they were shown in —
// until a reload, long after they'd left the map and their chat had ended.
// Now a record nothing points at goes after a quiet minute
// (forgetUnusedPeers; the minute is moved on here, not waited for).
// Ann chats with Bob; Bob goes offline — kept (the chat); the chat ends —
// kept through the quiet minute, then gone; Bob back online — known again.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

const known = (id) => `realPeersById.has(${id})`;
// a sweep "now", and one a minute on
const sweepNowAndLater = (p) =>
  p.eval(`(() => { const t = performance.now(); forgetUnusedPeers(t); forgetUnusedPeers(t + PEER_QUIET_MS); return true; })()`);

await journey("peerforget: someone off the map with no chat, ride or request is forgotten after a quiet minute", async (browser) => {
  step("Bob drives; Ann sees him and they chat");
  const bob = await browser.person("PF-Bob");
  const ann = await browser.person("PF-Ann");
  const bobId = await bob.id();
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");
  // on the map, nothing else (no chat, nothing open): the map alone keeps him
  await ann.eval(`(state.chatPeer = null, state.cardPeer = null, true)`);
  await sweepNowAndLater(ann);
  check(await ann.eval(known(bobId)), "on the map, no chat: kept (the map alone)");
  await openChatWith(ann, bobId);
  await typeText(ann, "hi Bob");
  await send(ann);
  await ann.waitFor(`chats.get(realPeersById.get(${bobId})).msgs.some((m) => m.id != null)`, "sent");

  step("an unread count from the server never past what a chat keeps (20)");
  const unread = await ann.eval(`(() => {
    const c = chats.get(realPeersById.get(${bobId}));
    const saved = { loaded: c.loaded, rest: c.restUnread, server: c.server, unread: c.unread };
    c.server = true; // (a chat the server has, as a reload brings it)
    c.loaded = false;
    c.restUnread = 30;
    applyReadState();
    const n = c.unread;
    c.loaded = saved.loaded;
    c.restUnread = saved.rest;
    c.server = saved.server;
    c.unread = saved.unread;
    applyReadState();
    return n;
  })()`);
  check(unread === 20, "30 counted by the server: 20 shown", unread);

  step("on the map with a chat: kept, however long");
  await sweepNowAndLater(ann);
  check(await ann.eval(known(bobId)), "kept while on the map");

  step("Bob goes offline: off Ann's map — still kept (their chat)");
  await bob.click("btn-online");
  await bob.waitFor("!state.online", "Bob offline");
  await ann.waitFor(`!realEntries.has(${bobId})`, "Bob's car off Ann's map", 10000);
  // (the chat window closed, and its "last chat" pointer moved on — as
  // after opening someone else's: only the chat itself, in the list,
  // keeps him)
  await ann.eval(`(closeChat(), closePeerCard(), state.chatPeer = null, true)`);
  check(await ann.eval(`state.chatPeer === null && state.cardPeer === null`), "nothing open");
  await sweepNowAndLater(ann);
  check(await ann.eval(known(bobId)), "kept: the chat is still there");
  await ann.eval(`(openChat(realPeersById.get(${bobId})), true)`);
  await ann.waitFor(`state.chatPeer && state.chatPeer.id === ${bobId}`, "the chat open again");

  step("Ann ends the chat: nothing points at Bob — kept through the quiet minute, then gone");
  await ann.click("chat-end");
  await ann.click("chat-end");
  await ann.waitFor(`!chats.has(realPeersById.get(${bobId}))`, "the chat ended");
  await ann.eval(`(closeChat(), closePeerCard && closePeerCard(), true)`);
  await ann.eval(`(window.__t0 = performance.now(), forgetUnusedPeers(window.__t0), true)`);
  check(await ann.eval(known(bobId)), "not at once: a reply on its way still finds him");
  // mentioned again meanwhile (news about him): his quiet minute starts over
  await ann.eval(`(ensurePeer({ id: ${bobId} }), forgetUnusedPeers(window.__t0 + PEER_QUIET_MS), true)`);
  check(await ann.eval(known(bobId)), "mentioned again: the quiet minute starts over");
  await ann.eval(`(forgetUnusedPeers(window.__t0 + 2 * PEER_QUIET_MS + 1), true)`);
  check(!(await ann.eval(known(bobId))), "forgotten after the quiet minute");

  step("Bob back online: known again, on Ann's map");
  await bob.click("btn-online");
  await bob.waitFor("state.online", "Bob online again");
  await sees(ann, bobId, "(back)");
});
