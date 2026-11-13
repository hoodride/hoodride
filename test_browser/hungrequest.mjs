// A request that never gets an answer (owner, 2026-11-13; client review):
// on a phone a connection can die silently — wifi to mobile data, a lift —
// and a request with no time limit waited for ever. Opening the app sat on
// its loading screen (the retries waited on the first try), Save stayed
// greyed out, a reconnect never caught up. Now every request the app makes
// gives up after a time limit (apiFetch, API_TIMEOUT_MS) and fails like any
// other network failure: the existing "try again" paths take over.
import { journey, step, check, BASE } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// until `pred()` holds, at most `ms` (node side: the held request counts)
async function until(pred, ms, what) {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`FAILED: ${what} — not within ${ms} ms`);
    await sleep(100);
  }
  return Date.now() - t0;
}

await journey("hungrequest: a request with no answer gives up and the app recovers by itself", async (browser) => {
  step("opening the app while its first request hangs: it gives up, tries again by itself, and opens once answered");
  const p = await browser.person("BT-Hang");
  // (the app's own limit; before it had one, the 15 s it was given)
  const limit = await p.eval(`typeof API_TIMEOUT_MS === "number" ? API_TIMEOUT_MS : 15000`);
  check(limit >= 10_000 && limit <= 20_000, "(the time limit: 10–20 s)", limit);
  const boot = await p.holdRequests("*/api/state*");
  await p.goto(`${BASE}/`);
  await until(() => boot.count() >= 1, 10_000, "the app asked for its data");
  const retried = await until(() => boot.count() >= 2, limit + 15_000, "it gave up on the hung request and asked again");
  check(retried >= limit - 1_000, "(not before the time limit)", { retried, limit });
  await boot.release();
  await p.waitFor(`typeof liveNow === "function" && liveNow() && !!state.realUser`, "the app open", 30_000);

  step("Save on the car form while saving hangs: the button comes back, with a message");
  const save = await p.holdRequests("*/api/car");
  await p.eval(`(openCarSheet(), true)`);
  await p.waitFor(`carSheetOpen()`, "the car form");
  await p.eval(`(() => { document.getElementById("car-color").value = "Blue"; document.getElementById("car-make").value = "Honda"; document.getElementById("car-model").value = "Civic"; document.getElementById("car-save").click(); return true; })()`);
  await p.waitFor(`document.getElementById("car-save").disabled`, "Save greyed out while it saves");
  await p.waitFor(`!document.getElementById("car-save").disabled`, "Save back", limit + 10_000);
  const msg = await p.eval(`document.getElementById("car-error").classList.contains("hidden") ? "" : document.getElementById("car-error").textContent`);
  check(msg === "Couldn't reach Hood Ride — check your connection and try again.", "the message: couldn't reach, try again", msg);
  check(await p.eval(`carSheetOpen()`), "the form still open, what was typed kept");
  await save.release();
  await p.eval(`(document.getElementById("car-save").click(), true)`);
  await p.waitFor(`!carSheetOpen() && state.myCar && state.myCar.model === "Civic"`, "saved on the second try", 15_000);

  step("a reconnect's catch-up while its request hangs: given up after the limit, tried again, caught up once answered");
  const catchUp = await p.holdRequests("*/api/state*");
  await p.eval(`(softReload(), true)`);
  await p.waitFor(`reloading === true`, "catching up");
  await until(() => catchUp.count() >= 2, limit + 20_000, "it gave up on the hung catch-up and tried again");
  await catchUp.release();
  await p.waitFor(`reloading === false && hydrated && liveNow()`, "caught up", 30_000);
});
