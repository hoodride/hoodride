// End chat and the open-chat limit (owner, 2026-11-12). Either person ends
// a chat: tap twice (the first tap asks "Tap again to end" for 3 s), gone
// for both, the other told "{name} ended the chat". At most 10 open chats
// you started: the next is refused, "end one to start another". Never with
// your ride partner while the ride lasts.
import { journey, step, check, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send, bannerIs } from "./app.mjs";

const endShown = `!document.getElementById("chat-end").classList.contains("hidden")`;
const endText = `document.getElementById("chat-end").textContent`;
const hasChatWith = (id) => `chats.has(realPeersById.get(${id}))`;

await journey("endchat: tap twice to end — gone for both, the other told; 10 chats you started at most; not with your ride partner", async (browser) => {
  step("Dan drives; Rita sees his car and messages him: End chat shows");
  const dan = await browser.person("BT-Dan");
  const rita = await browser.person("BT-Rita");
  const danId = await dan.id();
  const ritaId = await rita.id();
  await goOnline(dan);
  await sees(rita, danId);
  await openChatWith(rita, danId);
  await typeText(rita, "hi Dan");
  await send(rita);
  await rita.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.id != null)`, "delivered");
  await dan.waitFor(hasChatWith(ritaId), "Dan has the chat");
  await rita.waitFor(endShown, "End chat shown");
  check((await rita.eval(endText)) === "End chat", "it says End chat");

  step("one tap: 'Tap again to end' — left alone, back to End chat; nothing ended");
  await rita.click("chat-end");
  check((await rita.eval(endText)) === "Tap again to end", "the first tap asks again");
  await rita.waitFor(`${endText} === "End chat"`, "back to End chat after 3 s", 6000);
  check(await rita.eval(hasChatWith(danId)), "Rita's chat still there");
  check(await dan.eval(hasChatWith(ritaId)), "Dan's too");

  // (review, 2026-11-12: armed, closed, reopened within the 3 s — one tap
  // then ended it with no "Tap again" asked this time)
  step("one tap, the chat closed and reopened at once: asks again from the start");
  await rita.click("chat-end");
  check((await rita.eval(endText)) === "Tap again to end", "armed");
  await rita.eval(`closeChat(), true`);
  await rita.eval(`openChat(realPeersById.get(${danId})), true`);
  await rita.waitFor(endShown, "End chat shown again");
  check((await rita.eval(endText)) === "End chat", "not armed after closing");
  await rita.click("chat-end");
  check(await rita.eval(hasChatWith(danId)), "one tap after reopening ends nothing");
  await rita.waitFor(`${endText} === "End chat"`, "back to End chat after 3 s", 6000);

  step("two taps: gone for both — Dan told 'BT-Rita ended the chat'; Rita told nothing");
  await rita.click("chat-end");
  await rita.click("chat-end");
  await rita.waitFor(`!${hasChatWith(danId)}`, "gone for Rita");
  await dan.waitFor(`!${hasChatWith(ritaId)}`, "gone for Dan");
  await bannerIs(dan, "BT-Rita ended the chat");
  check(!(await rita.eval(`document.getElementById("banner").textContent.includes("ended")`)), "Rita isn't told she ended it");

  step("10 chats Rita started already: a new one is refused — end one to start another");
  await server(`chats_started 10 ${ritaId}`); // (throws if they weren't counted)
  await openChatWith(rita, danId);
  await typeText(rita, "hi again");
  await send(rita);
  await bannerIs(rita, "You've started too many chats — end one of them first");
  check(!(await dan.eval(hasChatWith(ritaId))), "nothing reached Dan");

  step("in a ride together: no End chat with your ride partner");
  await rita.eval(`closeChat(), true`);
  await server(`start_ride ${ritaId} ${danId}`);
  await rita.waitFor(`!!state.ride && state.ride.peer && state.ride.peer.id === ${danId}`, "Rita in the ride");
  await rita.eval(`openChat(state.ride.peer), true`);
  await rita.waitFor(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${danId}`, "the ride's chat open");
  check(!(await rita.eval(endShown)), "no End chat with the ride partner");
});
