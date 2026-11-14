// A weak signal (server review, 2026-11-13): one bar, a café wifi waiting
// for its login — connected, but nothing gets through. The offline worker
// (sw.js) asked the network first and waited for it with no limit: the
// request neither answered nor failed, and opening the app was a white
// screen for a minute or more. Now the network gets a few seconds
// (NETWORK_WAIT_MS), then the saved copy opens — as it does with no signal.
import { journey, step, check, BASE } from "./cdp.mjs";

// the app itself running: its words loaded, its sign-in screen there
const OPEN = `!window.__before && typeof HoodI18n !== "undefined" && HoodI18n.lang() === "en" && !!document.getElementById("screen-login")`;

await journey("weaksignal: on a connection that passes nothing, the saved app opens within seconds", async (browser) => {
  step("Wes opens Hood Ride once: it's kept for offline");
  const wes = await browser.visitor("BT-Wes");
  await wes.goto(`${BASE}/`);
  await wes.waitFor(`navigator.serviceWorker.ready.then(() => true)`, "the offline copy installed", 20000);
  await wes.goto(`${BASE}/`);
  await wes.waitFor(`!!navigator.serviceWorker.controller`, "the worker in charge", 20000);
  await wes.waitFor(`caches.match("/").then((r) => !!r)`, "the home page saved", 20000);
  await wes.waitFor(OPEN, "the app open");

  try {
    step("his signal drops to one bar: every request takes two minutes");
    // (only the offline copy to go on: the browser's own cache can be gone)
    await wes.clearHttpCache();
    await wes.weakSignal(120_000);
    // (really weak, through the worker too: an address it never keeps hangs)
    const probe = await wes.eval(
      `Promise.race([fetch("/weak-check-" + Date.now()).then((r) => "answered " + r.status, (e) => "failed: " + e.message), new Promise((r) => setTimeout(() => r("hung"), 6000))])`
    );
    check(probe === "hung", "(the worker's own requests hang: a weak signal, not offline)", probe);

    step("he opens the app: the saved copy, within seconds — not a white screen");
    await wes.eval(`(window.__before = true, setTimeout(() => location.assign("/"), 0), true)`);
    const t0 = Date.now();
    await wes.waitFor(OPEN, "the app open on a weak signal", 20000);
    const took = Date.now() - t0;
    check(took < 15000, "opened within 15 s (the network gets 4 s per file)", took);
    console.log(`  (opened in ${took} ms)`);
  } finally {
    await wes.offline(false);
  }

  step("signal back: the app opens from the network as usual");
  await wes.goto(`${BASE}/`);
  await wes.waitFor(OPEN, "the app open");
  await wes.close();
});
