// The block sheet's retry (cross-feature review round 5, 2026-11-25):
// 1. a Block whose answer is lost on a connection that died SILENTLY (it
//    still reads open): the server is asked over the web — never
//    "Couldn't block" for a block that went through (a resend into the dead
//    line timed out too: removed, owner 2026-11-26);
// 2. the sheet reopened for the same person while the answer is checked:
//    the check's success closes it — it said "Couldn't unblock" forever.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

await journey("blockretry: a lost Block answer on a dead connection waits for a live one; a sheet reopened mid-retry still ends right", async (browser) => {
  step("Rae blocks Don — the frame reaches the server, then the connection dies silently (still 'open')");
  const rae = await browser.person("BT-RetryRae");
  const don = await browser.person("BT-RetryDon", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(don);
  const donId = await don.id();
  await sees(rae, donId, "(Don's car)");
  await openChatWith(rae, donId);
  // (a message: a real chat — her only one)
  await typeText(rae, "hi Don");
  await send(rae);
  await rae.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.mine && m.id != null)`, "sent");
  await rae.eval(`(() => {
    window.__sheetSaid = [];
    window.__banners = [];
    const er = document.getElementById("block-error");
    new MutationObserver(() => er.textContent && window.__sheetSaid.push(er.textContent)).observe(er, { childList: true, characterData: true, subtree: true });
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      if (ev !== "block") return orig(ev, payload, t);
      userChannel.push = orig;
      // (sent, then the line goes dead: nothing out, nothing in; a short
      // timeout — the test's, not Phoenix's 10 s)
      const real = orig(ev, payload, 1000);
      const tr = socket.conn;
      window.__dead = tr;
      tr.send = () => {};
      tr.onmessage = () => {};
      return real;
    };
    return true;
  })()`);
  await rae.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Don's chat");
  await rae.click("chat-block");
  await rae.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await rae.click("block-yes");
  await rae.waitFor(`window.__sheetSaid.some((t) => t.includes("Checking"))`, "the sheet: checking", 10000);
  // (the timeout's reload: her only chat gone — the panel closed, not an
  // empty "Chats" list, as a block's own answer leaves it: round 12)
  await rae.waitFor(`hydrated && !reloading && !chats.has(realPeersById.get(${donId}))`, "reloaded: the chat gone", 10000);
  check(await rae.eval(`document.getElementById("chat").classList.contains("hidden")`), "her only chat gone: the panel closed, not an empty list");

  step("12 s on, the dead line not yet noticed: still checking — never 'Couldn't block'; the server asked over the web: Blocked");
  await new Promise((r) => setTimeout(r, 12000));
  const mid = await rae.eval(`({ sheet: window.__sheetSaid, banners: window.__banners })`);
  check(!mid.sheet.some((t) => t.includes("Couldn't block")) && !mid.banners.some((t) => t.includes("Couldn't block")), "no 'Couldn't block' while the line is dead", mid);
  // (the heartbeat's timeout, as Phoenix would hit it: the dead line replaced)
  await rae.eval(`(socket.pendingHeartbeatRef = socket.makeRef(), socket.heartbeatTimeout(), true)`);
  await rae.waitFor(`window.__banners.some((t) => t.startsWith("Blocked."))`, "Blocked.", 20000);
  const after = await rae.eval(`window.__sheetSaid`);
  check(!after.some((t) => t.includes("Couldn't block")), "never 'Couldn't block'", after);
  await rae.eval(`(window.__dead && window.__dead.close && window.__dead.close(), true)`);

  step("Rae unblocks Don — the answer lost; she cancels the sheet and reopens it; the server asked: unblocked — the reopened sheet closes, never 'Couldn't unblock'");
  await rae.waitFor(`liveNow()`, "connected");
  await rae.eval(`(() => {
    window.__sheetSaid = [];
    const orig = userChannel.push.bind(userChannel);
    window.__timeout = null;
    userChannel.push = (ev, payload, t) => {
      if (ev !== "unblock") return orig(ev, payload, t);
      userChannel.push = orig;
      // sent for real; its answer lost — its timeout when the test says
      orig(ev, payload, t);
      const lost = { receive: (st, cb) => (st === "timeout" && (window.__timeout = cb), lost) };
      return lost;
    };
    return true;
  })()`);
  await rae.click("btn-account");
  await rae.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "the drawer open");
  await rae.click("btn-blocked");
  await rae.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length === 1`, "the list: Don");
  await rae.eval(`document.querySelector("#blocked-list .blocked-row button").click(), true`);
  await rae.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked");
  await rae.click("block-yes");
  await rae.waitFor(`!!window.__timeout`, "sent");
  await rae.click("block-cancel");
  await rae.eval(`document.querySelector("#blocked-list .blocked-row button").click(), true`);
  await rae.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked again");
  await rae.eval(`(window.__timeout(), true)`);
  await rae.waitFor(`document.getElementById("block-sheet").classList.contains("hidden")`, "the reopened sheet closed: done", 10000).catch(async (e) => {
    check(false, "the reopened sheet closed when the server said unblocked", await rae.eval(`window.__sheetSaid`));
    throw e;
  });
  check(!(await rae.eval(`window.__sheetSaid`)).some((t) => t.includes("Couldn't unblock")), "never 'Couldn't unblock'", await rae.eval(`window.__sheetSaid`));
  check(rae.errors.length === 0, "no page errors", rae.errors);
});
