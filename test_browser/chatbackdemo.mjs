// ‹ Back and drafts in the demo (owner, 2026-11-07): the same rules as the
// real app (chatback.mjs) — ‹ opens the list, a chat opened from the map
// stays in it while the window is open, what's typed stays with its chat.
// Both directions: a rider writing to a pretend car, a driver to the
// pretend ✋. Another pretend person's message comes as the demo's own do
// (receiveMsg).
import { journey, step, check, BASE } from "./cdp.mjs";
import { typeText, box } from "./app.mjs";

const where = (p) =>
  p.eval(`(() => document.getElementById("chat").classList.contains("hidden") ? "closed" : state.chatView === "list" ? "list" : "chat:" + state.chatPeer.name)()`);
const row = (p, name) =>
  p.eval(`(() => { const r = [...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === ${JSON.stringify(name)}); return r ? { unread: r.querySelector(".unread-dot")?.textContent ?? null, draft: r.querySelector(".chat-draft")?.textContent ?? null, line: r.querySelector(".chat-item-info .muted").textContent } : null; })()`);
const tapRow = (p, name) =>
  p.eval(`([...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === ${JSON.stringify(name)}).click(), true)`);
const backBadge = (p) =>
  p.eval(`(() => { const b = document.getElementById("chat-back"), c = document.getElementById("chat-back-count"); return b.classList.contains("hidden") ? "no ‹" : c.classList.contains("hidden") ? "‹" : "‹ " + c.textContent; })()`);
// tap them on the map → Message (the card's own button)
async function message(p, peerExpr, what) {
  await p.eval(`(openPeerCard(${peerExpr}), true)`);
  await p.click("btn-msg");
  await p.waitFor(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer === ${peerExpr}`, `${what}'s chat open`);
}

await journey("chatbackdemo: in the demo, ‹ opens the list; drafts stay with their chat", async (browser) => {
  const dee = await browser.visitor("BT-Dee");
  await dee.goto(`${BASE}/?demo=1`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 1`, "the demo's pretend drivers", 15000);
  const [first, other] = await dee.eval(`[drivers[0].name, drivers[1].name]`);

  step("rider: Dee taps a pretend car → Message; another pretend driver writes: ‹ 1");
  await message(dee, "drivers[0]", first);
  await dee.eval(`(receiveMsg(drivers[1], "need a ride?"), true)`);
  check((await where(dee)) === `chat:${first}`, `still in ${first}'s chat`, await where(dee));
  check((await backBadge(dee)) === "‹ 1", "‹ 1", await backBadge(dee));

  step("‹ → the list: the empty chat is in it, and the other with 1 unread");
  await dee.click("chat-back");
  check((await where(dee)) === "list", "the list", await where(dee));
  check(JSON.stringify(await row(dee, first)) === JSON.stringify({ unread: null, draft: null, line: "" }), `${first}'s empty chat`, await row(dee, first));
  check((await row(dee, other))?.unread === "1", `${other}: 1 unread`, await row(dee, other));

  step("typed, not sent: Draft in the list, kept after ✕; cleared: ✕ drops it");
  await tapRow(dee, first);
  await typeText(dee, "on my way");
  await dee.click("chat-back");
  check(JSON.stringify(await row(dee, first)) === JSON.stringify({ unread: null, draft: "Draft", line: "Draft on my way" }), "Draft on my way", await row(dee, first));
  await tapRow(dee, other);
  check((await box(dee)) === "", `${other}'s box is empty`, await box(dee));
  await dee.click("chat-close");
  check(await dee.eval(`chats.has(drivers[0])`), "✕ with a draft: kept");
  await dee.click("btn-chat");
  await tapRow(dee, first);
  check((await box(dee)) === "on my way", "the text is back", await box(dee));
  await typeText(dee, "");
  await dee.click("chat-close");
  check(!(await dee.eval(`chats.has(drivers[0])`)), "nothing typed: ✕ drops it");

  step("driver: online, Dee taps the pretend ✋ → Message; a pretend rider writes: ‹ 1 → the list");
  await dee.click("btn-mode");
  await dee.waitFor(`state.mode === "driver"`, "Drive mode");
  await dee.click("btn-online");
  await dee.waitFor(`state.online && !!mockHand && mockHand.visible`, "the pretend ✋");
  const hand = await dee.eval(`mockHand.name`);
  await message(dee, "mockHand", hand);
  await dee.eval(`(window.__asker = { name: "Aaliyah", kind: "rider", pending: true, pos: state.me, photo: HoodAvatar.url("Aaliyah"), visible: false }, receiveMsg(__asker, "can you grab me?"), true)`);
  check((await where(dee)) === `chat:${hand}`, `still in ${hand}'s chat`, await where(dee));
  check((await backBadge(dee)) === "‹ 1", "‹ 1", await backBadge(dee));
  await dee.click("chat-back");
  check((await where(dee)) === "list", "the list (not Aaliyah's chat)", await where(dee));
  check(JSON.stringify(await row(dee, hand)) === JSON.stringify({ unread: null, draft: null, line: "" }), `${hand}'s empty chat`, await row(dee, hand));
  check((await row(dee, "Aaliyah"))?.unread === "1", "Aaliyah: 1 unread", await row(dee, "Aaliyah"));
  await dee.click("chat-close");
  check(!(await dee.eval(`chats.has(mockHand)`)), "✕: the empty chat dropped");
  check(await dee.eval(`!socket`), "nothing sent to the server");

  // signed in, the demo ALSO connected as you, and the server's first
  // answer closed a card tapped right after load (owner, 2026-11-07: 1 tap
  // in 3). The demo is the pretend world for everyone: never the account
  step("signed in, the demo is still only pretend: no account, no server; a card tapped at load stays open");
  const sid = await browser.person("BT-Sid");
  await sid.goto(`${BASE}/?demo=1`);
  await sid.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.some((d) => d.visible)`, "the pretend cars", 15000);
  await sid.eval(`(drivers.find((d) => d.visible).marker.getElement().click(), true)`);
  check(await sid.eval(`!document.getElementById("peer-card").classList.contains("hidden")`), "the card opens");
  // past when the server's answer used to come (it closed the card ~0.2 s in)
  await new Promise((r) => setTimeout(r, 2500));
  const after = await sid.eval(`({
    card: !document.getElementById("peer-card").classList.contains("hidden"),
    socket: !!socket,
    account: !!state.realUser,
    asked: performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.startsWith("/api/") || p.startsWith("/socket")),
  })`);
  check(JSON.stringify(after) === JSON.stringify({ card: true, socket: false, account: false, asked: [] }), "card still open; no connection, no account, nothing asked of the server", after);
  await sid.eval(`(closePeerCard(), true)`);
});
