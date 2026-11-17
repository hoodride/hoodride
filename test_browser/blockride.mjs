// Block mid-ride (owner, 2026-11-15): from the ride partner's chat —
// Block beside End chat is there in a ride too (End chat isn't). Asked
// first; the ride ends for both, and neither sees the other after.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith, DRAWN } from "./app.mjs";

await journey("blockride: blocking your ride partner ends the ride for both", async (browser) => {
  step("Ann asks Bob for a ride; he accepts");
  const bob = await browser.person("BT-RideBob");
  const ann = await browser.person("BT-RideAnn");
  const [bobId, annId] = [await bob.id(), await ann.id()];
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");
  await openChatWith(ann, bobId);
  await ann.click("btn-ride-action");
  await bob.waitFor(`realPeersById.get(${annId}) && realPeersById.get(${annId}).pending === true`, "Bob has the request");
  await bob.eval(`(openChat(realPeersById.get(${annId})), true)`);
  await bob.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await bob.click("btn-ride-action");
  await ann.waitFor(`state.ride && state.ride.status === "connected"`, "Ann's ride started", 15000);
  await bob.waitFor(`state.ride && state.ride.status === "connected"`, "Bob's ride started", 15000);

  step("mid-ride, in their chat: Block shows (End chat doesn't); Ann blocks Bob");
  await ann.eval(`(openChat(state.ride.peer), true)`);
  await ann.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in the ride's chat");
  check(await ann.eval(`document.getElementById("chat-end").classList.contains("hidden")`), "End chat isn't (a ride's chat ends with the ride)");
  await ann.click("chat-block");
  await ann.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await ann.click("block-yes");

  step("the ride ends for both; neither sees the other");
  await ann.waitFor(`!state.ride`, "Ann's ride over", 10000);
  await bob.waitFor(`!state.ride`, "Bob's ride over", 10000);
  await ann.waitFor(`!(${DRAWN(bobId)})`, "Bob's car not on Ann's map", 5000);
  check(!(await bob.eval(`chats.has(realPeersById.get(${annId}))`)), "Bob: no chat with Ann");
});
