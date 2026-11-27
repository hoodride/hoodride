// A driver's waiting requests keep their place in the chat list after a
// reload (owner, 2026-11-22). The note "📩 requested a ride" is the
// phone's own — the server keeps no message for it — so a reload lost it:
// a request with no message left NO chat at all, one with messages sank
// below newer chats. Now each request still open comes back as its note,
// at the request's time: the list in the same order as before the reload;
// in the chat, the note among the messages by time (review, 2026-11-24: a
// message after the request, the note went last and the chat's time back
// to the request's); a note seen before isn't unread again. Drew has more
// chats than one page, so a request with no chat at all is one the list
// can't place by page (review: it showed "now", at the top).
import { journey, step, check, HOME, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

// (times are whole seconds, a request's off by up to one: Requests.wall_ts)
const gap = () => new Promise((r) => setTimeout(r, 2200));
// the top of the list as Drew sees it: name, preview, unread — newest first
const TOP = `(() => {
  if (document.getElementById("chat").classList.contains("hidden")) document.getElementById("btn-chat").click();
  else if (state.chatView !== "list") (closeChat(), document.getElementById("btn-chat").click());
  return [...document.querySelectorAll("#chat-messages .chat-item")].slice(0, 3).map((e) => ({
    name: e.querySelector("strong").textContent, last: e.querySelector(".muted").textContent, unread: e.classList.contains("unread"),
  }));
})()`;
const names = (l) => l.map((r) => r.name).join(", ");

await journey("requesttop: a driver's waiting requests keep their place in his chat list after a reload — one with no message too", async (browser) => {
  step("Drew (driver, online, 35 older chats); Rhea messages him, then Pat; Rhea asks for a ride, then Quinn (no message); then Rhea writes again");
  const drew = await browser.person("BT-TopDrew", { latitude: HOME.latitude + 0.003, longitude: HOME.longitude });
  const rhea = await browser.person("BT-TopRhea");
  const pat = await browser.person("BT-TopPat");
  const quinn = await browser.person("BT-TopQuinn");
  await goOnline(drew);
  const drewId = await drew.id();
  await server(`chat_crowd 35 ${drewId}`);
  await gap();
  const [rheaId, quinnId] = [await rhea.id(), await quinn.id()];
  for (const p of [rhea, pat, quinn]) await sees(p, drewId, "(Drew's car)");
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
  // (Rhea writes and asks AT ONCE — the same second: by time alone the note
  // could go before her message; the server's message id places it after)
  await openChatWith(rhea, drewId);
  await typeText(rhea, "hi Drew");
  await send(rhea);
  await rhea.waitFor(`chats.get(state.chatPeer).msgs.some((m) => m.mine && m.id != null && m.text === "hi Drew")`, "Rhea: sent");
  await ask(rhea);
  // ("hi Drew" timed 3 s later: by time, the note would go BEFORE it — only
  // the request's message id puts it right after)
  await server(`msgs_later ${rheaId} ${drewId} 3`);
  await openChatWith(pat, drewId);
  await say(pat, "hello");
  await openChatWith(quinn, drewId);
  await ask(quinn);
  await say(rhea, "I'm by the benches");
  await drew.waitFor(`[${rheaId}, ${quinnId}].every((id) => realPeersById.has(id) && realPeersById.get(id).pending === true)`, "Drew has both requests");
  await drew.waitFor(`chats.has(realPeersById.get(${rheaId})) && chats.get(realPeersById.get(${rheaId})).msgs.some((m) => m.text === "I'm by the benches")`, "Rhea's second message in");
  const before = await drew.eval(TOP);
  check(names(before) === "BT-TopRhea, BT-TopQuinn, BT-TopPat", "before: Rhea (newest message), Quinn (request), Pat", before);

  step("Drew reloads: the same order — Quinn's chat (a request, no message: older pages exist) at its request's time, not 'now'");
  await drew.open();
  await drew.waitFor(`hydrated && !reloading && state.online`, "Drew back, online");
  await drew.waitFor(`[${rheaId}, ${quinnId}].every((id) => chats.has(realPeersById.get(id)))`, "both chats back", 10000);
  const after = await drew.eval(TOP);
  check(names(after) === names(before), "after: the same order", { before, after });
  const row = (l, n) => l.find((r) => r.name === n);
  check(row(after, "BT-TopQuinn").last.includes("requested a ride") && row(after, "BT-TopQuinn").unread, "Quinn's: the note, unread", row(after, "BT-TopQuinn"));
  check(row(after, "BT-TopRhea").last === "I'm by the benches", "Rhea's line: her newest message (the note is older)", row(after, "BT-TopRhea"));
  // (Drew never opened it: her two messages unread — and the note between
  // them too, or "their newest N" stops one short: "hi Drew" looked read)
  check((await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`)) === 3, "Rhea's chat: 3 unread (hi, the note, the benches)", await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`));
  // read up to her newest — as on another phone of his, the note never on
  // screen: a message of hers AFTER the note read means the note was
  // passed — after a reload, not unread
  await drew.eval(`(() => { const p = realPeersById.get(${rheaId}), l = chats.get(p).summary.last; markSeen(p, [l.ts, l.id]); return true; })()`);
  await drew.eval(`(closeChat(), softReload(), true)`);
  await drew.waitFor(`hydrated && !reloading && chats.has(realPeersById.get(${rheaId}))`, "back after a soft reload", 10000);
  check((await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`)) === 0, "Rhea's chat: 0 unread (read past the note)", await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`));

  step("Rhea's chat opened: her message, the note, her later message — by time; the list's order kept");
  await drew.eval(`(closeChat(), openChat(realPeersById.get(${rheaId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${rheaId})).loaded !== false`, "Rhea's chat loaded", 10000);
  const texts = await drew.eval(`chats.get(realPeersById.get(${rheaId})).msgs.map((m) => m.text)`);
  check(texts.length === 3 && texts[0] === "hi Drew" && texts[1].includes("requested a ride") && texts[2] === "I'm by the benches", "in order: her message, the note (right after it, the same second), her later one", texts);
  await drew.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride in Rhea's chat");
  await drew.waitFor(`chats.get(realPeersById.get(${rheaId})).unread === 0`, "Rhea's chat read", 10000);
  const opened = await drew.eval(TOP);
  check(names(opened) === names(before), "the list's order after opening it: the same", opened);

  step("Quinn's chat seen; a FULL reload: one note each, never doubled — and Quinn's, seen, not unread again (kept on the phone)");
  await drew.eval(`(closeChat(), openChat(realPeersById.get(${quinnId})), true)`);
  await drew.waitFor(`chats.get(realPeersById.get(${quinnId})).loaded !== false && chats.get(realPeersById.get(${quinnId})).unread === 0`, "Quinn's chat open, its note read", 10000);
  check(await drew.eval(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${quinnId}`), "Quinn's chat still open (not 'ended')");
  await drew.open();
  await drew.waitFor(`hydrated && !reloading && [${rheaId}, ${quinnId}].every((id) => chats.has(realPeersById.get(id)))`, "back after the full reload", 10000);
  const notes = await drew.eval(`[${rheaId}, ${quinnId}].map((id) => chats.get(realPeersById.get(id)).msgs.filter((m) => m.text.includes("requested a ride")).length)`);
  check(JSON.stringify(notes) === "[1,1]", "one note each", notes);
  check((await drew.eval(`chats.get(realPeersById.get(${quinnId})).unread`)) === 0, "Quinn's note, seen before: not unread again");

  step("Rhea writes once more; Drew reloads, then his older chats' page comes: her chat 1 unread — the read note not counted again");
  await say(rhea, "here now");
  await drew.waitFor(`chats.get(realPeersById.get(${rheaId})).msgs.some((m) => m.text === "here now")`, "her new message in");
  await drew.eval(`(closeChat(), softReload(), true)`);
  await drew.waitFor(`hydrated && !reloading && chats.has(realPeersById.get(${rheaId})) && !!chatsMore`, "back, older pages to come", 10000);
  check((await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`)) === 1, "Rhea's: 1 unread (here now)", await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`));
  await drew.eval(`(loadOlderChats(), true)`);
  await drew.waitFor(`!olderLoading && chats.size >= 38`, "the older page in", 10000);
  check((await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`)) === 1, "still 1 after the page (the note read before: not recounted)", await drew.eval(`chats.get(realPeersById.get(${rheaId})).unread`));

  check(drew.errors.length === 0, "no page errors", drew.errors);
});
