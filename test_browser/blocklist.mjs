// The Blocked people list in pages, and the limit (owner, 2026-11-15). The
// list shows the newest first and loads older ones as it's scrolled (as
// the chat list). At 200 blocked, the next block is refused with "unblock
// someone first" — and a button that opens the list right there.
import { journey, step, check, server } from "./cdp.mjs";
import { goOnline, sees } from "./app.mjs";

const PAGE = 30;
const LIMIT = 200;
const rows = (p) => p.eval(`document.querySelectorAll("#blocked-list .blocked-row").length`);
const reload = async (p) => {
  await p.eval(`softReload(), true`);
  await p.waitFor(`hydrated && !reloading`, `${p.name}: reloaded`);
};

await journey("blocklist: Blocked people in pages; at the limit, 'unblock someone first' opens the list", async (browser) => {
  step("Ann has blocked 35 people; the list: the newest 30, then the rest as it's scrolled");
  const ann = await browser.person("BT-ListAnn");
  const annId = await ann.id();
  await server(`blocks_fill 35 ${annId}`);
  await reload(ann);
  await ann.click("btn-account");
  await ann.waitFor(`document.getElementById("settings-sheet").classList.contains("open") && !document.getElementById("blocked-wrap").classList.contains("hidden")`, "'Blocked people' in the drawer");
  await ann.click("btn-blocked");
  await ann.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length >= ${PAGE}`, "the first page");
  check((await rows(ann)) === PAGE, `${PAGE} first`, await rows(ann));
  check((await ann.eval(`document.querySelector("#blocked-list .blocked-row strong").textContent`)) === "BT-X35", "the newest first");
  await ann.eval(`(() => { const l = document.getElementById("blocked-list"); l.scrollTop = l.scrollHeight; return true; })()`);
  await ann.waitFor(`document.querySelectorAll("#blocked-list .blocked-row").length === 35 && !document.querySelector("#blocked-list .blocked-more")`, "the rest on scroll", 10000);
  const names = await ann.eval(`[...document.querySelectorAll("#blocked-list .blocked-row strong")].map((s) => s.textContent)`);
  check(new Set(names).size === 35 && names.at(-1) === "BT-X1", "each once, the oldest last", names.slice(-3));
  await ann.click("blocked-close");
  await ann.eval(`closeSettings(), true`);

  step(`at ${LIMIT}: blocking one more says 'unblock someone first', with the list a tap away`);
  await server(`blocks_fill ${LIMIT - 35} ${annId} 36`);
  const bob = await browser.person("BT-ListBob");
  const bobId = await bob.id();
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");
  await ann.eval(`(openMarkerCard(realPeersById.get(${bobId}), "driver"), true)`);
  await ann.waitFor(`!document.getElementById("peer-block").classList.contains("hidden")`, "Block on his card");
  await ann.click("peer-block");
  await ann.click("block-yes");
  await ann.waitFor(`!document.getElementById("block-error").classList.contains("hidden")`, "refused");
  check(
    (await ann.eval(`document.getElementById("block-error").textContent`)) === "You've blocked the most people you can — unblock someone first",
    "'unblock someone first'"
  );
  check(!(await ann.eval(`document.getElementById("block-list-open").classList.contains("hidden")`)), "with 'Blocked people' right there");
  await ann.click("block-list-open");
  await ann.waitFor(`!document.getElementById("blocked-sheet").classList.contains("hidden") && document.querySelectorAll("#blocked-list .blocked-row").length >= ${PAGE}`, "the list opened");
});
