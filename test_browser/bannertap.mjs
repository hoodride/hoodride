// A message's banner opens that chat when tapped (owner, 2026-11-17):
// "💬 BT-TapRita: hi" tapped while it shows → the chat with Rita. Nothing if
// that chat has gone meanwhile; no other banner opens anything.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send, bannerIs } from "./app.mjs";

const chatOpen = `!document.getElementById("chat").classList.contains("hidden")`;

await journey("bannertap: a message's banner opens that chat; nothing if the chat's gone; other banners open nothing", async (browser) => {
  step("Dan drives; Rita messages him while his chat is closed: the banner");
  const dan = await browser.person("BT-TapDan");
  const rita = await browser.person("BT-TapRita");
  const danId = await dan.id();
  const ritaId = await rita.id();
  await goOnline(dan);
  await sees(rita, danId);
  await openChatWith(rita, danId);
  await typeText(rita, "hi");
  await send(rita);
  await bannerIs(dan, "💬 BT-TapRita: hi");
  check(!(await dan.eval(chatOpen)), "Dan's chat closed");

  step("Dan taps the banner: the chat with Rita opens");
  await dan.click("banner");
  await dan.waitFor(`${chatOpen} && state.chatPeer && state.chatPeer.id === ${ritaId}`, "the chat with Rita open");

  step("he closes it; another message; the chat goes before he taps: nothing opens");
  await dan.eval(`closeChat(), true`);
  await typeText(rita, "still there?");
  await send(rita);
  await bannerIs(dan, "💬 BT-TapRita: still there?");
  await dan.eval(`chats.delete(realPeersById.get(${ritaId})), true`);
  await dan.click("banner");
  check(!(await dan.eval(chatOpen)), "nothing opened");

  step("any other banner: a tap opens nothing");
  await dan.eval(`transientBanner("Something else"), true`);
  await dan.click("banner");
  check(!(await dan.eval(chatOpen)), "nothing opened");
  check(!(await dan.eval(`document.getElementById("banner").classList.contains("tappable")`)), "not shown as tappable");
});
