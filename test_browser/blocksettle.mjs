// A Block whose answers are BOTH lost, the block never saved (cross-feature
// review round 11, 2026-11-25): asked over the web, the server says no —
// "Couldn't block — try again", and nothing about that person stays
// "being blocked": when they end the chat later, it's said ("… ended the
// chat"), not hidden. And an Unblock clears what a lost block left.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

await journey("blocksettle: a Block that never reached the server — settled as failed, nothing left 'being blocked'", async (browser) => {
  step("Ann and Bob chat; Ann blocks Bob — neither push reaches the server, both time out");
  const ann = await browser.person("BT-SetAnn");
  const bob = await browser.person("BT-SetBob", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(bob);
  const [bobId, annId] = [await bob.id(), await ann.id()];
  await sees(ann, bobId, "(Bob's car)");
  await openChatWith(ann, bobId);
  await ann.eval(`(() => {
    window.__sheetSaid = [];
    window.__banners = [];
    const er = document.getElementById("block-error");
    new MutationObserver(() => er.textContent && window.__sheetSaid.push(er.textContent)).observe(er, { childList: true, characterData: true, subtree: true });
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    return true;
  })()`);
  // (a message, so the server has their chat)
  await typeText(ann, "hi Bob");
  await send(ann);
  await ann.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.mine && m.id != null)`, "sent");
  await ann.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    let n = 0;
    userChannel.push = (ev, payload, t) => {
      if (ev !== "block") return orig(ev, payload, t);
      if (++n === 2) userChannel.push = orig;
      // (never sent: the line dead for it — its timeout after 300 ms)
      const lost = { receive: (st, cb) => (st === "timeout" && setTimeout(cb, 300), lost) };
      return lost;
    };
    return true;
  })()`);
  await ann.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Bob's chat");
  await ann.click("chat-block");
  await ann.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await ann.click("block-yes");
  await ann.waitFor(`window.__sheetSaid.some((t) => t.includes("Checking"))`, "checking", 10000);
  // (the line proved: the retry goes — and is lost too)
  await ann.eval(`(socket.pendingHeartbeatRef = socket.makeRef(), socket.heartbeatTimeout(), true)`);

  step("settled (the server asked): not blocked — 'Couldn't block — try again'; not 'being blocked'");
  await ann.waitFor(`window.__sheetSaid.some((t) => t.includes("Couldn't block")) || window.__banners.some((t) => t.includes("Couldn't block"))`, "Couldn't block (settled: not blocked)", 90000);
  check((await ann.eval(`!!realPeersById.get(${bobId}).blocking`)) === false, "not 'being blocked' any more");

  step("Bob ends their chat: Ann is told");
  await ann.eval(`(closeBlockSheet(), true)`);
  await bob.eval(`(openChat(realPeersById.get(${annId})), true)`);
  await bob.waitFor(`!document.getElementById("chat-end").classList.contains("hidden")`, "End chat");
  await bob.click("chat-end");
  await bob.click("chat-end");
  await ann.waitFor(`window.__banners.some((t) => t.includes("ended the chat"))`, "Ann told: Bob ended the chat", 10000);
  check(ann.errors.length === 0, "no page errors", ann.errors);
});
