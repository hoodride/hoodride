// Opening the app: the map (crash review, 2026-11-14).
//  * The map used to be made only once the connection was set up — its pass
//    fetched first, up to 15 s on a weak signal: a blank grey map all that
//    time, and a ◎ tap meanwhile lost the blue dot for good. The map needs
//    no connection: it's made first.
//  * A browser that can't draw the map (WebGL off or blocked: hardware
//    acceleration off, some privacy browsers, old Android) threw inside the
//    map's setup: nothing after it ran — a blank screen, no message, the
//    same on every reload, while the server saw the person online. Now it
//    says so, plainly, and doesn't connect.
import { journey, step, check } from "./cdp.mjs";

await journey("mapstart: the map before the connection; no WebGL says so", async (browser) => {
  step("Mo opens the app while its connection pass hangs: the map is there anyway");
  const mo = await browser.person("BT-Mo");
  const pass = await mo.holdRequests("*/api/socket_token*");
  await mo.reload();
  await mo.waitFor(`typeof map !== "undefined" && !!map && !!document.querySelector("#map canvas")`, "the map, before the connection", 10000);
  check(await mo.eval(`!socket || !socket.isConnected()`), "(the connection still waiting)");
  await pass.release();
  await mo.waitFor(`typeof liveNow === "function" && liveNow()`, "then connected", 20000);
  await mo.close();

  step("Gil's browser can't draw the map (no WebGL): told so, plainly — and not connected");
  const gil = await browser.person("BT-Gil");
  await gil.onEveryPage(`(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...a) {
      return /webgl/i.test(String(type)) ? null : get.call(this, type, ...a);
    };
  })()`);
  await gil.reload();
  await gil.waitFor(`!!document.getElementById("map-unavailable")`, "the 'can't draw the map' message", 15000);
  const text = await gil.eval(`document.getElementById("map-unavailable").textContent`);
  check(text.includes("can't show the map"), "it says why", text);
  // (give a connection the time it would take)
  await gil.eval(`new Promise((r) => setTimeout(() => r(true), 1500))`);
  check(await gil.eval(`!socket || !socket.isConnected()`), "not connected: never 'online' while unable to use the app");
  await gil.close();
});
