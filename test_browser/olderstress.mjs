// Page 2 of the chat list, asked for again and again (2026-11-24): two
// journeys once failed "page 2 held — got 0" (chatreload's direct
// loadOlderChats(), chatolder's scroll to the list's end), causes unknown —
// page2-hold mystery. Each round: a reload back to page 1, then page 2
// asked for the way one of them asks (alternating), held; the first miss
// stops with everything: every loadOlderChats() call and what its guard saw,
// every page-2 fetch the app made, the list's scroll and its "Loading older
// chats…" row, and the browser's own network trace.
import { journey, step, check, server } from "./cdp.mjs";

// short in the gate (~50 rounds); longer on purpose, to hunt:
// OLDERSTRESS_MS=110000 mix test test/browser --only journey:olderstress
// (the journey's limit is 170 s, setup included)
const ROUNDS_FOR_MS = Math.min(Number(process.env.OLDERSTRESS_MS) || 20000, 120000);

await journey("olderstress: page 2 of the chat list asked for, round after round — always asked, always held", async (browser) => {
  step("Una: 35 chats; round after round: a reload, then page 2 — by a direct call, or by scrolling the list to its end");
  const una = await browser.person("BT-OsUna");
  const unaId = await una.id();
  await server(`chat_crowd 35 ${unaId}`);
  await una.eval(`softReload(), true`);
  await una.waitFor(`hydrated && !reloading && chats.size === 30 && !!chatsMore`, "30 loaded, more to come");
  // every loadOlderChats() call (the scroll watcher's too: a top-level
  // function, its callers find it by name) and every page-2 fetch
  await una.eval(`(() => {
    window.__calls = []; window.__asks = [];
    const t0 = performance.now(), at = () => Math.round(performance.now() - t0);
    window.__at = at;
    const orig = loadOlderChats;
    window.loadOlderChats = function () {
      window.__calls.push({ at: at(), more: !!chatsMore, olderLoading, demo: DEMO, reloading, hydrated });
      return orig.apply(this, arguments);
    };
    const f = window.fetch;
    window.fetch = (u, o) => { if (String(u).includes("/api/chats?before=")) window.__asks.push(at()); return f(u, o); };
    return true;
  })()`);

  const started = Date.now();
  let rounds = 0;
  const kinds = { direct: 0, scroll: 0 };
  while (Date.now() - started < ROUNDS_FOR_MS) {
    const kind = rounds % 2 === 0 ? "direct" : "scroll";
    rounds++;
    await una.eval(`(window.__calls = [], window.__asks = [], window.__mark = window.__at(), true)`);
    const held = await una.holdResponses("*/api/chats?before=*");
    if (kind === "direct") {
      await una.eval(`loadOlderChats(), true`);
    } else {
      await una.eval(`(document.getElementById("btn-chat").click(), true)`);
      await una.waitFor(`document.querySelectorAll("#chat-messages .chat-item").length >= 30`, "the list drawn");
      await una.eval(`(() => { const b = document.getElementById("chat-messages"); b.scrollTop = b.scrollHeight; return true; })()`);
    }
    await held.arrived();
    if (held.count() !== 1) {
      const why = await una.eval(`(() => {
        const b = document.getElementById("chat-messages"), row = document.querySelector("#chat-messages .chat-more");
        const br = b && b.getBoundingClientRect(), rr = row && row.getBoundingClientRect();
        return {
          now: window.__at(), mark: window.__mark, calls: window.__calls, asks: window.__asks,
          more: chatsMore, olderLoading, olderFailed, reloading, hydrated, chats: chats.size,
          chatView: state.chatView, listHidden: document.getElementById("chat").classList.contains("hidden"),
          box: b && { top: Math.round(br.top), bottom: Math.round(br.bottom), scrollTop: Math.round(b.scrollTop), scrollHeight: b.scrollHeight, clientHeight: b.clientHeight },
          row: row ? { text: row.textContent, top: Math.round(rr.top), bottom: Math.round(rr.bottom) } : null,
          visibility: document.visibilityState,
          done: performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/chats?before=")).slice(-3).map((e) => ({ at: Math.round(e.startTime), took: Math.round(e.duration) })),
        };
      })()`);
      check(false, `round ${rounds} (${kind}): page 2 held`, { held: held.count(), why, trace: held.trace() });
    }
    // the wrapper saw the scroll watcher's call too (else its log proves nothing)
    if (kind === "scroll") check((await una.eval(`window.__calls.length`)) > 0, `round ${rounds}: the scroll's call logged`);
    kinds[kind]++;
    await held.release();
    await una.waitFor(`chats.size === 35 && !olderLoading`, `round ${rounds}: page 2 arrived`, 10000);
    if (kind === "scroll") await una.eval(`(closeChat(), true)`);
    await una.eval(`softReload(), true`);
    await una.waitFor(`hydrated && !reloading && chats.size === 30 && !!chatsMore && !olderLoading`, `round ${rounds}: back to page 1`, 10000);
  }
  // the wrapper saw the scroll watcher's calls too (else the log proves nothing)
  console.log(`  rounds: ${rounds} (${kinds.direct} direct, ${kinds.scroll} by scrolling) — every page 2 asked and held`);
  check(kinds.scroll > 0 && kinds.direct > 0, "both kinds ran", kinds);
  check(una.errors.length === 0, "no page errors", una.errors);
  await una.close();
});
