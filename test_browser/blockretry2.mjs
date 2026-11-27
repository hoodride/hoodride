// The block sheet's retry, round 6 (cross-feature review, 2026-11-25):
// 1. the phone asleep through "Checking…" (its timers stopped, the wall
//    clock not): on waking, no "Couldn't block" for a block that went
//    through — the retry waits for the connection, not a clock;
// 2. the newest wish wins: a Block whose answer was lost, then an Unblock —
//    the Block's retry must not block them again.
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

const watchSheet = (p) =>
  p.eval(`(() => {
    window.__sheetSaid = [];
    window.__banners = [];
    const er = document.getElementById("block-error");
    new MutationObserver(() => er.textContent && window.__sheetSaid.push(er.textContent)).observe(er, { childList: true, characterData: true, subtree: true });
    const tb = transientBanner;
    window.transientBanner = function (text) { window.__banners.push(String(text)); return tb.apply(this, arguments); };
    return true;
  })()`);
const blockFromChat = async (p, id) => {
  await openChatWith(p, id);
  await p.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in the chat");
  await p.click("chat-block");
  await p.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await p.click("block-yes");
};
const blockedIds = (p) => p.eval(`apiFetch("/api/blocks").then((r) => r.json()).then((b) => (b.blocked || b.people || b.items || []).map((x) => x.id))`);

await journey("blockretry2: asleep through 'Checking…' — no false failure; a Block's retry never undoes a newer Unblock", async (browser) => {
  step("Sia blocks Dax — the frame reaches the server, the line dies silently; 'Checking…'; her phone sleeps 95 s (the wall clock on, timers stopped)");
  const sia = await browser.person("BT-SleepSia");
  const dax = await browser.person("BT-SleepDax", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dax);
  const daxId = await dax.id();
  await sees(sia, daxId, "(Dax's car)");
  await watchSheet(sia);
  await sia.eval(`(() => {
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
  await blockFromChat(sia, daxId);
  await sia.waitFor(`window.__sheetSaid.some((t) => t.includes("Checking"))`, "the sheet: checking", 10000);
  // (asleep 95 s: the wall clock moved on; the overdue timers fire now)
  await sia.eval(`(() => { const r = Date.now.bind(Date); Date.now = () => r() + 95_000; return true; })()`);
  await new Promise((r) => setTimeout(r, 1500));

  step("awake: still checking — never 'Couldn't block'; the dead line replaced: Blocked");
  const woke = await sia.eval(`window.__sheetSaid`);
  check(!woke.some((t) => t.includes("Couldn't block")), "no 'Couldn't block' on waking", woke);
  await sia.eval(`(socket.pendingHeartbeatRef = socket.makeRef(), socket.heartbeatTimeout(), true)`);
  await sia.waitFor(`window.__banners.some((t) => t.startsWith("Blocked."))`, "Blocked.", 20000);
  await sia.eval(`(window.__dead && window.__dead.close && window.__dead.close(), true)`);

  step("Ula blocks Dax — its answer lost on a quiet line (no heartbeat for now); she unblocks him at once: the Block's retry doesn't block him again");
  const ula = await browser.person("BT-SleepUla");
  await sees(ula, daxId, "(Dax's car, for Ula)");
  await watchSheet(ula);
  await ula.eval(`(() => {
    // (no heartbeats for now: nothing proves the line but the Unblock's own answer)
    clearTimeout(socket.heartbeatTimer);
    const orig = userChannel.push.bind(userChannel);
    userChannel.push = (ev, payload, t) => {
      const real = orig(ev, payload, t);
      if (ev !== "block") return real;
      userChannel.push = orig;
      const lost = { receive: (st, cb) => (st === "timeout" && setTimeout(cb, 300), lost) };
      return lost;
    };
    return true;
  })()`);
  await blockFromChat(ula, daxId);
  await ula.waitFor(`window.__sheetSaid.some((t) => t.includes("Checking"))`, "the sheet: checking", 10000);
  await ula.eval(`(!document.getElementById("block-sheet").classList.contains("hidden") && document.getElementById("block-cancel").click(), true)`);
  await ula.click("btn-account");
  await ula.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "the drawer open");
  await ula.click("btn-blocked");
  await ula.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length === 1`, "the list: Dax");
  await ula.eval(`document.querySelector("#blocked-list .blocked-row button").click(), true`);
  await ula.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked");
  await ula.click("block-yes");
  await ula.waitFor(`document.querySelector("#blocked-list .blocked-empty")`, "unblocked", 10000);
  await new Promise((r) => setTimeout(r, 2500));
  const still = await blockedIds(ula);
  check(Array.isArray(still) && !still.includes(daxId), "Dax not blocked again (the newest wish: unblock)", still);
  check(sia.errors.length === 0 && ula.errors.length === 0, "no page errors", [sia.errors, ula.errors]);
});
