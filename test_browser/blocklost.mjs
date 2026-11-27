// A Block whose answer is lost — the reload it runs says nothing of what
// the block itself ended (cross-feature review round 7, 2026-11-25):
// 1. blocking your ride partner: not "your ride ended unexpectedly, please
//    set it up again", and not "Chat with … ended" for the chat you were
//    in — your own block closes it quietly;
// 2. a Block tapped again (the first's answer late): the first timing out
//    doesn't clear "being blocked" while the second is still on its way.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

await journey("blocklost: a lost Block answer's reload says nothing of the ride or chat the block ended; a second Block keeps 'being blocked'", async (browser) => {
  step("Ann asks Bob; he accepts; in the ride's chat she blocks him — the frame reaches the server, the line dies silently");
  const bob = await browser.person("BT-LostBob");
  const ann = await browser.person("BT-LostAnn");
  const [bobId, annId] = [await bob.id(), await ann.id()];
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");
  await openChatWith(ann, bobId);
  await ann.click("btn-ride-action");
  await bob.waitFor(`realPeersById.get(${annId}) && realPeersById.get(${annId}).pending === true`, "Bob has the request");
  await bob.eval(`(openChat(realPeersById.get(${annId})), true)`);
  await bob.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride");
  await bob.click("btn-ride-action");
  const started = `state.ride && ["connected", "arrived"].includes(state.ride.status)`;
  await ann.waitFor(started, "Ann's ride started", 15000);
  await ann.eval(`(openChat(state.ride.peer), true)`);
  await ann.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in the ride's chat");
  await ann.eval(`(() => {
    // (every banner asked for — two in the same moment, the second replacing
    // the first, would show only the last on the page)
    window.__banners = [];
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "block") return orig(ev, payload, t);
      userChannel.push = orig;
      const real = orig(ev, payload, 1000);
      const tr = socket.conn;
      window.__dead = tr;
      tr.send = () => {};
      tr.onmessage = () => {};
      return real;
    };
    return true;
  })()`);
  await ann.click("chat-block");
  await ann.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await ann.click("block-yes");

  step("the timeout's reload (over HTTP): the ride and the chat gone — said as facts, never 'lost' or 'unexpectedly'");
  await ann.waitFor(`!state.ride && hydrated && !reloading`, "reloaded: the ride gone", 15000);
  await new Promise((r) => setTimeout(r, 500));
  const said = await ann.eval(`window.__banners`);
  // (said as facts — "Your ride ended", "Chat with … ended" — never a
  // reason it can't know: owner, 2026-11-26)
  check(!said.some((t) => /\blost\b|unexpectedly|please ask again/i.test(t)), "never a reason it can't know", said);
  // (her only chat: the panel closed — not an empty "Chats" list, as a
  // block's own answer leaves it: round 12)
  check(await ann.eval(`document.getElementById("chat").classList.contains("hidden")`), "her only chat gone: the panel closed, not an empty list");
  await ann.eval(`(socket.pendingHeartbeatRef = socket.makeRef(), socket.heartbeatTimeout(), true)`);
  await ann.waitFor(`window.__banners.some((t) => t.startsWith("Blocked."))`, "Blocked.", 20000);
  await ann.eval(`(window.__dead && window.__dead.close && window.__dead.close(), true)`);

  step("Ann blocks Cy, the answer slow; she cancels, reopens and blocks again; the first times out: still 'being blocked'");
  const cy = await browser.person("BT-LostCy", { latitude: HOME.latitude - 0.004, longitude: HOME.longitude });
  await goOnline(cy);
  const cyId = await cy.id();
  await ann.waitFor(`liveNow()`, "connected");
  await sees(ann, cyId, "(Cy's car)");
  await openChatWith(ann, cyId);
  await ann.eval(`(() => {
    const orig = userChannel.push.bind(userChannel);
    let n = 0;
    userChannel.push = (ev, payload, t) => {
      if (ev !== "block") return orig(ev, payload, t);
      n++;
      if (n === 1) {
        // the first: no answer — it times out (300 ms)
        const lost = { receive: (st, cb) => (st === "timeout" && setTimeout(cb, 300), lost) };
        return lost;
      }
      // the second: on its way (held)
      userChannel.push = orig;
      const held = { receive: () => held };
      return held;
    };
    return true;
  })()`);
  await ann.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Cy's chat");
  await ann.click("chat-block");
  await ann.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked");
  // (the first goes; at once cancelled, reopened, the second goes — before
  // the first's timeout)
  await ann.eval(`(() => {
    document.getElementById("block-yes").click();
    document.getElementById("block-cancel").click();
    document.getElementById("chat-block").click();
    document.getElementById("block-yes").click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  check((await ann.eval(`realPeersById.get(${cyId}).blocking`)) === true, "still 'being blocked' (the second Block on its way)");
  check(ann.errors.length === 0, "no page errors", ann.errors);
});
