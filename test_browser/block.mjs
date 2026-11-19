// Block (owner, 2026-11-15 — Hoodride.Blocks; HoodBlocks in app.js). Ann
// blocks Bob from his card, after a question. Either way: Bob's car leaves
// Ann's map at once and doesn't come back on a reload; their chat closes —
// for Bob a plain close, never "blocked"; Bob's message gets the ordinary
// "unavailable". "Blocked people" is always at the bottom of Ann's profile
// drawer (owner, 2026-11-18): opening the drawer asks the server nothing;
// the list says "You haven't blocked anyone" when empty and "Couldn't load —
// tap to try again" when it can't load. Unblocking (asked too) brings them
// back to each other.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send, DRAWN } from "./app.mjs";

const q = JSON.stringify;
const shownEl = (p, id) => p.eval(`(() => { const e = document.getElementById(${q(id)}); return !!e && !e.classList.contains("hidden") && e.offsetParent !== null; })()`);
const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
};

await journey("block: blocked from the card — off each other's maps, the chat closed plainly, unblocked from the drawer", async (browser) => {
  step("Bob drives; Ann sees his car and they chat");
  const bob = await browser.person("BT-Bob");
  const ann = await browser.person("BT-Ann");
  const [bobId, annId] = [await bob.id(), await ann.id()];
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");
  await openChatWith(ann, bobId);
  await typeText(ann, "hi Bob");
  await send(ann);
  await bob.waitFor(`chats.has(realPeersById.get(${annId}))`, "Bob has the chat");
  await ann.eval(`closeChat(), true`);

  step("before any block: 'Blocked people' is in Ann's drawer all the same — opening it asks the server nothing");
  await ann.eval(`(() => {
    const f = window.fetch.bind(window);
    window.__blocksCalls = [];
    window.__failBlocks = false;
    window.fetch = (u, o) => {
      if (String(u).startsWith("/api/blocks")) {
        window.__blocksCalls.push(String(u));
        if (window.__failBlocks) return Promise.resolve(new Response("{}", { status: 503 }));
      }
      return f(u, o);
    };
    return true;
  })()`);
  await ann.click("btn-account");
  await ann.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "the drawer open");
  check(await shownEl(ann, "blocked-wrap"), "'Blocked people' there with nobody blocked");
  await new Promise((r) => setTimeout(r, 500));
  check((await ann.eval(`window.__blocksCalls.length`)) === 0, "the drawer opened without asking /api/blocks", await ann.eval(`JSON.stringify(window.__blocksCalls)`));

  step("…the list can't load: said so; a tap tries again — and says nobody's blocked");
  await ann.eval(`window.__failBlocks = true, true`);
  await ann.click("btn-blocked");
  await ann.waitFor(`(document.querySelector("#blocked-list .blocked-more") || {}).textContent === t("Couldn't load — tap to try again")`, "the failure said");
  await ann.eval(`window.__failBlocks = false, document.querySelector("#blocked-list .blocked-more").click(), true`);
  await ann.waitFor(`(document.querySelector("#blocked-list .blocked-empty") || {}).textContent === t("You haven't blocked anyone")`, "'You haven't blocked anyone' on the tap");
  check(!(await ann.eval(`!!document.querySelector("#blocked-list .blocked-more")`)), "the failure line gone");
  await ann.click("blocked-close");
  await ann.eval(`closeSettings(), true`);

  step("Ann taps his car: 'Block' on the card — asked first, then done");
  await ann.eval(`(openMarkerCard(realPeersById.get(${bobId}), "driver"), true)`);
  await ann.waitFor(`!document.getElementById("peer-card").classList.contains("hidden") && !document.getElementById("peer-block").classList.contains("hidden")`, "the card, with Block");
  await ann.click("peer-block");
  await ann.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  check((await ann.eval(`document.getElementById("block-title").textContent`)) === "Block BT-Bob?", "'Block BT-Bob?'", await ann.eval(`document.getElementById("block-title").textContent`));
  await ann.click("block-yes");
  await ann.waitFor(`document.getElementById("block-sheet").classList.contains("hidden")`, "done");
  await ann.waitFor(`document.getElementById("banner").textContent.startsWith("Blocked. To undo it, tap your profile picture at the top left")`, "where to undo it");
  check(await ann.eval(`document.getElementById("peer-card").classList.contains("hidden")`), "the card closed");

  step("…his car leaves her map at once; their chat is gone for both — for Bob a plain close");
  await ann.waitFor(`!(${DRAWN(bobId)})`, "Bob's car off Ann's map", 5000);
  check(!(await ann.eval(`chats.has(realPeersById.get(${bobId}))`)), "Ann: no chat with Bob");
  await bob.waitFor(`!chats.has(realPeersById.get(${annId}))`, "Bob: the chat closed");
  // a neutral line: not "blocked", and not "away" (Ann was here)
  await bob.waitFor(`document.getElementById("banner").textContent === "Chat with BT-Ann ended"`, "Bob: 'Chat with BT-Ann ended'");

  step("Bob writing to Ann: the ordinary 'unavailable'");
  const reply = await bob.eval(`new Promise((ok) => userChannel.push("send_msg", { to: ${annId}, text: "hello?" }).receive("ok", () => ok("ok")).receive("error", (e) => ok(e.reason)).receive("timeout", () => ok("timeout")))`);
  check(reply === "unavailable", "refused as anyone out of reach", reply);

  step("a reload: still not on her map");
  await reload(ann);
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await ann.eval(DRAWN(bobId))), "Bob's car not drawn after the reload");

  step("'Blocked people' at the bottom of Ann's drawer: Bob there; Unblock (asked) — back on each other's maps");
  await ann.click("btn-account");
  await ann.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "the drawer open");
  check(await shownEl(ann, "blocked-wrap"), "'Blocked people' there");
  await ann.click("btn-blocked");
  await ann.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length === 1`, "the list: one person");
  check((await ann.eval(`document.querySelector("#blocked-list .blocked-row strong").textContent`)) === "BT-Bob", "it's Bob");
  await ann.eval(`document.querySelector("#blocked-list .blocked-row button").click(), true`);
  await ann.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  check((await ann.eval(`document.getElementById("block-title").textContent`)) === "Unblock BT-Bob?", "'Unblock BT-Bob?'");
  await ann.click("block-yes");
  await ann.waitFor(`document.querySelector("#blocked-list .blocked-empty")`, "nobody left in the list");
  check(await shownEl(ann, "blocked-wrap"), "'Blocked people' still there with nobody blocked");
  await ann.click("blocked-close");
  await ann.eval(`closeSettings(), true`);
  // at once, no reload — his car is parked (it sends nothing of its own)
  await sees(ann, bobId, "(back at once after the unblock)");
});
