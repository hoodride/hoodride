// One of the app's files doesn't arrive (owner, 2026-11-19: on one phone
// sendfilter.js never did — ridepos.js and app.js then crashed on it, and
// the app sat broken with no word). The standard fix (HoodLoadCheck,
// loadcheck.js — Vite's "reload on a failed load", with the counted guard
// the write-ups settled on): the page reloads by itself, at most twice in
// 5 minutes; still missing, it says so, with "Try again", and tries again
// by itself when the phone is back online. One report names the file — the
// crashes after it are its echo, not reported.
import { journey, step, check, BASE, server } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MESSAGE = "Couldn't load Hood Ride — check your connection";
const OLD = "Your browser is too old for Hood Ride — update it to continue";

// the message showing: its words (null: not showing)
const shown = `(() => { const el = document.getElementById("load-fail"); const p = el && el.querySelector(".load-fail-text"); return el && !el.hidden && getComputedStyle(el).display !== "none" && p && !p.hidden && getComputedStyle(p).display !== "none" ? p.textContent.trim() : null; })()`;
// the "too old" form showing: its words (null: not showing)
const oldShown = `(() => { const el = document.getElementById("load-fail"); const p = el && el.querySelector(".load-fail-old"); return el && !el.hidden && p && !p.hidden && getComputedStyle(p).display !== "none" ? p.textContent.trim() : null; })()`;
// the app's own start, all there: the sign-in screen, its files loaded
// (and the page fully read — the check, its last script, has run: the
// sign-in screen shows from the page's own markup, before it; read too
// early, the reload count wasn't cleared yet — sixteenth round)
const started = `document.readyState !== "loading" && typeof HoodSendFilter === "object" && typeof maplibregl === "object" && typeof HoodErrors === "object" && document.getElementById("screen-login").classList.contains("active")`;

// how this page was opened: "reload" when the page reloaded itself (the
// first load, cut short by the reload, never fires its load event — a count
// of loads misses it)
const reloaded = `performance.getEntriesByType("navigation")[0].type`;

// the crashes a missing file sets off in the files after it: expected
// (they happen — only their REPORT is held back); anything else counts
function cascadeOnly(p, pattern) {
  const other = p.errors.filter((e) => !pattern.test(e));
  check(other.length === 0, `${p.name}: only the missing file's echo among the page errors`, other);
  p.errors.splice(0);
}

