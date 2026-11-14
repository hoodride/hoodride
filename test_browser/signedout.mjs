// Sign-in with tokens (owner, 2026-11-08). Signed out on ANOTHER device
// ("Sign out" is on all your devices): this one goes to the sign-in screen
// by itself, in seconds — its connection closed, its reconnect refused, a
// fresh pass refused (the sign-in is gone), the page reloads to the sign-in
// screen. Before, a pass made during a sign-out stayed valid for a day.
import { journey, step, check, server } from "./cdp.mjs";

const signInShown = `document.getElementById("screen-login").classList.contains("active")`;

await journey("signedout: signed out on another device → this one shows the sign-in screen", async (browser) => {
  step("Sid's app is open and connected");
  const sid = await browser.person("BT-Sid");
  const id = await sid.id();
  // (more than 5 s after its pass was fetched: the first failed reconnect asks at once)
  await sid.eval(`new Promise((done) => setTimeout(() => done(true), 5500))`);

  // what this phone keeps for him: his block (a rough home or work area) and
  // a Google refresh due — the Sign out button clears both; so must this
  await sid.eval(`(localStorage.setItem("hoodride_spot_${id}", "892a1072c63ffff"), localStorage.setItem("hoodride_google_refresh_due", "1"), true)`);

  step("Sid signs out on another device: this one goes to the sign-in screen by itself");
  await server(`sign_out_everywhere ${id}`);
  await sid.waitFor(signInShown, "the sign-in screen", 20000);
  // nothing of his left on this phone (leftovers review, 2026-11-13)
  // (the sign-in screen shows before the app has looked: waited for)
  const mine = `Object.keys(localStorage).filter((k) => k.startsWith("hoodride_spot_") || k.startsWith("hoodride_google_refresh"))`;
  await sid.waitFor(`!document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in buttons");
  await sid.waitFor(`${mine}.length === 0`, "his block and Google refresh note gone from this phone").catch(async (e) => {
    check(false, "his block and Google refresh note are gone from this phone", await sid.eval(mine));
    throw e;
  });
  check(!(await sid.eval(`typeof state !== "undefined" && !!state.realUser && typeof liveNow === "function" && liveNow()`)), "not connected any more");
  check((await sid.eval(`fetch("/api/me").then((r) => r.json()).then((b) => b.user)`)) === null, "the server: not signed in");
});
