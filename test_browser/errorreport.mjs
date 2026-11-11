// Error reports from phones (owner, 2026-11-10): an unexpected error in the
// app reaches the server as ONE report — what broke, never who: a long
// number (an id, a position) and an email in the error's message arrive
// replaced; and the app goes on working.
import { journey, step, check, BASE } from "./cdp.mjs";
import { server } from "./cdp.mjs";

await journey("errorreport: an unexpected error reaches the server — scrubbed, once", async (browser) => {
  step("Rita's app hits an unexpected error (with an id and an email in its message)");
  const rita = await browser.person("BT-Rita");
  await rita.eval(`(setTimeout(() => { throw new Error("journey boom for 6620271782574400 bob@mail.com"); }, 0), true)`);
  // (the page's error comes in a moment after: waited for, not a fixed time)
  for (let i = 0; i < 50 && !rita.errors.some((e) => e.includes("journey boom")); i++) await new Promise((r) => setTimeout(r, 100));
  await rita.expectError("journey boom");

  step("the server has it: what broke, the screen, the version — no id, no email");
  await server("client_error_has journey boom for <n> <email>");

  step("the same error again: not sent twice; the app still works");
  await rita.eval(`(setTimeout(() => { throw new Error("journey boom for 6620271782574400 bob@mail.com"); }, 0), true)`);
  for (let i = 0; i < 50 && !rita.errors.some((e) => e.includes("journey boom")); i++) await new Promise((r) => setTimeout(r, 100));
  await rita.expectError("journey boom");
  check(await rita.eval(`typeof openSettings === "function" && !!document.getElementById("map")`), "the app still works");

  // (mutation kills, 2026-11-10) what's reported, and what isn't
  step("an uncaught TypeError arrives as a TypeError; a rejected promise is reported too; a network failure is not");
  const waitErr = async (p, text) => {
    for (let i = 0; i < 50 && !p.errors.some((e) => e.includes(text)); i++) await new Promise((r) => setTimeout(r, 100));
    await p.expectError(text);
  };
  await rita.eval(`(setTimeout(() => { throw new TypeError("journey type boom"); }, 0), true)`);
  await waitErr(rita, "journey type boom");
  await server("client_error_has client error: TypeError: journey type boom");
  await rita.eval(`(Promise.reject(new Error("journey rejected boom")), true)`);
  await waitErr(rita, "journey rejected boom");
  await server("client_error_has journey rejected boom");
  await rita.eval(`(setTimeout(() => { throw new TypeError("Failed to fetch"); }, 0), true)`);
  await waitErr(rita, "Failed to fetch");
  await server("client_error_none Failed to fetch");

  step("the demo sends no report (it talks to no server)");
  const demo = await browser.visitor("BT-DemoErr");
  await demo.goto(`${BASE}/?demo=1`);
  await demo.waitFor(`typeof DEMO !== "undefined" && DEMO === true`, "the demo running", 15000);
  await demo.eval(`(setTimeout(() => { throw new Error("journey demo boom"); }, 0), true)`);
  await waitErr(demo, "journey demo boom");
  await server("client_error_none journey demo boom");
  await demo.close();

  // the crash that matters most: the app dying while it STARTS — errors.js
  // (loaded first) catches it, the app's first lines hand it on; the
  // reporter is made right there (owner, 2026-11-10: a start-up crash was
  // never sent — the reporter was made 2,800 lines later)
  step("an app that crashes while starting: the crash still reaches the server");
  const boot = await browser.visitor("BT-Boot");
  // (only the app's OWN file finds it broken: the others read it as usual)
  await boot.onEveryPage(`(() => { let real; Object.defineProperty(window, "HoodI18n", { configurable: true, set(v) { real = v; }, get() { const s = document.currentScript; if (s && s.src.includes("/app.js")) throw new Error("boot boom at start"); return real; } }); })()`);
  await boot.goto(`${BASE}/`);
  for (let i = 0; i < 50 && !boot.errors.some((e) => e.includes("boot boom")); i++) await new Promise((r) => setTimeout(r, 100));
  await boot.expectError("boot boom at start");
  await server("client_error_has boot boom at start");
  await boot.close();
});
