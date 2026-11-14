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
  window.turnstile = {
    render: (_el, opts) => ((window.__ts = opts), "w1"),
    execute: () => (${JSON.stringify(answer)} === "pass" ? window.__ts.callback("XXXX.DUMMY.TOKEN.XXXX") : window.__ts["error-callback"]()),
    remove: () => {},
  };
  return true;
})()`;

await journey("turnstile: sign-in passes Cloudflare's check first; without it, no start", async (browser) => {
  await server("turnstile_on");

  step("Tia taps Continue with Google: the check passes, the server checks it, she's sent to Google");
  const tia = await browser.visitor("BT-Tia");
  const google = await tia.holdRequests("https://accounts.google.com/*");
  await tia.goto(`${BASE}/`);
  await tia.waitFor(`!document.getElementById("btn-google").closest(".hidden")`, "the sign-in button", 15000);
  await tia.eval(REAL_SITE("pass"));
  await tia.click("btn-google");
  await tia.waitFor(`window.__ts && window.__ts.action === "signin"`, "the check ran, for sign-in");
  const t0 = Date.now();
  while (google.count() < 1 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
  check(google.count() >= 1, "on to Google (the server allowed the start)");
  await tia.close();

  step("a script skipping the check: the start sends it back to the sign-in screen, not to Google");
  const bot = await browser.visitor("BT-Bot");
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
