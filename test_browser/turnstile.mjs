// Cloudflare Turnstile on sign-in (review 2026-11-14; HoodTurnstile in the
// page, HoodrideWeb.Turnstile on the server). On this machine "Continue
// with Google" signs in by name (HoodSession.loginRoute) — here the page is
// told it's on the real site, so the real path runs: the check (a stand-in
// for Cloudflare's widget — nothing leaves the machine), its pass POSTed,
// the server's check, then off to Google (stopped there).
import { journey, step, check, BASE, server } from "./cdp.mjs";

// the page as on the real site with Turnstile on: the site key the server
// stamps, Google's route, and a stand-in widget answering `answer`
const REAL_SITE = (answer) => `(() => {
  if (!document.querySelector('meta[name="hoodride-turnstile"]')) {
    const m = document.createElement("meta");
    m.name = "hoodride-turnstile";
    m.content = "1x00000000000000000000AA";
    document.head.appendChild(m);
  }
  HoodSession.loginRoute = () => "google";
  // (as the real widget does even when invisible: it puts its own box,
  // about 65 px tall, into the container while it checks)
  const top = () => document.getElementById("btn-google").getBoundingClientRect().top;
  window.__buttonTop = top();
  window.turnstile = {
    render: (el, opts) => {
      window.__ts = opts;
      const w = document.createElement("div");
      w.style.height = "65px";
      el.appendChild(w);
      window.__widget = w;
      return "w1";
    },
    // (a pass waits for the test's go: it sends the page off to Google, and
    // a page read made mid-navigation was never answered — the journey hung,
    // 2026-11-14)
    execute: () =>
      setTimeout(() => {
        window.__buttonTopDuring = top();
        if (${JSON.stringify(answer)} !== "pass") return window.__ts["error-callback"]();
        const go = () => (window.__go ? window.__ts.callback("XXXX.DUMMY.TOKEN.XXXX") : setTimeout(go, 50));
        go();
      }, 300),
    remove: () => window.__widget && window.__widget.remove(),
  };
  return true;
})()`;

await journey("turnstile: sign-in passes Cloudflare's check first; without it, no start", async (browser) => {
  await server("turnstile_on");

  step("Tia taps Continue with Google: the check passes, the server checks it, she's sent to Google");
  const tia = await browser.visitor("BT-Tia");
  // (Cloudflare's real script held too: the page fetches it as the sign-in
  // screen shows, and — let through — it would replace the stand-in mid-test)
  const held = await tia.holdRequests(["https://accounts.google.com/*", "https://challenges.cloudflare.com/*"]);
  const google = { count: () => held.count("https://accounts.google.com/") };
  await tia.goto(`${BASE}/`);
  await tia.waitFor(`!document.getElementById("btn-google").closest(".hidden")`, "the sign-in button", 15000);
  // fetched ahead, before any tap (owner, 2026-11-14: sign-in got slower)
  const t1 = Date.now();
  while (held.count("https://challenges.cloudflare.com/") < 1 && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100));
  check(held.count("https://challenges.cloudflare.com/") >= 1, "Cloudflare's script fetched as the sign-in screen shows, before the tap");
  await tia.eval(REAL_SITE("pass"));
  await tia.click("btn-google");
  await tia.waitFor(`window.__ts && window.__ts.action === "signin"`, "the check ran, for sign-in");
  // nothing on the screen moves while it checks (owner, 2026-11-14: the
  // button jumped down, then back up)
  await tia.waitFor(`window.__buttonTopDuring !== undefined`, "the check under way");
  const tops = await tia.eval(`[window.__buttonTop, window.__buttonTopDuring]`);
  check(tops[0] === tops[1], "the sign-in button stays put while the check runs", tops);
  await tia.eval(`window.__go = true`);
  const t0 = Date.now();
  while (google.count() < 1 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
  check(google.count() >= 1, "on to Google (the server allowed the start)");
  await tia.close();

  step("a script skipping the check: the start sends it back to the sign-in screen, not to Google");
  const bot = await browser.visitor("BT-Bot");
  await bot.holdRequests("https://challenges.cloudflare.com/*");
  await bot.goto(`${BASE}/`);
  const landed = await bot.eval(`fetch("/auth/google").then((r) => new URL(r.url).pathname, (e) => "error: " + e.message)`);
  check(landed === "/", "a start without a passed check goes back to /", landed);

  step("Cloudflare's check can't run in her browser (a blocker): she's told what to do");
  await bot.eval(REAL_SITE("error"));
  await bot.click("btn-google");
  await bot.waitFor(
    `document.querySelector("#btn-google span").textContent.includes("challenges.cloudflare.com")`,
    "the message: allow challenges.cloudflare.com, or another browser"
  );
  await bot.close();
  await server("turnstile_off");
});
