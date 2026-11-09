// Light reload (owner, 2026-11-08): "download the minimum until you open a
// chat". A reload brings the chat LIST — each chat as a summary, no message
// texts — and a chat's messages load when it's opened ("Loading…"). What
// arrives while it loads is kept and put in its place; Send waits (it looks
// as always, the text stays). Split from lightreload2.mjs (a journey's time).
import { journey, step, check, server } from "./cdp.mjs";
import { typeText, send, box } from "./app.mjs";

const q = JSON.stringify;

// the page's requests, watched and steered: what /api/state brought;
// /api/chat held before it's even sent (__hold) and let go (__release()),
// or answered with a fake (__fake). Honours the load's time limit (signal).
// Installed again after each page load (p.open)
const wire = (p) =>
  p.eval(`(() => {
    window.__states = [];
    window.__hold = false;
    window.__held = [];
    window.__fake = null;
    window.__banners = [];
    const f = window.fetch.bind(window);
    window.fetch = (u, o) => {
      const url = String(u);
      if (url.startsWith("/api/chat")) {
        if (window.__fake) {
          const { status, body } = window.__fake;
          return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
        }
        if (window.__hold)
          return new Promise((resolve, reject) => {
            if (o && o.signal) o.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            window.__held.push(() => f(u, o).then(resolve, reject));
          });
      }
      const r = f(u, o);
      if (url.startsWith("/api/state")) r.then((x) => x.clone().text()).then((t) => window.__states.push(t), () => {});
      return r;
    };
    window.__release = () => { const h = window.__held; window.__held = []; h.forEach((go) => go()); return h.length; };
    const b = document.getElementById("banner");
    new MutationObserver(() => b.textContent && window.__banners.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);

const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
};
const chatOf = (p, id) => `chats.get(realPeersById.get(${id}))`;
const loaded = (p, id) => p.waitFor(`${chatOf(p, id)} && ${chatOf(p, id)}.loaded === true`, `${p.name}: #${id}'s chat loaded`, 15000);
const row = (p, name) =>
  p.eval(`(() => { const r = [...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === ${q(name)}); return r && { unread: r.querySelector(".unread-dot")?.textContent ?? null, line: r.querySelector(".chat-item-info .muted").textContent }; })()`);
const loadingShown = (p) => p.eval(`!!document.querySelector("#chat-messages .chat-loading") && document.querySelector("#chat-messages .chat-loading").textContent`);
const texts = (p, id) => p.eval(`${chatOf(p, id)}.msgs.map((m) => m.text)`);
const heldCount = (p) => p.eval(`window.__held.length`);

await journey("lightreload: the chat list on reload, a chat's messages when it's opened", async (browser) => {
  step("Ann writes Sam 30 messages; a reload brings his chats with no message text — her line and 30 unread from the summary");
  const sam = await browser.person("BT-Sam");
  const ann = await browser.person("BT-Ann");
  const bo = await browser.person("BT-Bo");
  const [samId, annId, boId] = [await sam.id(), await ann.id(), await bo.id()];
  await wire(sam);
  await server(`many_msgs ${annId} ${samId} 30 ann`);
  await server(`many_msgs ${boId} ${samId} 2 bo`);
  await sam.waitFor(`${chatOf(sam, annId)} && ${chatOf(sam, annId)}.msgs.length === 30`, "heard live first");
  await reload(sam);
  const st = await sam.eval(`window.__states.at(-1)`);
  check(!st.includes('"ann1"') && !st.includes('"ann2"') && !st.includes('"bo1"'), "no message text in the reload", st.slice(0, 400));
  check(st.includes('"preview":"ann30"'), "her last message's preview is");
  check((await sam.eval(`${chatOf(sam, annId)}.loaded`)) === false && (await sam.eval(`${chatOf(sam, annId)}.msgs.length`)) === 0, "her chat: a summary");
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`, "the list");
  check(q(await row(sam, "BT-Ann")) === q({ unread: "30", line: "ann30" }), "Ann's row: 30 unread, 'ann30'", await row(sam, "BT-Ann"));
  check((await sam.eval(`${chatOf(sam, annId)}.unread`)) === 30, "counted");

  step("opening her chat: 'Loading…'; Send does nothing and the text stays; then her messages, the 'New messages' line above the first");
  await sam.eval(`window.__hold = true, true`);
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "the load asked (held)");
  check((await loadingShown(sam)) === "Loading…", "'Loading…'", await loadingShown(sam));
  check(await sam.eval(`!document.getElementById("chat-form").classList.contains("hidden") && document.getElementById("chat-name").textContent === "BT-Ann"`), "her name and the box above it");
  check((await sam.eval(`${chatOf(sam, annId)}.unread`)) === 30, "not read yet");
  await typeText(sam, "hi Ann");
  await send(sam);
  check((await box(sam)) === "hi Ann", "Send did nothing: the text stays", await box(sam));
  check(!(await texts(sam, annId)).includes("hi Ann"), "nothing sent");
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await loaded(sam, annId);
  const all30 = Array.from({ length: 30 }, (_, i) => `ann${i + 1}`);
  check(q(await texts(sam, annId)) === q(all30), "her 30 messages", await texts(sam, annId));
  check((await sam.eval(`chatLineMsg && chatLineMsg.text`)) === "ann1", "the line above the first unread", await sam.eval(`chatLineMsg && chatLineMsg.text`));
  check(await sam.eval(`!!document.querySelector("#chat-messages .chat-line")`), "drawn");
  check((await sam.eval(`${chatOf(sam, annId)}.unread`)) === 0, "read now");
  check((await box(sam)) === "hi Ann", "the text still there", await box(sam));
  await sam.eval(`(document.getElementById("chat-input").value = "", ${chatOf(sam, annId)}.draft = ""), true`);

  step("a message that comes while her chat loads: shown once, counted, no banner over it");
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  await sam.eval(`(window.__hold = true, window.__banners = []), true`);
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "the load asked (held)");
  // sent while the question waits: it comes live AND in the answer
  await server(`many_msgs ${annId} ${samId} 1 late`);
  await sam.waitFor(`${chatOf(sam, annId)}.msgs.some((m) => m.text === "late1")`, "heard live, held");
  check((await loadingShown(sam)) === "Loading…", "still 'Loading…' (not drawn)");
  check((await sam.eval(`${chatOf(sam, annId)}.unread`)) === 1, "counted", await sam.eval(`${chatOf(sam, annId)}.unread`));
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await loaded(sam, annId);
  check(q(await texts(sam, annId)) === q([...all30, "late1"]), "once, in its place", await texts(sam, annId));
  check(!(await sam.eval(`window.__banners`)).some((b) => b.includes("late1")), "no banner (it's the chat on screen)", await sam.eval(`window.__banners`));

  step("a ride note on a chat not opened since the reload: its line in the list, then in its place when the messages come");
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  await sam.eval(`window.__hold = true, true`);
  // (as a ride request brings it: this app's own note, never on the server)
  await sam.eval(`userChannel.trigger("request", { from: { id: ${annId}, name: "BT-Ann", photo: null } }), true`);
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  check((await row(sam, "BT-Ann")).line === "📩 requested a ride", "the note is her line", await row(sam, "BT-Ann"));
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "the load asked (held)");
  await server(`many_msgs ${annId} ${samId} 1 after`);
  await sam.waitFor(`${chatOf(sam, annId)}.msgs.some((m) => m.text === "after1")`, "her next one heard, held");
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await loaded(sam, annId);
  check(q((await texts(sam, annId)).slice(-3)) === q(["late1", "📩 requested a ride", "after1"]), "the note after what it came after", await texts(sam, annId));
  await sam.eval(`(realPeersById.get(${annId}).pending = false), true`);

  step("leaving a chat before it loads: still unread — closing the panel, ‹ to the list, or switching chats");
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  await sam.eval(`window.__hold = true, true`);
  await sam.eval(`openChat(realPeersById.get(${boId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "Bo's load asked (held)");
  await sam.eval(`closeChat(), true`);
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await loaded(sam, boId);
  check((await sam.eval(`${chatOf(sam, boId)}.unread`)) === 2, "panel closed mid-load: Bo's 2 still unread", await sam.eval(`${chatOf(sam, boId)}.unread`));
  await reload(sam);
  await sam.click("btn-chat");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await sam.eval(`window.__hold = true, true`);
  await sam.eval(`openChat(realPeersById.get(${boId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "Bo's load asked (held)");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "‹: the list");
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await loaded(sam, boId);
  await sam.waitFor(`(() => { const r = [...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === "BT-Bo"); return r && r.querySelector(".unread-dot")?.textContent === "2"; })()`, "Bo's row: 2 unread");
  check((await row(sam, "BT-Bo")).line === "bo2", "and his line", await row(sam, "BT-Bo"));
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  await sam.eval(`window.__hold = true, true`);
  await sam.eval(`openChat(realPeersById.get(${boId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "Bo's load asked (held)");
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await sam.waitFor(`window.__held.length === 2`, "Ann's load asked too (held)");
  check((await heldCount(sam)) === 2, "(one load each)");
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await loaded(sam, annId);
  await loaded(sam, boId);
  check(await sam.eval(`state.chatPeer.id === ${annId} && !!document.querySelector("#chat-messages .msg")`), "Ann's chat drawn");
  check((await sam.eval(`${chatOf(sam, boId)}.unread`)) === 2, "switched away mid-load: Bo's still unread");

  step("a chat closed by the server while it loads: gone, and the late answer doesn't bring it back");
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  await sam.eval(`window.__hold = true, true`);
  await sam.eval(`openChat(realPeersById.get(${boId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "Bo's load asked (held)");
  await server(`close_chat ${samId} ${boId}`);
  await sam.waitFor(`!chats.has(realPeersById.get(${boId}))`, "Bo's chat gone");
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await sam.eval(`chats.has(realPeersById.get(${boId}))`)), "not brought back");
  await ann.close();
  await bo.close();
});
