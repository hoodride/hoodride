// Light reload (owner, 2026-11-08), part 2 (split from lightreload.mjs: a
// journey's time): reconnects while a chat loads or is open, a load that
// fails (Try again), a 404 that isn't Hood Ride's own, a refused message on
// a chat back as a summary, a ride starting with a chat already there, and
// a full-size chat (50 × ~20 KB) on a slow connection.
import { journey, step, check, server } from "./cdp.mjs";
import { typeText, send, box } from "./app.mjs";

const q = JSON.stringify;

// the page's /api/chat, steered: held before it's even sent (__hold, then
// __release()), or answered with a fake (__fake). Honours the load's time
// limit (its signal)
const wire = (p) =>
  p.eval(`(() => {
    window.__hold = false;
    window.__held = [];
    window.__fake = null;
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
      return f(u, o);
    };
    window.__release = () => { const h = window.__held; window.__held = []; h.forEach((go) => go()); return h.length; };
    return true;
  })()`);

const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
};
const chatOf = (id) => `chats.get(realPeersById.get(${id}))`;
const loaded = (p, id, ms = 15000) => p.waitFor(`${chatOf(id)} && ${chatOf(id)}.loaded === true`, `${p.name}: #${id}'s chat loaded`, ms);
const texts = (p, id) => p.eval(`${chatOf(id)}.msgs.map((m) => m.text)`);
const note = (p) => p.eval(`(() => { const n = document.querySelector("#chat-messages .chat-loading"); return n ? n.textContent : null; })()`);

