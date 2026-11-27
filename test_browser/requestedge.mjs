// The request note's remaining edges (reviews, 2026-11-24; proven to fail
// without their fixes, 2026-11-25):
// (a withdrawn request's line: at the bottom, as it happens — owner,
// 2026-11-25)
// 1. a request from a rider whose chat is on an OLDER page: its note comes
//    back first, alone; when that page arrives with a message newer than
//    the request, the list shows that message — not the note — and sorts
//    by it;
// 2. "seen" is the NOTE seen: reading her earlier messages on a small
//    screen, the note below the fold, doesn't mark the request seen.
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

const gap = () => new Promise((r) => setTimeout(r, 2200));

await journey("requestedge: an older page's newer message beats the note; reading earlier messages isn't seeing the request", async (browser) => {
  step("Drew (driver, 35 older chats); Xan writes, asks, writes again — then her chat made older than them all");
  const drew = await browser.person("BT-EdgeDrew", { latitude: HOME.latitude + 0.003, longitude: HOME.longitude });
  await goOnline(drew);
  const drewId = await drew.id();
  await server(`chat_crowd 35 ${drewId}`);
  const say = async (p, text) => {
    await typeText(p, text);
    await send(p);
    await p.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.mine && m.id != null && m.text === ${JSON.stringify(text)})`, `${p.name}: sent`);
    await gap();
  };
  const ask = async (p) => {
    await p.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, `${p.name}: Request ride`);
    await p.click("btn-ride-action");
    await p.waitFor(`state.ride && state.ride.status === "requested"`, `${p.name}: requested`);
    await gap();
  };
  const xan = await browser.person("BT-EdgeXan");
  const xanId = await xan.id();
  await sees(xan, drewId, "(Drew's car)");
  await openChatWith(xan, drewId);
  await say(xan, "x1");
  await ask(xan);
  await say(xan, "x2 newer");
  await server(`chat_age ${xanId} ${drewId} 100000`);

  step("Drew reloads: Xan's chat is past the first page — the note alone; her page comes: the list shows her newer message");
  await drew.eval(`(softReload(), true)`);
  await drew.waitFor(`hydrated && !reloading && !!chatsMore && chats.has(realPeersById.get(${xanId}))`, "back; Xan's note here, her page to come", 10000);
  for (let i = 0; i < 4 && (await drew.eval(`!!chatsMore && !(chats.get(realPeersById.get(${xanId})).summary || {}).last`)); i++) {
    await drew.eval(`(loadOlderChats(), true)`);
    await drew.waitFor(`!olderLoading`, "a page in", 10000);
  }
  const line = await drew.eval(`HoodChatList.preview(chats.get(realPeersById.get(${xanId}))).text`);
  check(line === "x2 newer", "the list's line: her newer message, not the note", line);

  step("Zed writes, asks, writes again; Drew reloads (her chat a summary, the note behind); Zed cancels: the withdrawn line is the newest — the list shows it, the chat moves up; opened, it's at the bottom");
  const zed = await browser.person("BT-EdgeZed");
  const zedId = await zed.id();
  await sees(zed, drewId, "(Drew's car)");
  await openChatWith(zed, drewId);
  await say(zed, "z1");
  await ask(zed);
  await say(zed, "z2 newer");
  await drew.eval(`(closeChat(), softReload(), true)`);
  await drew.waitFor(`hydrated && !reloading && chats.has(realPeersById.get(${zedId})) && chats.get(realPeersById.get(${zedId})).loaded === false`, "back; Zed's chat a summary", 10000);
  const before = await drew.eval(`(() => { const c = chats.get(realPeersById.get(${zedId})); return { line: HoodChatList.preview(c).text, lastAt: c.lastAt }; })()`);
  check(before.line === "z2 newer", "before: her newer message", before);
  await zed.click("btn-endride");
  await zed.waitFor(`!state.ride`, "Zed: cancelled");
  await drew.waitFor(`chats.get(realPeersById.get(${zedId})).msgs.some((m) => String(m.text).includes("withdrawn"))`, "Drew: the withdrawn line");
  const after = await drew.eval(`(() => { const c = chats.get(realPeersById.get(${zedId})); return { line: HoodChatList.preview(c).text, lastAt: c.lastAt }; })()`);
  check(after.line === "(request withdrawn)" && after.lastAt > before.lastAt, "after the cancel: the withdrawn line, the chat's time now (owner, 2026-11-25: at the bottom)", { before, after });
  await drew.eval(`(openChat(realPeersById.get(${zedId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${zedId})).loaded !== false`, "Zed's chat opened", 10000);
  const opened = await drew.eval(`(() => { const c = chats.get(realPeersById.get(${zedId})); return { texts: c.msgs.map((m) => String(m.text).includes("requested") ? "note" : m.text).slice(-4), line: HoodChatList.preview(c).text }; })()`);
  check(opened.texts.join(",") === "z1,note,z2 newer,(request withdrawn)" && opened.line === "(request withdrawn)", "opened: z1, the note, z2, withdrawn at the bottom — the list's line unchanged", opened);
  await drew.eval(`(closeChat(), true)`);

  step("Wes writes six long messages, then asks; Drew, on a small phone, reads the first ones — the note below the fold: not 'seen'");
  const wes = await browser.person("BT-EdgeWes");
  const wesId = await wes.id();
  await sees(wes, drewId, "(Drew's car)");
  await openChatWith(wes, drewId);
  const long = "a message";
  for (let k = 1; k <= 6; k++) {
    await typeText(wes, `${k} ${long}`);
    await send(wes);
    await wes.waitFor(`chats.get(state.chatPeer).msgs.filter((m) => m.mine && m.id != null).length === ${k}`, `Wes: ${k} sent`);
  }
  await ask(wes);
  await drew.waitFor(`realPeersById.has(${wesId}) && realPeersById.get(${wesId}).pending === true`, "Drew has Wes's request");
  await drew.phone(360, 640);
  await drew.eval(`(closeChat(), openChat(realPeersById.get(${wesId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${wesId})).loaded !== false`, "Wes's chat open", 10000);
  // (some of his messages read — on screen a while)
  await drew.waitFor(`chats.get(realPeersById.get(${wesId})).unread < 7`, "some read", 10000);
  await new Promise((r) => setTimeout(r, 1500));
  const s = await drew.eval(`({ unread: chats.get(realPeersById.get(${wesId})).unread, seen: seenReqOf(${wesId}), req: realPeersById.get(${wesId}).pendingReq })`);
  check(s.unread > 0 && s.seen !== s.req, "the note not seen (still unread below), the request not marked seen", s);
  check(drew.errors.length === 0, "no page errors", drew.errors);
});
