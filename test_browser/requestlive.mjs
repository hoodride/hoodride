// The request note's live paths (split from requesttop, 2026-11-25 — one
// journey has 3 minutes): a request heard LIVE in a chat not loaded yet
// (older chat pages to come) goes right after the message before it; a
// note placed by id before a message whose time rounds earlier leaves the
// chat's time alone; a reply of the driver's own after a note means he
// passed it (seen on another phone: this one's seen mark gone).
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

const gap = () => new Promise((r) => setTimeout(r, 2200));

await journey("requestlive: a request note heard live — placed by its message, the chat's time kept, passed by the driver's own reply", async (browser) => {
  step("Drew (driver, online, 35 older chats: pages to come)");
  const drew = await browser.person("BT-LiveDrew", { latitude: HOME.latitude + 0.003, longitude: HOME.longitude });
  await goOnline(drew);
  const drewId = await drew.id();
  await server(`chat_crowd 35 ${drewId}`);
  await drew.eval(`(softReload(), true)`);
  await drew.waitFor(`hydrated && !reloading && !!chatsMore`, "older pages to come", 10000);
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

  step("Uma (new) asks, then writes — live, Drew's older pages not loaded: her chat opens with the note first, her message below it");
  const uma = await browser.person("BT-LiveUma");
  const umaId = await uma.id();
  await sees(uma, drewId, "(Drew's car)");
  await openChatWith(uma, drewId);
  await ask(uma);
  await drew.waitFor(`realPeersById.has(${umaId}) && chats.has(realPeersById.get(${umaId})) && chats.get(realPeersById.get(${umaId})).loaded === false`, "her chat here, not loaded (older pages to come)");
  await say(uma, "on the corner");
  await drew.waitFor(`chats.get(realPeersById.get(${umaId})).msgs.some((m) => m.text === "on the corner")`, "her message held");
  await drew.eval(`(closeChat(), openChat(realPeersById.get(${umaId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${umaId})).loaded !== false`, "her chat loaded", 10000);
  const umaTexts = await drew.eval(`chats.get(realPeersById.get(${umaId})).msgs.map((m) => m.text)`);
  check(umaTexts.length === 2 && umaTexts[0].includes("requested a ride") && umaTexts[1] === "on the corner", "the note, then her message", umaTexts);

  step("a note placed (by id) before a message whose time rounds earlier: the chat's time stays the message's");
  const timing = await drew.eval(`(() => {
    const p = ensurePeer({ id: 900000001, name: "T" });
    const c = chatFor(p);
    const t0 = Date.now() - 60_000;
    // (the request came after message 10, before 50 — whose time rounds
    // 0.9 s EARLIER than the request's)
    c.msgs = [
      { id: 10, ts: Math.floor((t0 - 5000) / 1000), at: t0 - 5000, mine: false, text: "k" },
      { id: 50, ts: Math.floor(t0 / 1000), at: t0, mine: false, text: "m" },
    ];
    c.lastAt = t0;
    c.lastId = 50;
    restoreRequestNote(p, t0 + 900, 1, 10);
    const out = { lastAt: c.lastAt, t0, order: c.msgs.map((m) => m.text) };
    chats.delete(p);
    return out;
  })()`);
  check(timing.order.join(",") === "k,📩 requested a ride,m" && timing.lastAt === timing.t0, "placed after message 10; the chat's time: its newest message's, not the note's", timing);

  step("Vic asks; Drew replies (from 'another phone': this one's seen mark wiped); a full reload: the note not unread — his reply passed it");
  const vic = await browser.person("BT-LiveVic");
  const vicId = await vic.id();
  await sees(vic, drewId, "(Drew's car)");
  await openChatWith(vic, drewId);
  await ask(vic);
  await drew.waitFor(`realPeersById.has(${vicId}) && realPeersById.get(${vicId}).pending === true`, "Drew has Vic's request");
  await drew.eval(`(closeChat(), openChat(realPeersById.get(${vicId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${vicId})).loaded !== false`, "Vic's chat open", 10000);
  await say(drew, "coming");
  // (Vic writes back after Drew's reply: the chat's last is HIS — Drew's
  // reply sits in the middle, where a reload's summary can't see it)
  await drew.eval(`(closeChat(), true)`);
  await say(vic, "thanks");
  await drew.waitFor(`chats.get(realPeersById.get(${vicId})).msgs.some((m) => m.text === "thanks") && chats.get(realPeersById.get(${vicId})).unread === 1`, "Vic's reply in, unread");
  await drew.eval(`(() => { seenReqMem = {}; try { localStorage.removeItem(seenReqKey()); } catch (_) {} return true; })()`);
  await drew.open();
  await drew.waitFor(`hydrated && !reloading && chats.has(realPeersById.get(${vicId}))`, "back after a full reload", 10000);
  check((await drew.eval(`chats.get(realPeersById.get(${vicId})).unread`)) === 1, "Vic's chat: 1 unread (his 'thanks'), the note not (Drew's reply after it)", await drew.eval(`chats.get(realPeersById.get(${vicId})).unread`));

  step("Vic's request heard AGAIN after the reload (saved, then announced — a state read between): still one note");
  const again = await drew.eval(`(() => {
    const p = realPeersById.get(${vicId});
    userChannel.trigger("request", { from: { id: p.id, name: p.name, photo: p.photo || null }, spot: null, req: p.pendingReq, after_id: null });
    return chats.get(p).msgs.filter((m) => String(m.text).includes("requested a ride")).length;
  })()`);
  check(again === 1, "one note", again);

  step("a reload's note, then (the rider signing out between the save and the announce) withdrawn, the request heard late, withdrawn again: one note, one withdrawn line");
  // (Requests.announce: a cancel between the save and the announce goes
  // out BEFORE the "request", and is said again after it — review, 2026-11-25)
  const twice = await drew.eval(`(() => {
    const p = ensurePeer({ id: 900000005, name: "T5" });
    const from = { id: p.id, name: p.name, photo: null };
    p.pending = true;
    p.pendingReq = 88;
    restoreRequestNote(p, Date.now() - 1000, 88, null);
    userChannel.trigger("request_cancelled", { from_id: p.id });
    userChannel.trigger("request", { from, spot: null, req: 88, after_id: null });
    userChannel.trigger("request_cancelled", { from_id: p.id });
    const msgs = chats.get(p).msgs;
    const out = {
      notes: msgs.filter((m) => String(m.text).includes("requested a ride")).length,
      lines: msgs.filter((m) => String(m.text).includes("withdrawn")).length,
      pending: p.pending,
    };
    chats.delete(p);
    return out;
  })()`);
  check(twice.notes === 1 && twice.lines === 1 && twice.pending !== true, "one note, one withdrawn line, not pending", twice);

  step("a reload's note behind the summary's newer message S; she writes L (live), then withdraws: the list shows L or the withdrawn line — never the older S");
  const behindL = await drew.eval(`(() => {
    const p = ensurePeer({ id: 900000006, name: "T6" });
    const from = { id: p.id, name: p.name, photo: null };
    const c = chatFor(p);
    const now = Date.now();
    c.loaded = false;
    c.msgs = [];
    c.summary = { last: { id: 10, ts: Math.floor((now - 30000) / 1000), preview: "S", mine: false }, theirs: [] };
    p.pending = true;
    p.pendingReq = 77;
    restoreRequestNote(p, now - 60000, 77, 5);
    userChannel.trigger("msg", { id: 12, from, text: "L", ts: Math.floor(now / 1000) });
    userChannel.trigger("request_cancelled", { from_id: p.id });
    const out = { line: HoodChatList.preview(c).text };
    chats.delete(p);
    return out;
  })()`);
  check(behindL.line !== "S", "the list's line: not the older S", behindL);

  step("a reload's note at the oldest end of a full chat (20 kept) is trimmed at once: not counted unread");
  const trimmed = await drew.eval(`(() => {
    const p = ensurePeer({ id: 900000002, name: "T2" });
    const c = chatFor(p);
    const t0 = Date.now() - 600_000;
    c.msgs = Array.from({ length: CHAT_KEEP }, (_, k) => ({ id: 100 + k, ts: Math.floor((t0 + k * 1000) / 1000), at: t0 + k * 1000, mine: false, text: "m" + k }));
    c.unread = 0;
    restoreRequestNote(p, t0 - 5000, 7, null);
    const out = { unread: c.unread, kept: c.msgs.length, note: c.msgs.some((m) => m.restored) };
    chats.delete(p);
    return out;
  })()`);
  check(!trimmed.note && trimmed.unread === 0, "trimmed, and not counted", trimmed);

  step("a request, withdrawn, asked again — all after the same message, live in a chat not loaded yet: opened, they stay in that order");
  const order = await drew.eval(`(() => {
    const held = [
      { id: null, mine: false, text: "req1", afterId: 5, after: 5, at: 1 },
      { id: null, mine: false, text: "(request withdrawn)", after: 5, at: 2 },
      { id: null, mine: false, text: "req2", afterId: 5, after: 5, at: 3 },
    ];
    return placeRestored(HoodChatMerge.merge([{ id: 5, mine: false, text: "m5", at: 0, ts: 0 }], held)).map((m) => m.text);
  })()`);
  check(order.join(",") === "m5,req1,(request withdrawn),req2", "m5, req1, withdrawn, req2", order);

  step("a chat not loaded yet: asked (after X), withdrawn, then she writes 'hi' — opened: X, the note, withdrawn, hi (in the order they happened)");
  const order2 = await drew.eval(`(() => {
    // (as the live handlers leave them: the request's note knows its message
    // (X, the summary's last); the withdrawn line comes after the newest known)
    const p = ensurePeer({ id: 900000004, name: "T4" });
    const c = chatFor(p);
    const now = Date.now();
    const x = { id: 5, mine: false, text: "X", at: now - 60000, ts: Math.floor((now - 60000) / 1000) };
    const hi = { id: 7, mine: false, text: "hi", at: now + 2000, ts: Math.floor((now + 2000) / 1000) };
    c.loaded = false;
    c.summary = { last: { id: 5, ts: x.ts, preview: "X", mine: false }, theirs: [] };
    c.msgs = [];
    userChannel.trigger("request", { from: { id: p.id, name: p.name, photo: null }, spot: null, req: 77, after_id: 5 });
    userChannel.trigger("request_cancelled", { from_id: p.id });
    c.msgs.push({ ...hi });
    const out = placeRestored(HoodChatMerge.merge([x, hi], c.msgs)).map((m) => (String(m.text).includes("requested") ? "note" : m.text));
    chats.delete(p);
    return out;
  })()`);
  check(order2.join(",") === "X,note,(request withdrawn),hi", "X, the note, withdrawn, hi", order2);

  step("the request's message trimmed away (older than every message kept): the note goes before them all, not by its rounded time");
  const order3 = await drew.eval(`(() => {
    const t0 = Date.now() - 60_000;
    const msgs = [
      { id: 10, ts: 0, at: t0, mine: false, text: "m10" },
      { id: 11, ts: 0, at: t0 + 2000, mine: false, text: "m11" },
    ];
    // (its message, 5, trimmed; its time rounded to between m10 and m11)
    const n = { id: null, mine: false, text: "note", restored: true, afterId: 5, at: t0 + 1000 };
    return placeRestored(msgs.concat([n])).map((m) => m.text);
  })()`);
  check(order3.join(",") === "note,m10,m11", "the note first", order3);

  step("two tabs: one stored 'seen' for Vic's new request; this tab's memory holds an older one — the stored one counts");
  const pick = await drew.eval(`(() => {
    const id = ${vicId};
    const before = { mem: seenReqMem, stored: localStorage.getItem(seenReqKey()) };
    seenReqMem = { [id]: 111 };
    localStorage.setItem(seenReqKey(), JSON.stringify({ [id]: 222 }));
    const got = seenReqOf(id);
    seenReqMem = before.mem;
    before.stored == null ? localStorage.removeItem(seenReqKey()) : localStorage.setItem(seenReqKey(), before.stored);
    return got;
  })()`);
  check(pick === 222, "the stored (newer) one", pick);

  step("storage full (it reads, but writes fail): Yan asks, Drew reads the note; a reconnect: not unread again (this tab remembers)");
  await drew.eval(`(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (String(k).startsWith(SEEN_REQ_PREFIX)) throw new DOMException("full", "QuotaExceededError"); return set.call(this, k, v); };
    return true;
  })()`);
  const yan = await browser.person("BT-LiveYan");
  const yanId = await yan.id();
  await sees(yan, drewId, "(Drew's car)");
  await openChatWith(yan, drewId);
  await ask(yan);
  await drew.waitFor(`realPeersById.has(${yanId}) && realPeersById.get(${yanId}).pending === true`, "Drew has Yan's request");
  await drew.eval(`(closeChat(), openChat(realPeersById.get(${yanId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${yanId})).loaded !== false && chats.get(realPeersById.get(${yanId})).unread === 0`, "Yan's note read", 10000);
  await drew.eval(`(closeChat(), softReload(), true)`);
  await drew.waitFor(`hydrated && !reloading && chats.has(realPeersById.get(${yanId}))`, "back after a reconnect", 10000);
  check((await drew.eval(`chats.get(realPeersById.get(${yanId})).unread`)) === 0, "Yan's note: not unread again", await drew.eval(`chats.get(realPeersById.get(${yanId})).unread`));
  check(drew.errors.length === 0, "no page errors", drew.errors);
});
