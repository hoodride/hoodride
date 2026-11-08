// Requests that change something come from Hood Ride's own pages only
// (server review, 2026-11-08 — HoodrideWeb.CrossOrigin). Before, only the
// sign-in cookie's SameSite setting stood between another site and "sign
// out", "delete account", "agree to the Terms", "save car". A real browser,
// signed in to Hood Ride, opens a page that ISN'T Hood Ride's and tries to
// sign out from there: refused by the server (the browser itself says the
// request comes from another site), and still signed in.
import { journey, step, check, server, BASE } from "./cdp.mjs";

const connected = `typeof liveNow === "function" && liveNow() && !!state.realUser`;

await journey("crosssite: another site can't sign you out", async (browser) => {
  step("Cruz is signed in to Hood Ride");
  const cruz = await browser.person("BT-Cruz");

  step("he opens a page that isn't Hood Ride's; its hidden form tries to sign him out of Hood Ride");
  await cruz.goto("about:blank");
  // the classic attack: a form posting to the other site (a form can be
  // sent from anywhere — the browser says it comes from another site)
  await cruz.eval(`(() => {
    const f = document.createElement("form");
    f.method = "POST";
    f.enctype = "text/plain";
    f.action = ${JSON.stringify(BASE + "/api/logout")};
    const i = document.createElement("input");
    i.name = '{"a":"';
    i.value = '"}';
    f.appendChild(i);
    document.body.appendChild(f);
    f.submit();
    return true;
  })()`);
  await cruz.waitFor(`!!document.body && document.body.innerText.includes("cross_site")`, "the server's answer: refused", 15000);
  await server("cross_site_refused");

  step("back on Hood Ride: still signed in");
  await cruz.open();
  check(await cruz.eval(connected), "connected");
  check((await cruz.eval(`fetch("/api/me").then((r) => r.json()).then((b) => !!b.user)`)) === true, "the server: still signed in");
});