await journey("loadfail: a file that didn't arrive — reloaded, or said so, never a dead screen", async (browser) => {
  step("Ann opens the app; sendfilter.js fails ONCE: the page reloads by itself and starts");
  const ann = await browser.visitor("BT-LoadAnn");
  const once = await ann.failRequests("*sendfilter.js*", 1);
  await ann.goto(`${BASE}/`);
  await ann.waitFor(started, "the app started after one reload", 15000);
  check(once.count() === 1, "the file failed once", once.count());
  check((await ann.eval(reloaded)) === "reload", "the page loaded again by itself", await ann.eval(reloaded));
  check((await ann.eval(shown)) === null, "no message: it worked");
  check((await ann.eval(`sessionStorage.getItem("hoodride-load-retry")`)) === null, "the reload count cleared once it started");
  cascadeOnly(ann, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)/);
  await server("client_error_has client error: LoadError: file missing: sendfilter.js");
  step("…the report names the file; the crashes after it aren't reported");
  await server("client_error_none HoodSendFilter is not defined");
  await server("client_error_none HEARTBEAT_MS");
  await once.stop();
  await ann.close();

  step("Bob's sendfilter.js never arrives: two reloads, then the message — and no more reloads");
  await server("client_error_share_reset");
  const bob = await browser.visitor("BT-LoadBob");
  const never = await bob.failRequests("*sendfilter.js*");
  await bob.goto(`${BASE}/`);
  await bob.waitFor(shown, "the message", 15000);
  check((await bob.eval(shown)) === MESSAGE, "it says what's wrong", await bob.eval(shown));
  check((await bob.eval(`document.getElementById("load-fail-retry").textContent.trim()`)) === "Try again", "with Try again");
  await sleep(2500);
  // (each reload after a fetch afresh — past the cache: 1 + 2×2)
  check(never.count() === 5, "asked 5 times (the first, then 2× afresh + reload), then stopped", never.count());
  // one report per load: his try 1 (and Ann's, above), try 2, then gave up
  await server("client_error_count 2 file missing: sendfilter.js (reloading, try 1)");
  await server("client_error_count 1 file missing: sendfilter.js (reloading, try 2)");
  await server("client_error_count 1 file missing: sendfilter.js (gave up)");

  step("he taps Try again, still nothing: the message again at once — not two more reloads");
  const before = bob.loads();
  await bob.eval(`document.getElementById("load-fail-retry").click(), true`);
  for (let i = 0; i < 100 && bob.loads() === before; i++) await sleep(50);
  check(bob.loads() > before, "the page loaded again");
  await bob.waitFor(shown, "the message again", 15000);
  await sleep(2000);
  // (the file fetched afresh first, then the page — a broken copy kept by
  // the browser is replaced; eighth review)
  check(never.count() === 7, "one more try — his: afresh, then the page", never.count());

  step("…the phone says it's back online, still nothing: afresh and once more, then the message");
  await bob.eval(`window.dispatchEvent(new Event("online")), true`);
  for (let i = 0; i < 100 && never.count() < 9; i++) await sleep(50);
  await bob.waitFor(shown, "the message again", 15000);
  await sleep(1500);
  check(never.count() === 9, "afresh, then the page", never.count());

  step("his phone comes back online (the file arrives now): it tries again by itself and starts");
  await never.stop();
  await bob.eval(`window.dispatchEvent(new Event("online")), true`);
  await bob.waitFor(started, "the app started", 15000);
  check((await bob.eval(shown)) === null, "the message gone");
  cascadeOnly(bob, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)/);
  await bob.close();

  step("Cat's browser can't keep the count (no storage): no reload at all — the message at once");
  await server("client_error_share_reset");
  const cat = await browser.visitor("BT-LoadCat");
  await cat.onEveryPage(`Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("journey: no storage"); } })`);
  const catFails = await cat.failRequests("*sendfilter.js*");
  await cat.goto(`${BASE}/`);
  await cat.waitFor(shown, "the message", 15000);
  await sleep(2000);
  check(catFails.count() === 1, "never reloaded", catFails.count());
  await catFails.stop();
  cascadeOnly(cat, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)|journey: no storage/);
  await cat.close();

  step("Dee reads Japanese: the message is in Japanese (the page's own words, no script needed)");
  await server("client_error_share_reset");
  const dee = await browser.visitor("BT-LoadDee");
  const deeFails = await dee.failRequests("*sendfilter.js*");
  await dee.goto(`${BASE}/ja`);
  await dee.waitFor(shown, "the message", 15000);
  const ja = await dee.eval(shown);
  check(ja.includes("Hood Ride") && !ja.includes("Couldn't") && !ja.includes("Try again"), "in Japanese", ja);
  await deeFails.stop();
  cascadeOnly(dee, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)/);
  await dee.close();

  // (second review) a language's words only hand the app its words: without
  // them it works, in English — it used to; never the message over it
  step("Gus reads Japanese and its words never arrive: two tries, then the app in English — no message, reports still on");
  await server("client_error_share_reset");
  const gus = await browser.visitor("BT-LoadGus");
  const gusFails = await gus.failRequests("*i18n-ja.js*");
  await gus.goto(`${BASE}/ja`);
  await gus.waitFor(`${started} && performance.getEntriesByType("navigation")[0].type === "reload"`, "the app started after the reloads", 15000);
  await sleep(2000);
  check(gusFails.count() === 5, "asked 5 times (the first, then 2× afresh + reload), then on", gusFails.count());
  check((await gus.eval(shown)) === null, "no message over the working app");
  check((await gus.eval(`document.querySelector("#screen-login .tagline").textContent.trim()`)) === "Rides from your neighborhood", "in English");
  // (its "18" scrubbed like any number of 2+ digits: i<n>n-ja.js)
  await server("client_error_count 1 file missing: i<n>n-ja.js (gave up: runs without it)");
  await gus.eval(`(setTimeout(() => { throw new Error("journey gus boom"); }, 0), true)`);
  for (let i = 0; i < 50 && !gus.errors.some((e) => e.includes("journey gus boom")); i++) await sleep(100);
  await gus.expectError("journey gus boom");
  await server("client_error_has journey gus boom");
  await gusFails.stop();
  check(gus.errors.length === 0, "no other page errors", gus.errors);
  await gus.close();

  step("the files before the reporter count too: the map's library, and the reporter itself, each failing once");
  for (const [file, who] of [
    ["maplibre-gl.js", "BT-LoadEve"],
    ["errors.js", "BT-LoadFay"],
  ]) {
    await server("client_error_share_reset");
    const p = await browser.visitor(who);
    const f = await p.failRequests(`*/${file}*`, 1);
    await p.goto(`${BASE}/`);
    await p.waitFor(started, `${file}: the app started after one reload`, 15000);
    check(f.count() === 1 && (await p.eval(reloaded)) === "reload", `${file}: failed once, reloaded`, [f.count(), await p.eval(reloaded)]);
    await f.stop();
    check(p.errors.length === 0, `${file}: no page errors`, p.errors);
    await server(`client_error_has file missing: ${file} (reloading, try 1)`);
    await p.close();
  }

  // (third review) the files the app runs without: never the message over
  // it, never its reports muted
  step("Ivy's load check itself never arrives: the app works, and its reports still go");
  await server("client_error_share_reset");
  const ivy = await browser.visitor("BT-LoadIvy");
  const ivyFails = await ivy.failRequests("*loadcheck.js*");
  await ivy.goto(`${BASE}/`);
  await ivy.waitFor(started, "the app started", 15000);
  check((await ivy.eval(shown)) === null, "no message");
  await ivy.eval(`(setTimeout(() => { throw new Error("journey ivy boom"); }, 0), true)`);
  for (let i = 0; i < 50 && !ivy.errors.some((e) => e.includes("journey ivy boom")); i++) await sleep(100);
  await ivy.expectError("journey ivy boom");
  await server("client_error_has journey ivy boom");
  await ivyFails.stop();
  check(ivy.errors.length === 0, "no other page errors", ivy.errors);
  await ivy.close();

  step("Hal's blocker stops the reporter (errors.js) every time: two tries, then the app runs — no message");
  const hal = await browser.visitor("BT-LoadHal");
  const halFails = await hal.failRequests("*/errors.js*");
  await hal.goto(`${BASE}/`);
  await hal.waitFor(
    `typeof HoodSendFilter === "object" && document.getElementById("screen-login").classList.contains("active") && performance.getEntriesByType("navigation")[0].type === "reload"`,
    "the app started after the reloads",
    15000
  );
  await sleep(2000);
  check(halFails.count() === 5, "asked 5 times (the first, then 2× afresh + reload), then on", halFails.count());
  check((await hal.eval(shown)) === null, "no message over the working app");
  await halFails.stop();
  check(hal.errors.length === 0, "no page errors", hal.errors);
  await hal.close();

  // (owner, 2026-11-19) a file that ARRIVES but broken: empty, or cut off
  // mid-way — not a failed load, yet as missing; our own bug in a file is
  // NOT (a crash: reported, no reload, never "check your connection")
  const real = await (await fetch(`${BASE}/sendfilter.js`)).text();
  for (const [what, body, who] of [
    ["empty", "", "BT-LoadJo"],
    // (cut where code is open — after a "){" past half-way: "Unexpected end
    // of input" in every browser. Cut mid-string, Chrome's words are an old
    // Chrome's for 60_000 too: reported as a crash, never reloaded)
    ["cut off half-way", real.slice(0, real.indexOf("){", Math.floor(real.length / 2)) + 2), "BT-LoadKim"],
  ]) {
    step(`sendfilter.js arrives ${what}, once: the page reloads by itself and starts`);
    await server("client_error_share_reset");
    const p = await browser.visitor(who);
    const broken = await p.answerWith("*sendfilter.js*", body, 1);
    await p.goto(`${BASE}/`);
    await p.waitFor(started, `${what}: the app started after one reload`, 15000);
    check(broken.count() === 1 && (await p.eval(reloaded)) === "reload", `${what}: arrived broken once, reloaded`, [broken.count(), await p.eval(reloaded)]);
    check((await p.eval(shown)) === null, `${what}: no message`);
    await server("client_error_has file missing: sendfilter.js (reloading, try 1)");
    await broken.stop();
    cascadeOnly(p, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)|SyntaxError: Unexpected end of input/);
    await p.close();
  }
  // (seventh review) a broken copy that came as a full answer with our
  // year-long cache: a plain reload takes it from the browser's cache again
  // — the check fetches the missing files afresh first
  step("Quin's sendfilter.js arrives empty ONCE, kept a year by the browser: fetched afresh, and the app starts");
  await server("client_error_share_reset");
  const quin = await browser.visitor("BT-LoadQuin");
  const kept = await quin.answerWith("*sendfilter.js*", "", 1, [{ name: "cache-control", value: "public, max-age=31536000, immutable" }]);
  await quin.goto(`${BASE}/`);
  await quin.waitFor(started, "the app started after one reload", 15000);
  check((await quin.eval(shown)) === null, "no message");
  await kept.stop();
  cascadeOnly(quin, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)/);
  await quin.close();

  // (thirteenth review) a browser between our minimum and Chrome 86 /
  // Safari 14 has no Element.replaceChildren: every file arrives and reads
  // fine — the app must still start (i18n.js adds it)
  step("Uma's browser has no replaceChildren (Chrome 80–85, Safari 13.1): the app still starts");
  const uma = await browser.visitor("BT-LoadUma");
  await uma.onEveryPage(`delete Element.prototype.replaceChildren`);
  // signed in: the whole app, its buttons drawn (setIconText)…
  await uma.signIn();
  check((await uma.eval(shown)) === null && (await uma.eval(oldShown)) === null, "no message");
  // …and in Japanese: the page's words put in (HoodI18n.translatePage)
  await uma.goto(`${BASE}/ja`);
  await uma.waitFor(`typeof liveNow === "function" && liveNow() && document.documentElement.lang === "ja"`, "the app, in Japanese", 15000);
  check(uma.errors.length === 0, "no page errors", uma.errors);
  await uma.close();

  // (seventeenth review) app.js isn't one wrapped function: cut between two
  // statements, what arrived still reads — no error at all; its last line
  // never ran. A cut that still parses (checked here, by Node's own parser)
  step("Lou's app.js arrives cut between two statements, once: no error — still reloaded, and starts");
  await server("client_error_share_reset");
  const { Script } = await import("node:vm");
  const appSrc = await (await fetch(`${BASE}/app.js`)).text();
  let cutAt = -1;
  for (let i = appSrc.indexOf("function openSettings") + 2000; i < appSrc.length - 500 && cutAt < 0; i++) {
    if (appSrc[i - 1] !== "}") continue;
    try {
      new Script(appSrc.slice(0, i));
      cutAt = i;
    } catch (_) {}
  }
  check(cutAt > 0, "a cut of app.js that still parses");
  const lou = await browser.visitor("BT-LoadLou");
  const cutApp = await lou.answerWith("*/app.js*", appSrc.slice(0, cutAt), 1);
  await lou.goto(`${BASE}/`);
  await lou.waitFor(`${started} && typeof HoodAppRan !== "undefined"`, "the app started after one reload", 15000);
  check(cutApp.count() === 1 && (await lou.eval(reloaded)) === "reload", "cut once, reloaded", [cutApp.count(), await lou.eval(reloaded)]);
  await server("client_error_has file missing: app.js (reloading, try 1)");
  await cutApp.stop();
  check(lou.errors.length === 0, "no page errors", lou.errors);
  await lou.close();

  // (eighteenth review) Firefox with cookies blocked: reading the offline
  // worker throws — app.js must still reach its last line
  step("Vic's browser throws on navigator.serviceWorker (Firefox, cookies blocked): the app starts, no message");
  const vic = await browser.visitor("BT-LoadVic");
  await vic.onEveryPage(`Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } })`);
  await vic.goto(`${BASE}/`);
  await vic.waitFor(`${started} && typeof HoodAppRan !== "undefined"`, "the app started", 15000);
  await sleep(1500);
  check((await vic.eval(shown)) === null && (await vic.eval(oldShown)) === null, "no message");
  check((await vic.eval(reloaded)) === "navigate", "never reloaded");
  check(vic.errors.length === 0, "no page errors", vic.errors);
  await vic.close();

  step("Pat's sendfilter.js arrives empty EVERY time: two reloads, then the message");
  await server("client_error_share_reset");
  const pat = await browser.visitor("BT-LoadPat");
  const empty = await pat.answerWith("*sendfilter.js*", "");
  await pat.goto(`${BASE}/`);
  await pat.waitFor(shown, "the message", 15000);
  await sleep(1500);
  check(empty.count() === 5, "asked 5 times, then the message", empty.count());
  await empty.stop();
  cascadeOnly(pat, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)/);
  await pat.close();

  step("…the cut-off file's own syntax error isn't reported, nor what the empty one set off (their echo)");
  await server("client_error_none SyntaxError");
  await server("client_error_none HEARTBEAT_MS");
  await server("client_error_none HoodSendFilter is not defined");

  // (fifth review; owner, 2026-11-19) a syntax error that isn't the file
  // ending early: a browser too old for our code — "too old", no reload,
  // no Try again; ONE report naming it (the crashes after: its echo)
  step("Nora's browser can't read sendfilter.js (a syntax error mid-file): 'too old' — no reload, one report");
  await server("client_error_share_reset");
  const nora = await browser.visitor("BT-LoadNora");
  // (an old Chrome — older than our build target: eleventh review)
  await nora.asDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36" });
  const old = await nora.answerWith("*sendfilter.js*", `var journeyOld = ;`);
  await nora.goto(`${BASE}/`);
  await nora.waitFor(oldShown, "the 'too old' message", 15000);
  await sleep(2000);
  check(old.count() === 1 && (await nora.eval(reloaded)) === "navigate", "never reloaded", [old.count(), await nora.eval(reloaded)]);
  check((await nora.eval(oldShown)) === OLD, "it says the browser is too old", await nora.eval(oldShown));
  check((await nora.eval(shown)) === null, "not 'check your connection'");
  check(!(await nora.eval(`!document.getElementById("load-fail-retry").hidden && getComputedStyle(document.getElementById("load-fail-retry")).display !== "none"`)), "no Try again");
  await server("client_error_count 1 client error: OldBrowser: can't read: sendfilter.js (Unexpected token ';')");
  await server("client_error_none client error: SyntaxError: Unexpected token");
  await old.stop();
  cascadeOnly(nora, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)|SyntaxError: Unexpected token ';'/);
  await nora.close();

  // (eleventh review) a CURRENT browser that can't read a file: it arrived
  // cut off (Chrome's words for half the cuts look like an old browser's)
  // — reloaded like any cut, never "too old"
  step("Kay's current Chrome gets sendfilter.js cut off mid-string, once: reloaded and starts — never 'too old'");
  await server("client_error_share_reset");
  const kay = await browser.visitor("BT-LoadKay");
  // (inside a string that opens past half-way — `("…`: Chrome says "Invalid
  // or unexpected token", as an old Chrome does for 60_000)
  const opening = real.indexOf('("', Math.floor(real.length / 2));
  const midString = await kay.answerWith("*sendfilter.js*", real.slice(0, opening + 4), 1);
  await kay.goto(`${BASE}/`);
  await kay.waitFor(started, "the app started after one reload", 15000);
  check((await kay.eval(reloaded)) === "reload", "reloaded", await kay.eval(reloaded));
  check((await kay.eval(oldShown)) === null && (await kay.eval(shown)) === null, "no message");
  await server("client_error_none OldBrowser: can't read: sendfilter.js (Invalid");
  await midString.stop();
  cascadeOnly(kay, /HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)|SyntaxError: Invalid or unexpected token/);
  await kay.close();

  step("Lee's sendfilter.js has a BUG (it crashes as it runs): reported — no reload, no message");
  await server("client_error_share_reset");
  const lee = await browser.visitor("BT-LoadLee");
  const bug = await lee.answerWith("*sendfilter.js*", `throw new TypeError("journey sendfilter bug");`);
  await lee.goto(`${BASE}/`);
  for (let i = 0; i < 50 && !lee.errors.some((e) => e.includes("journey sendfilter bug")); i++) await sleep(100);
  await sleep(2000);
  check(bug.count() === 1, "loaded once — never reloaded", bug.count());
  check((await lee.eval(reloaded)) === "navigate", "not reloaded", await lee.eval(reloaded));
  check((await lee.eval(shown)) === null, "no 'check your connection' for our bug");
  await server("client_error_has journey sendfilter bug");
  await bug.stop();
  cascadeOnly(lee, /journey sendfilter bug|HoodSendFilter is not defined|\(reading 'HEARTBEAT_MS'\)/);
  await lee.close();

  step("Mia's demo (?demo=1): a file missing — the same reloads and message, but no report (the demo talks to no server)");
  await server("client_error_share_reset");
  const mia = await browser.visitor("BT-LoadMia");
  const miaFails = await mia.failRequests("*/viewport.js*");
  await mia.goto(`${BASE}/?demo=1`);
  await mia.waitFor(shown, "the message", 15000);
  await sleep(1000);
  check(miaFails.count() === 5, "asked 5 times, then the message", miaFails.count());
  await server("client_error_none file missing: viewport.js");
  await miaFails.stop();
  // (none today: the demo uses viewport.js only once the map moves — but
  // should it ever at start, its one echo is allowed, nothing else;
  // twenty-second review's note, owner 2026-11-19)
  cascadeOnly(mia, /HoodViewport is not defined/);
  await mia.close();

  // (nineteenth review's side note; owner, 2026-11-19: fix it) the same
  // browser — reading navigator.serviceWorker throws — must still pick up
  // a new version: reloaded into it, or offered it. LAST: the server now
  // runs another build
  step("Wes's browser throws on navigator.serviceWorker: a new version deployed — he still gets it");
  const wes = await browser.visitor("BT-LoadWes");
  await wes.onEveryPage(`Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } })`);
  await wes.signIn();
  await server("new_build");
  await wes.drop();
  await wes.restore();
  await wes.waitFor(`serverBuild === "journey-new-build" && liveNow()`, "the app knows of the new version", 15000);
  // stepped out (hidden, nothing in progress): the quiet update reload —
  // reloadForUpdate, which reads navigator.serviceWorker
  await wes.eval(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
  await wes.waitFor(`typeof LOADED_BUILD !== "undefined" && LOADED_BUILD === "journey-new-build" && liveNow()`, "reloaded into the new version", 15000);
  check(wes.errors.length === 0, "no page errors", wes.errors);
  await wes.close();
});