await journey("lightreload2: reconnects, failures, a refused message, a ride, a big chat", async (browser) => {
  const sam = await browser.person("BT-Sam");
  const ann = await browser.person("BT-Ann");
  const [samId, annId] = [await sam.id(), await ann.id()];
  await wire(sam);
  await server(`many_msgs ${annId} ${samId} 18 a`);
  await sam.waitFor(`${chatOf(annId)} && ${chatOf(annId)}.msgs.length === 18`, "heard live first");

  step("a reconnect while her chat on screen is still loading: it loads (in full, with the reconnect), the line in place, read");
  await reload(sam);
  await sam.eval(`window.__hold = true, true`);
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await sam.waitFor(`window.__held.length === 1`, "the load asked (held)");
  await reload(sam);
  await loaded(sam, annId);
  check(await sam.eval(`state.chatPeer.id === ${annId} && !document.querySelector("#chat-messages .chat-loading") && document.querySelectorAll("#chat-messages .msg").length === 18`), "drawn, not 'Loading…'");
  check((await sam.eval(`chatLineMsg && chatLineMsg.text`)) === "a1", "the line above the first unread", await sam.eval(`chatLineMsg && chatLineMsg.text`));
  check((await sam.eval(`${chatOf(annId)}.unread`)) === 0, "read");
  // the old load's answer comes now: for a chat that's gone (dropped)
  await sam.eval(`window.__hold = false, window.__release(), true`);
  await new Promise((r) => setTimeout(r, 1000));
  check((await texts(sam, annId)).length === 18, "the late answer dropped: nothing twice", (await texts(sam, annId)).length);

  step("a reconnect with her chat open and loaded: it stays loaded — no 'Loading…' flash; on the list, the list stays");
  await reload(sam);
  check(await sam.eval(`${chatOf(annId)}.loaded === true && !document.querySelector("#chat-messages .chat-loading") && state.chatView === "msgs"`), "loaded, drawn");
  await sam.click("chat-back");
  await sam.waitFor(`state.chatView === "list"`, "the list");
  await reload(sam);
  check(await sam.eval(`state.chatView === "list" && !document.getElementById("chat").classList.contains("hidden")`), "still the list");
  check((await sam.eval(`${chatOf(annId)}.loaded`)) === false, "her chat: a summary again (not on screen)");

  step("the load fails (busy, a server error): 'Couldn't load messages'; Send still does nothing; Try again loads it");
  for (const status of [429, 500]) {
    await sam.eval(`window.__fake = { status: ${status}, body: { error: "x" } }, true`);
    await sam.eval(`openChat(realPeersById.get(${annId})), true`);
    await sam.waitFor(`${chatOf(annId)}.failed === true`, `${status}: failed`);
    check((await note(sam)) === "Couldn't load messages — try againTry again", `${status}: why, and Try again`, await note(sam));
    await typeText(sam, "still here?");
    await send(sam);
    check((await box(sam)) === "still here?", `${status}: Send did nothing, the text stays`);
    await sam.eval(`window.__fake = null, true`);
    await sam.click("chatRetry");
    await loaded(sam, annId);
    check((await texts(sam, annId)).length === 18, `${status}: loaded after Try again`);
    await sam.eval(`(document.getElementById("chat-input").value = "", ${chatOf(annId)}.draft = "", closeChat()), true`);
    await reload(sam);
  }

  step("a 404 that isn't Hood Ride's own 'none' (an older server's catch-all): a failure to try again — the chat isn't closed");
  await sam.eval(`window.__fake = { status: 404, body: { error: "not_found" } }, true`);
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await sam.waitFor(`${chatOf(annId)}.failed === true`, "failed");
  check(await sam.eval(`chats.has(realPeersById.get(${annId})) && state.chatPeer.id === ${annId}`), "her chat still there");
  await sam.eval(`window.__fake = null, true`);
  await sam.click("chatRetry");
  await loaded(sam, annId);

  step("a refused message comes back after a reload made its chat a summary: the text back as a draft, the chat in its place");
  // Sam's next message's answer held in the page, then a refusal let go
  await sam.eval(`(() => {
    window.__heldErr = null;
    const push = userChannel.push.bind(userChannel);
    userChannel.push = (ev, ...rest) => {
      const p = push(ev, ...rest);
      if (ev !== "send_msg") return p;
      const rcv = p.receive.bind(p);
      p.receive = (status, cb) => (status === "error" ? ((window.__heldErr = cb), p) : status === "ok" ? p : rcv(status, cb));
      return p;
    };
    return true;
  })()`);
  await typeText(sam, "never mind");
  await send(sam);
  await sam.eval(`closeChat(), true`);
  await reload(sam);
  check((await sam.eval(`${chatOf(annId)}.loaded`)) === false, "(a summary now)");
  const before = await sam.eval(`({ at: ${chatOf(annId)}.lastAt, id: ${chatOf(annId)}.lastId })`);
  await sam.eval(`window.__heldErr({ reason: "rate_limited" }), true`);
  const after = await sam.eval(`({ at: ${chatOf(annId)}.lastAt, id: ${chatOf(annId)}.lastId, draft: ${chatOf(annId)}.draft })`);
  check(after.draft === "never mind", "the text back as her chat's draft", after);
  check(after.at === before.at && after.id === before.id, "the chat's place: its last message's, as before", { before, after });
  await sam.eval(`(${chatOf(annId)}.draft = ""), true`);

  step("a ride starts with Ann, their chat already there as a summary: it loads when opened");
  await server(`start_ride ${samId} ${annId}`);
  // (Ann starts where Sam is: "connected" turns "arrived" at once — either
  // is in the ride; waiting for "connected" alone could miss it)
  await sam.waitFor(`state.ride && ["connected", "arrived"].includes(state.ride.status)`, "Sam in the ride");
  check((await sam.eval(`${chatOf(annId)}.loaded`)) === false, "(still a summary)");
  await sam.eval(`openChat(realPeersById.get(${annId})), true`);
  await loaded(sam, annId);
  check((await texts(sam, annId)).includes("a18"), "her messages");
  await sam.click("btn-endride");
  await sam.waitFor(`!state.ride`, "the ride over");
  await sam.eval(`closeChat(), true`);

  // (a chat now keeps at most 64 KB of text, newest first — the chat fix,
  // 2026-11-12; it was 50 × 20 KB, about 1 MB, the size this step was for)
  step("50 messages of ~20 KB each: only the newest that fit in a chat's 64 KB come back — on a slow connection (~200 KB/s), never 'Couldn't load'");
  await server(`big_msgs ${annId} ${samId} 50`);
  await sam.waitFor(`${chatOf(annId)}.msgs.length >= 50`, "heard live", 30000);
  await reload(sam);
  await sam.eval(`performance.clearResourceTimings(), true`);
  try {
    await sam.throttle(204800);
    await sam.eval(`openChat(realPeersById.get(${annId})), true`);
    await loaded(sam, annId, 30000);
  } finally {
    await sam.offline(false);
  }
  check(!(await sam.eval(`${chatOf(annId)}.failed`)), "never failed");
  const got = await sam.eval(`(() => { const e = performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/chat")).at(-1); return e ? { size: e.transferSize, ms: e.responseEnd - e.requestStart } : null; })()`);
  const size = got && got.size;
  // (bytes, as the server counts them: an emoji pair is 11 bytes, 5 in .length)
  const kept = await sam.eval(`${chatOf(annId)}.msgs.reduce((n, m) => n + new TextEncoder().encode(m.text).length, 0)`);
  check(kept > 40_000 && kept <= 65_536, "the most a chat keeps came back: over 40 KB, at most 64 KB", kept);
  check((await texts(sam, annId)).length <= 3, "only the newest few of the 50", (await texts(sam, annId)).length);
  // …and the connection really was slow: it took about as long as ~200 KB/s
  // needs (the slowing proven to have worked, not assumed)
  check(got.ms >= (size / 204800) * 1000 * 0.7, "it came at the slow speed (the slowing really on)", got);
  await ann.close();
});
