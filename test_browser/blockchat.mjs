// A block and the chats it ends (owner, 2026-11-20: "when you block someone
// or someone blocks you, does your chat with them disappear? … is it well
// tested?"). block.mjs checks the chat is gone for both and the blocked one
// told plainly; here, what that left unproven — on the BLOCKED one's side:
//   - the chat OPEN on their screen at that moment: it closes, nothing left
//     to type into, the neutral line;
//   - their chats LIST: the blocked chat gone from it, the others kept;
//   - away (no connection) when it happened: gone when they're back, with
//     the neutral line — never an empty chat reopened;
//   - unblocked: a new chat starts empty — nothing of the old one.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send, textsFrom, dropAndWait, restoreAndWait, chatOpenWith } from "./app.mjs";

// a block or unblock, as the app sends it (the blocker's own side is block.mjs's)
const push = (p, event, peer) =>
  p.eval(`new Promise((ok) => userChannel.push(${JSON.stringify(event)}, { peer: ${peer} }).receive("ok", () => ok("ok")).receive("error", (e) => ok(e.reason)).receive("timeout", () => ok("timeout")))`);
// the names in the chats list, as drawn
const listed = (p) => p.eval(`[...document.querySelectorAll("#chat-messages .chat-item strong")].map((s) => s.textContent)`);

await journey("blockchat: a block, on the blocked one's side — an open chat, the list, away meanwhile, and unblocked", async (browser) => {
  step("Bob drives; Ann, Cat and Dee each chat with him");
  const bob = await browser.person("BT-BcBob");
  const ann = await browser.person("BT-BcAnn");
  const cat = await browser.person("BT-BcCat");
  const dee = await browser.person("BT-BcDee");
  const [bobId, annId, catId, deeId] = [await bob.id(), await ann.id(), await cat.id(), await dee.id()];
  await goOnline(bob);
  for (const [p, text] of [
    [ann, "hi Bob, it's Ann"],
    [cat, "hi Bob, it's Cat"],
    [dee, "hi Bob, it's Dee"],
  ]) {
    await sees(p, bobId, "(his car)");
    await openChatWith(p, bobId);
    await typeText(p, text);
    await send(p);
    await p.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.id != null)`, `${p.name}: sent`);
    await p.eval(`closeChat(), true`);
  }
  await bob.waitFor(`[${annId}, ${catId}, ${deeId}].every((id) => chats.has(realPeersById.get(id)))`, "Bob has all three chats", 15000);

  step("Bob has Ann's chat OPEN; Ann blocks him: it closes — nothing left to type into — with 'Chat with BT-BcAnn ended'");
  await bob.eval(`openChat(realPeersById.get(${annId})), true`);
  await bob.waitFor(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${annId}`, "Ann's chat open on Bob's screen");
  check((await push(ann, "block", bobId)) === "ok", "Ann blocked Bob");
  await bob.waitFor(`!chats.has(realPeersById.get(${annId}))`, "Bob: the chat gone", 10000);
  check((await chatOpenWith(bob)) !== annId, "Ann's chat not open", await chatOpenWith(bob));
  await bob.waitFor(`document.getElementById("banner").textContent === "Chat with BT-BcAnn ended"`, "Bob: the neutral line");
  // nothing of it to type into: the composer isn't Ann's
  check(!(await bob.eval(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${annId}`)), "no composer for Ann");

  step("Bob's chats list: Cat's and Dee's chats there, Ann's not");
  await bob.eval(`openChatList(), true`);
  await bob.waitFor(`state.chatView === "list" && document.querySelectorAll("#chat-messages .chat-item").length > 0`, "the list drawn");
  const names = await listed(bob);
  check(names.includes("BT-BcCat") && names.includes("BT-BcDee") && !names.includes("BT-BcAnn"), "Cat and Dee listed, Ann not", names);
  await bob.eval(`closeChat(), true`);

  step("Bob away (no connection) with Cat's chat open; Cat blocks him meanwhile");
  await bob.eval(`openChat(realPeersById.get(${catId})), true`);
  await bob.waitFor(`state.chatPeer && state.chatPeer.id === ${catId} && !document.getElementById("chat").classList.contains("hidden")`, "Cat's chat open on Bob's screen");
  await dropAndWait(bob);
  check((await push(cat, "block", bobId)) === "ok", "Cat blocked Bob");

  step("…back: Cat's chat closed with 'Chat with BT-BcCat ended' — never reopened empty; only Dee's left (one chat: the list opens it)");
  await restoreAndWait(bob);
  await bob.waitFor(`!chats.has(realPeersById.get(${catId}))`, "Bob: Cat's chat gone", 10000);
  check((await chatOpenWith(bob)) !== catId, "Cat's chat not open", await chatOpenWith(bob));
  await bob.waitFor(`document.getElementById("banner").textContent === "Chat with BT-BcCat ended"`, "Bob: the neutral line");
  check(await bob.eval(`chats.size === 1 && chats.has(realPeersById.get(${deeId}))`), "only Dee's chat left", await bob.eval(`[...chats.keys()].map((p) => p.name)`));
  await bob.eval(`openChatList(), true`);
  await bob.waitFor(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${deeId}`, "the list opens the one left: Dee's");
  await bob.eval(`closeChat(), true`);

  step("Ann unblocks Bob: a new chat starts EMPTY on both sides — nothing of the old one");
  check((await push(ann, "unblock", bobId)) === "ok", "Ann unblocked Bob");
  await sees(ann, bobId, "(his car, back)");
  await openChatWith(ann, bobId);
  check((await ann.eval(`chats.get(state.chatPeer).msgs.length`)) === 0, "Ann's new chat with Bob: empty", await ann.eval(`chats.get(state.chatPeer).msgs.map((m) => m.text)`));
  await typeText(ann, "hello again");
  await send(ann);
  await bob.waitFor(`chats.has(realPeersById.get(${annId}))`, "Bob has the new chat", 15000);
  const bobSees = await textsFrom(bob, annId);
  check(bobSees.length === 1 && bobSees[0] === "hello again", "Bob's new chat: only the new message", bobSees);
  // (review of this journey) from the SERVER too, not only the apps'
  // memory: both reconnect — the chat rebuilt from what it keeps — and it
  // holds only the new message
  for (const [p, otherId] of [
    [bob, annId],
    [ann, bobId],
  ]) {
    await dropAndWait(p);
    await restoreAndWait(p);
    const kept = await textsFrom(p, otherId);
    check(kept.length === 1 && kept[0] === "hello again", `${p.name}: the server's copy — only the new message`, kept);
  }
  check([bob, ann, cat, dee].every((p) => p.errors.length === 0), "no page errors", [...bob.errors, ...ann.errors, ...cat.errors, ...dee.errors]);
});
