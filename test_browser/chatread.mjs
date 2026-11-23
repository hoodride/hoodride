// Read only as SEEN (owner, 2026-11-20: "messages come in, the unread goes
// up to 10, I open the chat, the unread instantly goes to zero when clearly
// I've only seen a portion of it — and when I close and open it again I'm
// at the bottom"). As Telegram: a message counts as read once its end has
// been on screen; the count goes down as you scroll; the server is told
// "read up to here", never more; closed and opened again, you're back
// exactly where you were (scrolled up), the "New messages" line above what's
// still unread. Nothing is read while the app is out of sight.
import { journey, step, check, server, BASE } from "./cdp.mjs";
import { dropAndWait, restoreAndWait } from "./app.mjs";

const chatOf = (id) => `chats.get(realPeersById.get(${id}))`;
const unread = (p, id) => p.eval(`${chatOf(id)}.unread`);
const frames = (p, k) => p.eval(`new Promise((ok) => { let i = 0; const f = () => (++i >= ${k} ? ok(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
// what's on screen: the line (and the text just after it), the first
// message at the top and how far down, the ↓ badge
const view = (p) =>
  p.eval(`(() => {
    const b = document.getElementById("chat-messages"), br = b.getBoundingClientRect();
    const line = b.querySelector(".chat-line");
    const top = [...b.querySelectorAll(".msg")].find((e) => e.getBoundingClientRect().bottom > br.top);
    const badge = document.getElementById("chat-jump-count");
    return {
      line: line ? line.nextElementSibling && line.nextElementSibling.textContent : null,
      top: top ? top.textContent : null,
      topOffset: top ? Math.round(top.getBoundingClientRect().top - br.top) : null,
      fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
      atTop: b.scrollTop === 0,
      badge: badge.classList.contains("hidden") ? null : badge.textContent,
    };
  })()`);
// the server's "read up to" for this chat: the text of the message it names
const serverRead = (p, id) =>
  p.eval(`fetch("/api/chat?peer=${id}").then((r) => r.json()).then((b) => {
    const m = b.read && b.messages.find((x) => x.id === b.read[1]);
    return m ? m.text : null;
  })`);
// …waited for: the server is told about a second after the reading
// (batched — never a push per frame: review, 2026-11-20)
const serverReadIs = async (p, id, text, what) => {
  let mark = null;
  for (let i = 0; i < 100; i++) {
    mark = await serverRead(p, id);
    if (mark === text) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(mark === text, what, { mark, want: text });
};
const scrollBy = async (p, px) => {
  await p.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop += ${px}; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await frames(p, 3);
};

await journey("chatread: unread read only as seen; the count goes down as you scroll; back where you were", async (browser) => {
  step("Fay writes Rita 20 while her chat is closed: 20 unread");
  const rita = await browser.person("BT-ReadRita");
  // (a short screen: 20 messages don't fit)
  await rita.phone(390, 600);
  const fay = await browser.person("BT-ReadFay");
  const [ritaId, fayId] = [await rita.id(), await fay.id()];
  await server(`many_msgs ${fayId} ${ritaId} 20 f`);
  await rita.waitFor(`realPeersById.has(${fayId}) && ${chatOf(fayId)} && ${chatOf(fayId)}.unread === 20`, "20 unread from Fay", 15000);

  step("she opens it: at the 'New messages' line — only what's on screen is read, the rest still unread");
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.loaded !== false`, "loaded");
  await frames(rita, 4);
  const opened = await view(rita);
  const left = await unread(rita, fayId);
  check(opened.line === "f1", "the line above the first of them", opened);
  check(left > 0 && left < 20, "only what's on screen read — the rest still unread", left);
  check(opened.badge === String(left), "↓ counts what's still unread below", { opened, left });
  // the server: read up to the last one seen — not the newest
  await rita.waitFor(`!!${chatOf(fayId)}.serverRead`, "the server told");
  await serverReadIs(rita, fayId, `f${20 - left}`, "the server's mark: the last one seen");

  step("she scrolls down a little: the count goes down");
  await scrollBy(rita, 150);
  let fewer = await unread(rita, fayId);
  check(fewer < left && fewer > 0, "fewer unread, some still below", { before: left, now: fewer });
  await serverReadIs(rita, fayId, `f${20 - fewer}`, "the server's mark moved with it");

  // (review, 2026-11-20) a push per frame as she scrolled: a slow scroll
  // through a busy chat spent the account's shared events budget — a
  // driver's car updates and messages then refused
  step("she scrolls down slowly through the rest: the server told a few times, not once a frame");
  await rita.eval(`(() => { window.__reads = 0; const p = userChannel.push.bind(userChannel); userChannel.push = (ev, ...a) => { if (ev === "read") window.__reads++; return p(ev, ...a); }; return true; })()`);
  for (let i = 0; i < 12; i++) await scrollBy(rita, 30);
  await new Promise((r) => setTimeout(r, 1500));
  const reads = await rita.eval(`window.__reads`);
  check(reads >= 1 && reads <= 3, "a few pushes, not one a frame", reads);
  await rita.eval(`(delete userChannel.push, true)`);
  const fewer2 = await unread(rita, fayId);
  await serverReadIs(rita, fayId, `f${20 - fewer2}`, "the server's mark: where she got to");
  fewer = fewer2;
  await scrollBy(rita, -360);

  // (review, 2026-11-20) a push answered "rate_limited" (or timed out):
  // the mark sat unsent until another reading or a reload
  step("the server refuses a read push once (rate limited): it's sent again by itself");
  await rita.eval(`(() => {
    const p = userChannel.push.bind(userChannel);
    let refused = false;
    userChannel.push = (ev, ...a) => {
      if (ev === "read" && !refused) {
        refused = true;
        const fake = { receive: (st, cb) => { if (st === "error") setTimeout(() => cb({ reason: "rate_limited" }), 10); return fake; } };
        return fake;
      }
      return p(ev, ...a);
    };
    return true;
  })()`);
  await scrollBy(rita, 420);
  const fewer3 = await unread(rita, fayId);
  check(fewer3 < fewer, "(read a little more)", { fewer, fewer3 });
  await serverReadIs(rita, fayId, `f${20 - fewer3}`, "the server's mark: there, after the refusal");
  await rita.eval(`(delete userChannel.push, true)`);
  fewer = fewer3;
  await scrollBy(rita, -420);

  step("she scrolls back up: nothing becomes unread again");
  await scrollBy(rita, -150);
  check((await unread(rita, fayId)) === fewer, "the same count", await unread(rita, fayId));
  await scrollBy(rita, 150);

  step("she closes the chat and opens it again: exactly where she was, the line above what she hasn't seen");
  const before = await view(rita);
  await rita.eval(`closeChat(), true`);
  check((await unread(rita, fayId)) === fewer, "closed: still unread", await unread(rita, fayId));
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await frames(rita, 4);
  const back = await view(rita);
  check(back.top === before.top && Math.abs(back.topOffset - before.topOffset) <= 1, "the same message at the top, the same place", { before, back });
  // (the line: above the first she hasn't seen yet — what she read isn't new)
  check(back.line === `f${20 - fewer + 1}`, "the 'New messages' line above the first she hasn't seen", { back, fewer });
  check((await unread(rita, fayId)) === fewer, "the same unread", await unread(rita, fayId));

  step("…and via ‹ to the list and back: the same");
  await server(`many_msgs ${ritaId} ${fayId} 1 hello`);
  await rita.waitFor(`chats.size === 1`, "one chat");
  // (a second chat, so ‹ shows the list)
  const gus = await browser.person("BT-ReadGus");
  const gusId = await gus.id();
  await server(`many_msgs ${gusId} ${ritaId} 1 g`);
  await rita.waitFor(`chats.size === 2`, "two chats");
  await rita.eval(`backToList(), true`);
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await frames(rita, 4);
  const back2 = await view(rita);
  check(back2.top === before.top && Math.abs(back2.topOffset - before.topOffset) <= 1, "the same place", { before, back2 });

  // (review, 2026-11-20) a phone locked and unlocked reconnects: a reload —
  // every chat made afresh, the place she'd kept gone
  step("…and after a reconnect (the phone locked a minute): still where she was");
  await rita.eval(`closeChat(), true`);
  await rita.eval(`softReload(), true`);
  await rita.waitFor(`hydrated && !reloading && ${chatOf(fayId)} && ${chatOf(fayId)}.loaded === false`, "reloaded: her chat a summary", 15000);
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.loaded === true`, "loaded", 15000);
  await frames(rita, 4);
  const back3 = await view(rita);
  check(back3.top === before.top && Math.abs(back3.topOffset - before.topOffset) <= 1, "the same place", { before, back3 });

  step("she scrolls to the newest: all read, the server's mark the newest");
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await frames(rita, 3);
  check((await unread(rita, fayId)) === 0, "none unread", await unread(rita, fayId));
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "0");
  await serverReadIs(rita, fayId, "f20", "the server: read up to the newest");

  step("at the bottom, Fay writes: read at once (it's on screen)");
  await server(`many_msgs ${fayId} ${ritaId} 1 now`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "now1")`, "it came");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "read: she's at the bottom", 5000);

  step("the app out of sight (another app on top), Fay writes: unread until Rita's back");
  await rita.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => true }), document.dispatchEvent(new Event("visibilitychange")), true)`);
  await server(`many_msgs ${fayId} ${ritaId} 1 away`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "away1")`, "it came");
  await frames(rita, 4);
  check((await unread(rita, fayId)) === 1, "unread while she's away", await unread(rita, fayId));
  await rita.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => false }), document.dispatchEvent(new Event("visibilitychange")), true)`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "back: read", 5000);

  // (review, 2026-11-20) at the bottom, the app out of sight: what came
  // followed down unseen — back, everything above the screen counted as
  // scrolled past: all read, though she saw only the last few
  step("at the bottom, the app out of sight, Fay writes 20: back — at the 'New messages' line, only what's on screen read");
  await rita.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => true }), document.dispatchEvent(new Event("visibilitychange")), true)`);
  await server(`many_msgs ${fayId} ${ritaId} 20 w`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "w20")`, "the 20 came");
  await frames(rita, 3);
  check((await unread(rita, fayId)) === 20, "20 unread while she's away", await unread(rita, fayId));
  await rita.eval(`(Object.defineProperty(document, "hidden", { configurable: true, get: () => false }), document.dispatchEvent(new Event("visibilitychange")), true)`);
  await frames(rita, 6);
  const backView = await view(rita);
  const backLeft = await unread(rita, fayId);
  check(backView.line === "w1", "the line above the first of them", backView);
  check(backLeft > 0 && backLeft < 20, "only what's on screen read", backLeft);
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "↓: all read", 5000);

  // …the same after a reconnect (a phone locked: the connection drops)
  step("at the bottom, the connection drops, Fay writes 20, it comes back: at the 'New messages' line, only what's on screen read");
  await dropAndWait(rita);
  await server(`many_msgs ${fayId} ${ritaId} 20 v`);
  await restoreAndWait(rita);
  await rita.waitFor(`${chatOf(fayId)} && ${chatOf(fayId)}.loaded === true && ${chatOf(fayId)}.msgs.some((m) => m.text === "v20")`, "the 20 here", 15000);
  await frames(rita, 6);
  const reView = await view(rita);
  const reLeft = await unread(rita, fayId);
  check(reView.line === "v1", "the line above the first of them", reView);
  check(reLeft > 0 && reLeft < 20, "only what's on screen read", reLeft);
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "↓: all read", 5000);

  // (review, 2026-11-20) scrolled up, but only this phone's own notes from
  // the top of the screen down (no server id: a reload drops them) — the
  // reload found no place to put her back, left her at the newest, and what
  // came while it was down was read unseen as scrolled past
  step("scrolled up over only her own notes, the connection drops, Fay writes 20, it comes back: at the 'New messages' line");
  await rita.eval(`(() => { const c = ${chatOf(fayId)}; for (let i = 1; i <= 12; i++) c.msgs.push({ text: "note " + i, mine: true, at: Date.now(), ts: null, id: null }); renderChat(); return true; })()`);
  await frames(rita, 3);
  await scrollBy(rita, -200);
  check((await view(rita)).top.startsWith("note"), "(only notes from the top of the screen down)", await view(rita));
  check(!(await rita.eval(`chatStick.stuck`)), "(scrolled up)");
  await dropAndWait(rita);
  await server(`many_msgs ${fayId} ${ritaId} 20 u`);
  await restoreAndWait(rita);
  await rita.waitFor(`${chatOf(fayId)} && ${chatOf(fayId)}.loaded === true && ${chatOf(fayId)}.msgs.some((m) => m.text === "u20")`, "the 20 here", 15000);
  await frames(rita, 6);
  const noteView = await view(rita);
  const noteLeft = await unread(rita, fayId);
  check(noteView.line === "u1", "the line above the first of them", noteView);
  check(noteLeft > 0 && noteLeft < 20, "only what's on screen read", noteLeft);
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "↓: all read", 5000);

  step("scrolled up, Fay writes: unread, ↓ 1 — read once she scrolls to it");
  await scrollBy(rita, -400);
  await server(`many_msgs ${fayId} ${ritaId} 1 below`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "below1")`, "it came");
  await frames(rita, 3);
  check((await unread(rita, fayId)) === 1, "unread: below her", await unread(rita, fayId));
  check((await view(rita)).badge === "1", "↓ 1", await view(rita));
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "↓ tapped: read", 5000);

  // (2026-11-20, caught by logging a rare miss) "at the newest" allows a
  // few pixels short of the very bottom (a finger's nudge isn't scrolling
  // up); the content grew under her that much, no scroll, no resize — the
  // newest message just below the edge, never counted seen
  step("at the newest, the chat grows a little under her (no scroll, no resize), Fay writes: it's read");
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`chatStick.stuck && ${chatOf(fayId)}.unread === 0`, "at the newest, all read");
  await server(`many_msgs ${fayId} ${ritaId} 1 grow`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "grow1")`, "it came");
  // (the same frame it's drawn: the newest bubble 45 px taller below her)
  await rita.eval(`(() => { const m = ${chatOf(fayId)}.msgs.at(-1); bubbleOf.get(m).style.paddingBottom = "45px"; return true; })()`);
  await rita.eval(`(readSeenSoon(), true)`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "read: she's at the newest", 5000);
  await rita.eval(`(bubbleOf.get(${chatOf(fayId)}.msgs.at(-1)).style.paddingBottom = "", true)`);

  // (review, 2026-11-20) read while the connection was down: this phone's
  // mark moved, the server's never did — the other phone still showed them
  // unread, and a later reload could bring the count back
  step("she reads 10 while the connection is down; it comes back: the server's mark catches up");
  await rita.eval(`closeChat(), true`);
  await server(`many_msgs ${fayId} ${ritaId} 10 x`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 10`, "10 unread");
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.unread < 10`, "opened: what's on screen read", 5000);
  await dropAndWait(rita);
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "read to the end, offline", 5000);
  await restoreAndWait(rita);
  let mark = null;
  for (let i = 0; i < 50 && mark !== "x10"; i++) {
    mark = await serverRead(rita, fayId);
    if (mark !== "x10") await new Promise((r) => setTimeout(r, 100));
  }
  check(mark === "x10", "the server's mark: the newest she read", mark);

  // (review, 2026-11-20) a phone with no read marks of its own (a new
  // phone, cleared or blocked storage) and none on the server: every chat
  // taken as read on this phone — and the resend told the server so, unseen
  step("a new phone that never opened a chat, 3 from Fay: a reload never tells the server they're read");
  const kim = await browser.person("BT-ReadKim");
  const kimId = await kim.id();
  await server(`many_msgs ${fayId} ${kimId} 3 k`);
  await kim.waitFor(`realPeersById.has(${fayId}) && ${chatOf(fayId)} && ${chatOf(fayId)}.unread === 3`, "3 unread", 15000);
  await kim.eval(`(HoodReadStore.forget(window.localStorage, state.realUser.id), softReload(), true)`);
  await kim.waitFor(`hydrated && !reloading`, "reloaded", 15000);
  await new Promise((r) => setTimeout(r, 1000));
  check((await serverRead(kim, fayId)) === null, "the server: nothing read", await serverRead(kim, fayId));
  // (review, 2026-11-20) …and after the NEXT reconnect: the first run's
  // made-up marks were saved on the phone, then sent as if read
  await kim.eval(`softReload(), true`);
  await kim.waitFor(`hydrated && !reloading`, "reloaded again", 15000);
  await new Promise((r) => setTimeout(r, 1000));
  check((await serverRead(kim, fayId)) === null, "the server, after another reconnect: still nothing read", await serverRead(kim, fayId));
  check(kim.errors.length === 0, "no page errors", kim.errors);

  // (review, 2026-11-20) a page of older chats arriving recounts every
  // chat's unread from the read marks — the open one too, without this
  // phone's own notes (no server id): 2 unread became 1, the line on the
  // note, Fay's message taken as read unseen
  step("scrolled up, Fay writes and a note comes (2 unread); a page of the list arrives: still 2");
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`chatStick.stuck && ${chatOf(fayId)}.unread === 0`, "at the newest, all read");
  await scrollBy(rita, -400);
  await server(`many_msgs ${fayId} ${ritaId} 1 pg`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "pg1")`, "it came");
  await rita.eval(`(receiveMsg(realPeersById.get(${fayId}), "📩 a note"), true)`);
  await frames(rita, 3);
  check((await unread(rita, fayId)) === 2, "2 unread below her", await unread(rita, fayId));
  // (what a page of older chats does when it arrives)
  await rita.eval(`(applyReadState(), refreshControls(), true)`);
  check((await unread(rita, fayId)) === 2, "still 2 — the note not dropped from the count", await unread(rita, fayId));
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "↓: all read", 5000);
  await serverReadIs(rita, fayId, "pg1", "the server: read up to her message");

  // (review, 2026-11-20) the same for a chat NOT on screen: the recount
  // from the marks can't see this phone's notes — 2 unread became 1, the
  // note taken as read unseen
  step("on the chat list, a note and a message from Fay (2 unread); a page of the list arrives: still 2");
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "all read");
  await rita.eval(`backToList(), true`);
  await rita.eval(`(receiveMsg(realPeersById.get(${fayId}), "📩 another note"), true)`);
  await server(`many_msgs ${fayId} ${ritaId} 1 lst`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "lst1")`, "it came");
  check((await unread(rita, fayId)) === 2, "2 unread", await unread(rita, fayId));
  await rita.eval(`(applyReadState(), refreshControls(), true)`);
  check((await unread(rita, fayId)) === 2, "still 2 — the note not dropped", await unread(rita, fayId));
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "opened: both on screen, read", 5000);

  // (review, 2026-11-20) a note ABOVE a message read on another phone: one
  // recount counted it, the next dropped it — the count flipped, nothing read
  step("on the list, a note then a message from Fay; the message read on another phone: every recount gives the same count");
  await rita.eval(`backToList(), true`);
  await rita.eval(`(receiveMsg(realPeersById.get(${fayId}), "📩 a third note"), true)`);
  await server(`many_msgs ${fayId} ${ritaId} 1 rd`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "rd1")`, "it came");
  // (read on another phone: the mark at "rd1")
  await rita.eval(`(() => { const c = ${chatOf(fayId)}; const a = c.msgs.find((m) => m.text === "rd1"); const s = storageOrNull(); HoodReadStore.save(s, state.realUser.id, HoodReadStore.seen(HoodReadStore.read(s, state.realUser.id) || {}, ${fayId}, [{ ts: a.ts, id: a.id }])); return true; })()`);
  const counts = [];
  for (let i = 0; i < 3; i++) counts.push(await rita.eval(`(applyReadState(), ${chatOf(fayId)}.unread)`));
  check(counts.every((n) => n === counts[0]), "the same count every recount", counts);
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "opened: read", 5000);

  // (review, 2026-11-20) ↓ counted unread that another device had read
  // meanwhile: the count came back 0, the badge kept its number
  step("scrolled up, ↓ shows 3; the count becomes 0 (read on another phone): ↓ shows no number");
  // (once the opening has settled: a scroll while the box still resizes
  // counts as the resize's, not hers — HoodChatScroll's stick)
  await frames(rita, 4);
  await new Promise((r) => setTimeout(r, 50));
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = 0; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`!chatStick.stuck`, "scrolled up");
  await frames(rita, 3);
  // (a stale ↓ 3 with nothing unread — set and looked at in one go)
  const stale = await rita.eval(`(chatBelow = 3, updateChatJump(), ${chatOf(fayId)}.unread = 0, document.getElementById("chat-jump-count").textContent)`);
  check(stale === "3", "(↓ 3)", stale);
  await rita.eval(`(readSeenSoon(), true)`);
  await frames(rita, 3);
  check((await view(rita)).badge === null, "no number on ↓", await view(rita));
  // (back to the newest, as the next step expects)
  await rita.click("chat-jump");
  await rita.waitFor(`chatStick.stuck`, "at the newest");

  // (owner, 2026-11-20, an iPhone: "unread 2, I scroll one message down —
  // it should show 1, but it just disappears; and at the very bottom the
  // ↓ button still shows") near the bottom counted as AT it: ↓ and its
  // count hidden, then the last one read too; and the bounce at the bottom
  // read as scrolling up
  step("2 unread below her; she scrolls the first fully into view: 1 unread, ↓ 1 — at the very bottom: none, no ↓");
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`chatStick.stuck && ${chatOf(fayId)}.unread === 0`, "at the newest, all read");
  await scrollBy(rita, -400);
  await server(`many_msgs ${fayId} ${ritaId} 2 two`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "two2")`, "the 2 came");
  await frames(rita, 3);
  check((await unread(rita, fayId)) === 2, "2 unread below her", await unread(rita, fayId));
  // scrolled so "two1" is wholly on screen, "two2" not yet
  await rita.eval(`(() => {
    const b = document.getElementById("chat-messages");
    const el = [...b.querySelectorAll(".msg")].find((e) => e.textContent === "two1");
    b.scrollTop += el.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom + 2;
    b.dispatchEvent(new Event("scroll"));
    return true;
  })()`);
  await frames(rita, 4);
  check((await unread(rita, fayId)) === 1, "1 unread — the one still below", await unread(rita, fayId));
  check((await view(rita)).badge === "1", "↓ 1", await view(rita));
  // (review, 2026-11-20) closed and opened again — back where she was, a
  // few px short of the end: put back "at the bottom" by the old 60 px rule,
  // ↓ hid and the last one was read
  await rita.eval(`closeChat(), true`);
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await frames(rita, 4);
  check((await unread(rita, fayId)) === 1, "reopened: still 1 unread", await unread(rita, fayId));
  check((await view(rita)).badge === "1", "reopened: ↓ 1", await view(rita));
  // the very bottom, with an iPhone's bounce: past the end, then back
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); chatStick.onScroll({ scrollTop: b.scrollTop + 12, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight }); b.dispatchEvent(new Event("scroll")); return true; })()`);
  await frames(rita, 4);
  check((await unread(rita, fayId)) === 0, "none unread", await unread(rita, fayId));
  check(await rita.eval(`document.getElementById("chat-jump").classList.contains("hidden")`), "no ↓ at the very bottom", await view(rita));
  // (review, 2026-11-20) a few px from the end, the keyboard closes (the box
  // grows): she's at the very bottom — ↓ stayed showing there
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop -= 20; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await frames(rita, 3);
  check(!(await rita.eval(`chatStick.stuck`)), "(a little short of the end: scrolled up)");
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.style.minHeight = (b.clientHeight + 40) + "px"; return true; })()`);
  await frames(rita, 6);
  await new Promise((r) => setTimeout(r, 50));
  const grown = await rita.eval(`(() => { const b = document.getElementById("chat-messages"); return { stuck: chatStick.stuck, jump: !document.getElementById("chat-jump").classList.contains("hidden"), gap: b.scrollHeight - b.scrollTop - b.clientHeight }; })()`);
  // (the box shrinking back is a resize: a scroll before it has settled
  // counts as the resize's, not hers — HoodChatScroll's stick. Unwaited, a
  // busy machine's precommit saw her still "at the bottom", 2026-11-22.
  // Waited for KNOWN, not guessed: an observer of our own, made after the
  // app's, runs after it; then a frame and a 1 ms timer, as onChatResize —
  // set after the app's, they run after its resizeDone)
  await rita.eval(`new Promise((done) => {
    const b = document.getElementById("chat-messages");
    const ro = new ResizeObserver(() => { ro.disconnect(); requestAnimationFrame(() => setTimeout(() => done(true), 1)); });
    b.style.minHeight = "";
    ro.observe(b);
  })`);
  check(grown.gap <= 2 && grown.stuck && !grown.jump, "the box grew to the bottom: following again, no ↓", grown);
  // (review, 2026-11-20) the panel closed shrinks the box to nothing — an
  // empty box is "at its very end": the re-check above took a reader who'd
  // scrolled up for one at the bottom, ↓'s count cleared
  await scrollBy(rita, -300);
  check(!(await rita.eval(`chatStick.stuck`)), "(scrolled up)");
  await rita.eval(`(chatBelow = 2, closeChat(), true)`);
  await frames(rita, 6);
  await new Promise((r) => setTimeout(r, 50));
  check(!(await rita.eval(`chatStick.stuck`)) && (await rita.eval(`chatBelow`)) === 2, "closed: never taken for 'at the bottom'", await rita.eval(`({ stuck: chatStick.stuck, below: chatBelow })`));
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return true; })()`);
  await rita.waitFor(`chatStick.stuck`, "back at the newest");

  step("a few unread that fit on screen: all read at once, at the newest");
  await rita.eval(`closeChat(), true`);
  await server(`many_msgs ${fayId} ${ritaId} 2 few`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 2`, "2 unread");
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  // (the panel shown: its box settles over a few frames — the app keeps her
  // at the bottom, then reads what's there)
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "both on screen: read", 5000);
  check((await view(rita)).fromBottom <= 2, "at the newest", await view(rita));

  // (review, 2026-11-20) all 20 kept unread, and she replies without
  // scrolling: her message pushed their oldest out, the count stayed at 20
  // with 19 of theirs left — stuck unread for ever
  step("20 unread, all she keeps; she opens and replies at once: her reply takes her to the newest — all read, never stuck");
  await rita.eval(`closeChat(), true`);
  await server(`many_msgs ${fayId} ${ritaId} 20 z`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 20 && ${chatOf(fayId)}.msgs.every((m) => !m.mine)`, "20 unread, all of the 20 kept");
  // (opened and replied before a frame is drawn: nothing counted seen yet)
  await rita.eval(`(() => { openChat(realPeersById.get(${fayId})); const i = document.getElementById("chat-input"); i.value = "ok!"; i.dispatchEvent(new Event("input")); document.getElementById("chat-form").requestSubmit(); return true; })()`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.mine && m.text === "ok!" && m.id != null)`, "sent");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "all read", 5000);
  check((await rita.eval(`${chatOf(fayId)}.unread <= ${chatOf(fayId)}.msgs.filter((m) => !m.mine).length`)), "never more unread than of theirs kept");
  check(rita.errors.length === 0, "no page errors", rita.errors);

  // (review, 2026-11-20) after a reload a chat isn't loaded until opened
  // (light reload): its unread is the server's count — one more coming
  // live was capped at the ONE message held: 4 unread became 1, and
  // opening read the other 3 unseen
  step("after a reload, Fay's chat (3 unread) not loaded yet; one more comes: 4, not 1");
  await rita.eval(`closeChat(), true`);
  await server(`many_msgs ${fayId} ${ritaId} 3 s`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 3`, "3 unread");
  await rita.eval(`softReload(), true`);
  await rita.waitFor(`hydrated && !reloading && ${chatOf(fayId)} && ${chatOf(fayId)}.loaded === false && ${chatOf(fayId)}.unread === 3`, "reloaded: a summary, 3 unread", 15000);
  await server(`many_msgs ${fayId} ${ritaId} 1 s4-`);
  await rita.waitFor(`${chatOf(fayId)}.msgs.some((m) => m.text === "s4-1")`, "the 4th, live");
  check((await unread(rita, fayId)) === 4, "4 unread", await unread(rita, fayId));
  // (opened: the line above the FIRST of the 4 — with only 1 counted it
  // went above the newest, the other 3 read unseen)
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.loaded === true`, "loaded", 15000);
  await rita.waitFor(`chatLineMsg && chatLineMsg.text === "s1"`, "the line above the first of the 4", 5000);
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(fayId)}.unread === 0`, "↓: all read", 5000);
  check(rita.errors.length === 0, "no page errors", rita.errors);

  // (review, 2026-11-20) a chat not loaded after a reload counts the server's
  // unread plus what comes live; loaded, its last 20 can hold fewer of
  // theirs (her replies from another phone among them). The count stayed
  // over them: no line, never read, stuck
  step("Hal writes 19, Rita replies 3 from another phone; a reload; 3 more from Hal; his chat opened: never more unread than of his kept — read to the end");
  const hal = await browser.person("BT-ReadHal");
  const halId = await hal.id();
  await server(`many_msgs ${halId} ${ritaId} 19 h`);
  await server(`many_msgs ${ritaId} ${halId} 3 r`);
  await rita.eval(`closeChat(), true`);
  await rita.eval(`softReload(), true`);
  await rita.waitFor(`hydrated && !reloading && ${chatOf(halId)} && ${chatOf(halId)}.loaded === false`, "reloaded: Hal's chat a summary", 15000);
  check((await unread(rita, halId)) === 17, "17 unread (the server counts what it keeps: 17 of his)", await unread(rita, halId));
  // 3 more, live, before his chat is loaded: 20 counted — loaded, the last
  // 20 hold 17 of his (her 3 replies among them)
  await server(`many_msgs ${halId} ${ritaId} 3 hh`);
  await rita.waitFor(`${chatOf(halId)}.unread === 20`, "20 counted, not loaded yet");
  await rita.eval(`openChat(realPeersById.get(${halId})), true`);
  await rita.waitFor(`${chatOf(halId)}.loaded === true`, "loaded", 15000);
  const halKept = await rita.eval(`${chatOf(halId)}.msgs.filter((m) => !m.mine).length`);
  check((await unread(rita, halId)) <= halKept, "no more unread than of his kept", { unread: await unread(rita, halId), halKept });
  await rita.waitFor(`!!chatLineMsg`, "the 'New messages' line", 5000);
  await rita.click("chat-jump");
  await rita.waitFor(`${chatOf(halId)}.unread === 0`, "↓: all read", 5000);
  check(rita.errors.length === 0, "no page errors", rita.errors);

  // (review, 2026-11-20) a chat on the list's second page: its place kept
  // when she left it, then a reconnect — places were put back only into the
  // chats the reload brought (the first page): lost
  step("a chat on the list's second page: scrolled up, closed, a reconnect — opened again, where she was");
  const pia = await browser.person("BT-ReadPia");
  await pia.phone(390, 600);
  const ivy = await browser.person("BT-ReadIvy");
  const [piaId, ivyId] = [await pia.id(), await ivy.id()];
  await server(`many_msgs ${ivyId} ${piaId} 20 i`);
  // (35 newer chats: Ivy's the oldest — on the second page)
  await server(`chat_crowd 35 ${piaId}`);
  await server(`chat_age ${ivyId} ${piaId} 3600`);
  const page2 = async () => {
    await pia.eval(`softReload(), true`);
    await pia.waitFor(`hydrated && !reloading && chats.size === 30`, "the first page", 15000);
    check(!(await pia.eval(`realPeersById.has(${ivyId}) && chats.has(realPeersById.get(${ivyId}))`)), "(Ivy's chat not on the first page)");
    await pia.click("btn-chat");
    await pia.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length >= 30`, "the list drawn");
    await pia.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
    await pia.waitFor(`!olderLoading && realPeersById.has(${ivyId}) && chats.has(realPeersById.get(${ivyId}))`, "the second page, with Ivy's chat", 15000);
  };
  await page2();
  await pia.eval(`openChat(realPeersById.get(${ivyId})), true`);
  await pia.waitFor(`${chatOf(ivyId)}.loaded === true`, "loaded", 15000);
  await frames(pia, 4);
  await scrollBy(pia, -200);
  check(!(await pia.eval(`chatStick.stuck`)), "(scrolled up)");
  const piaBefore = await view(pia);
  await pia.eval(`closeChat(), true`);
  await page2();
  await pia.eval(`openChat(realPeersById.get(${ivyId})), true`);
  await pia.waitFor(`${chatOf(ivyId)}.loaded === true`, "loaded", 15000);
  await frames(pia, 4);
  const piaBack = await view(pia);
  // (the same message at the top; at the very top of the chat both times,
  // the line moved below it — she'd read it — so it sits a line higher)
  check(
    piaBack.top === piaBefore.top && (Math.abs(piaBack.topOffset - piaBefore.topOffset) <= 1 || (piaBefore.atTop && piaBack.atTop)),
    "the same place",
    { piaBefore, piaBack }
  );
  check(pia.errors.length === 0, "no page errors", pia.errors);

  // (review, 2026-11-20) a chat read on another phone, opened here: its
  // messages came with the server's mark past them all — the count, the
  // line and ↓ stayed
  step("after a reload, Fay's 3 unread are read on another phone; opened here: none unread, no line");
  await rita.eval(`closeChat(), true`);
  await server(`many_msgs ${fayId} ${ritaId} 3 o`);
  await rita.waitFor(`${chatOf(fayId)}.unread === 3`, "3 unread");
  await rita.eval(`softReload(), true`);
  await rita.waitFor(`hydrated && !reloading && ${chatOf(fayId)} && ${chatOf(fayId)}.loaded === false && ${chatOf(fayId)}.unread === 3`, "reloaded: a summary, 3 unread", 15000);
  await server(`read_all ${ritaId} ${fayId}`);
  await rita.eval(`openChat(realPeersById.get(${fayId})), true`);
  await rita.waitFor(`${chatOf(fayId)}.loaded === true`, "loaded", 15000);
  check((await unread(rita, fayId)) === 0, "none unread", await unread(rita, fayId));
  check((await rita.eval(`chatLineMsg`)) === null, "no 'New messages' line", await rita.eval(`chatLineMsg && chatLineMsg.text`));
  check(rita.errors.length === 0, "no page errors", rita.errors);

  step("the demo too: a pretend driver's 20 messages — read only as seen");
  const dee = await browser.visitor("BT-ReadDee");
  await dee.phone(390, 600);
  await dee.goto(`${BASE}/?demo`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && drivers.length > 0`, "the demo", 15000);
  await dee.eval(`(() => { const p = drivers[0]; for (let i = 1; i <= 20; i++) receiveMsg(p, "d" + i); return true; })()`);
  check((await dee.eval(`chats.get(drivers[0]).unread`)) === 20, "20 unread", await dee.eval(`chats.get(drivers[0]).unread`));
  await dee.eval(`openChat(drivers[0]), true`);
  await frames(dee, 4);
  const demoLeft = await dee.eval(`chats.get(drivers[0]).unread`);
  check(demoLeft > 0 && demoLeft < 20, "only what's on screen read", demoLeft);
  await dee.eval(`closeChat(), true`);
  await dee.eval(`openChat(drivers[0]), true`);
  await frames(dee, 4);
  check((await dee.eval(`chats.get(drivers[0]).unread`)) === demoLeft, "closed and opened again: the same", await dee.eval(`chats.get(drivers[0]).unread`));

  // (review, 2026-11-20) 19 of theirs kept, all unread, one of yours among
  // them (a reply from another phone): their 20th pushes the oldest out —
  // the count went to 20 with 19 of theirs kept, stuck for ever
  step("19 of theirs unread and one of yours, all kept; their next comes: never more unread than of theirs kept");
  await dee.eval(`(() => {
    const p = drivers[1];
    const c = chatFor(p);
    c.msgs = [{ text: "t1", mine: false, at: Date.now() }, { text: "mine", mine: true, at: Date.now() }];
    for (let i = 2; i <= 19; i++) c.msgs.push({ text: "t" + i, mine: false, at: Date.now() });
    c.unread = 19;
    receiveMsg(p, "t20");
    return true;
  })()`);
  const kept = await dee.eval(`chats.get(drivers[1]).msgs.filter((m) => !m.mine).length`);
  check((await dee.eval(`chats.get(drivers[1]).unread`)) <= kept, "unread no more than of theirs kept", { unread: await dee.eval(`chats.get(drivers[1]).unread`), kept });
  await dee.eval(`openChat(drivers[1]), true`);
  await frames(dee, 4);
  check(await dee.eval(`!!document.querySelector("#chat-messages .chat-line")`), "the 'New messages' line found");
  check(dee.errors.length === 0, "no page errors", dee.errors);
});
