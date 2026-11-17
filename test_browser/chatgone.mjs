// A chat found gone after a reconnect (owner, 2026-11-15). Ann has her chat
// with Bob open; she drops off; meanwhile the chat ends (here: as the
// cleanup ends one). When she's back, the reconnect can't know why it went
// — so it says neither "away" nor "ended it": "Chat with BT-GoneBob ended",
// and the chat closes. Before, it reopened EMPTY, with no word.
import { journey, step, check, server } from "./cdp.mjs";
import { openChatWith, typeText, send, dropAndWait, restoreAndWait, goOnline, sees } from "./app.mjs";

await journey("chatgone: a chat gone while you were away — closed on your return, with a neutral line", async (browser) => {
  step("Ann and Bob chat; Ann has it open");
  const bob = await browser.person("BT-GoneBob");
  const ann = await browser.person("BT-GoneAnn");
  const [bobId, annId] = [await bob.id(), await ann.id()];
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");
  await openChatWith(ann, bobId);
  await typeText(ann, "see you soon");
  await send(ann);
  await ann.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.id != null)`, "sent");

  step("Ann drops off; meanwhile their chat ends");
  await dropAndWait(ann);
  await server(`close_chat ${annId} ${bobId}`);

  step("back: the chat closes, with 'Chat with BT-GoneBob ended' — not an empty chat");
  await restoreAndWait(ann);
  await ann.waitFor(`document.getElementById("chat").classList.contains("hidden")`, "the chat closed", 10000);
  await ann.waitFor(`document.getElementById("banner").textContent === "Chat with BT-GoneBob ended"`, "the neutral line");
  check(!(await ann.eval(`chats.has(realPeersById.get(${bobId}))`)), "no chat with Bob left");
});
