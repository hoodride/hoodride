// Deleting the account when the database is slow (twenty-first review,
// 2026-11-19). The deletion closes this phone's own connection FIRST (shut
// down before the erase): the app tried to reconnect, was refused (signed
// out), and reloaded to the sign-in screen — before the deletion's answer
// came. A failed erase ("You've been signed out — sign in again to try
// again") was never read: the person thought the account was gone. A slow
// success skipped the app's own clean-up (the remembered mode stayed on the
// phone). While a deletion is in flight, its answer decides.
import { journey, step, check, server } from "./cdp.mjs";

const openDelete = async (p) => {
  await p.click("btn-account");
  await p.waitFor(`settingsOpen()`, "Settings open");
  await p.click("btn-delete");
  await p.waitFor(`document.getElementById("settings-sheet").classList.contains("confirming") && document.getElementById("delete-yes").offsetParent !== null`, "the confirm step");
  await p.eval(`(() => { const i = document.getElementById("delete-typed"); i.value = "DELETE"; i.dispatchEvent(new Event("input")); return true; })()`);
  // (the connection's pass as old as typing the word takes a person — over
  // 5 s: a refused reconnect then asks the server, and is told "signed out")
  await p.eval(`socketTokenAt = -Infinity, true`);
};

await journey("deleteslow: a slow deletion's answer is the app's to show", async (browser) => {
  step("the erase is slow, then refused: the message is shown — no reload under it");
  const sam = await browser.person("BT-Sam");
  await server("delete_slow fail");
  await openDelete(sam);
  // (a mark on this page: a reload would take it away)
  await sam.eval(`window.__samePage = true, true`);
  await sam.click("delete-yes");
  const msg = await sam.eval(`t("Couldn't delete your account. You've been signed out — sign in again to try again.")`);
  await sam.waitFor(`(document.getElementById("delete-error") || {}).textContent === ${JSON.stringify(msg)}`, "the 'signed out — sign in again' message", 15000);
  check(await sam.eval(`window.__samePage === true`), "the same page: no reload under the message");
  // (still shown a moment later: the refused reconnect doesn't take it away)
  await sam.eval(`new Promise((done) => setTimeout(() => done(true), 2500))`);
  check(await sam.eval(`window.__samePage === true && !document.getElementById("delete-error").classList.contains("hidden")`), "still shown");
  const me = await sam.eval(`fetch("/api/me").then((r) => r.json())`);
  check(me.user === null, "signed out on the server too", me);
  // (twenty-second review: typing re-enabled the button — then a tap did nothing)
  await sam.eval(`(() => { const i = document.getElementById("delete-typed"); i.value = "DELETE!"; i.dispatchEvent(new Event("input")); i.value = "DELETE"; i.dispatchEvent(new Event("input")); return true; })()`);
  check(await sam.eval(`document.getElementById("delete-yes").disabled`), "the delete button stays locked");
  // closing it: on to the sign-in screen
  await sam.click("delete-cancel");
  await sam.waitFor(`typeof state !== "undefined" && !state.realUser && !document.getElementById("auth-buttons").classList.contains("hidden")`, "Cancel: the sign-in screen", 15000);

  // (twenty-second review: the drawer closed while it waited — the message
  // went into a hidden panel and the app stayed on, signed out, stuck)
  step("the drawer closed while the slow deletion waits, then it fails: on to the sign-in screen");
  const bob = await browser.person("BT-Bob");
  await server("delete_slow fail");
  await openDelete(bob);
  await bob.click("delete-yes");
  await bob.eval(`closeSettings(), true`);
  await bob.waitFor(`typeof state !== "undefined" && !state.realUser && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in screen, not stuck", 20000);

  // (twenty-third review: closed and opened again while one waited, a
  // second could start — its quick "signed out" reloaded under the first)
  step("while one deletion waits, a second can't start");
  const cat = await browser.person("BT-Cat");
  // (6 s: closing, opening again and typing must happen while it waits —
  // room for them on a busy machine)
  await server("delete_slow ok 6000");
  await openDelete(cat);
  await cat.click("delete-yes");
  await cat.eval(`closeSettings(), true`);
  await openDelete(cat);
  check(await cat.eval(`document.getElementById("delete-yes").disabled`), "the delete button locked while one waits");
  const asked = await cat.eval(`(() => { let n = 0; const f = window.fetch; window.fetch = (u, o) => (String(u).includes("/api/account/delete") && n++, f(u, o)); deleteAccount(); window.fetch = f; return n; })()`);
  check(asked === 0, "a second deletion isn't sent", asked);
  await cat.waitFor(`typeof state !== "undefined" && !state.realUser && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the first one's answer: signed out, the sign-in screen", 20000);

  // (twenty-fourth review: opened elsewhere while it waited — the "Use here"
  // cover goes up and the answer is never read: the "deleting" mark stayed,
  // the background reloads held back for nothing)
  step("opened elsewhere while a deletion waits: the 'Use here' cover, nothing left marked 'deleting'");
  const dee = await browser.person("BT-Dee");
  await server("delete_slow ok 6000");
  await openDelete(dee);
  await dee.click("delete-yes");
  check(await dee.eval(`deleteInFlight`), "deleting");
  await dee.eval(`onSessionMoved(), true`);
  await dee.waitFor(`!!document.getElementById("session-moved")`, "the 'Use here' cover");
  check(!(await dee.eval(`deleteInFlight`)), "no longer marked 'deleting'");

  step("the erase is slow and succeeds: the app's own clean-up runs (the remembered mode goes)");
  const ann = await browser.person("BT-Ann");
  const annId = await ann.id();
  await server("delete_slow ok");
  await ann.eval(`HoodModeStore.save(window.localStorage, state.realUser.id, "driver"), true`);
  check((await ann.eval(`window.localStorage.getItem("hoodride_mode_${annId}")`)) !== null, "a remembered mode");
  await openDelete(ann);
  await ann.click("delete-yes");
  await ann.waitFor(`typeof state !== "undefined" && !state.realUser && !document.getElementById("auth-buttons").classList.contains("hidden")`, "signed out, the sign-in screen", 20000);
  check((await ann.eval(`window.localStorage.getItem("hoodride_mode_${annId}")`)) === null, "the remembered mode gone from this phone");
});
