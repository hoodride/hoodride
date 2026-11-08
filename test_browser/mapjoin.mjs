// The map follows the device chosen last (server review, 2026-11-08). The
// server keeps one map per account; it used to be "the latest map request
// wins" — so an OLDER device's map request arriving a moment late shut down
// the NEWER device's map: cars froze, no hands, nothing said why, until a
// reload (the app never asks for the map again by itself). Now the older
// device's late request is refused, and the newer device keeps its map.
import { journey, step, check, server } from "./cdp.mjs";

const mapLive = `typeof worldChannel !== "undefined" && !!worldChannel && worldChannel.state === "joined"`;
const toldMoved = `!!document.getElementById("session-moved")`;

await journey("mapjoin: an older device's late map request never shuts down the newer one's map", async (browser) => {
  step("Pat's app is open, the map connected");
  const pat = await browser.person("BT-Pat");
  await pat.waitFor(mapLive, "the map connected", 15000);
  const id = await pat.id();

  step("another device of Pat's connects (the laptop), then Pat reopens the app here: this page is now the newest");
  await server(`older_device ${id}`);
  await pat.open();
  await pat.waitFor(mapLive, "the map connected again", 15000);
  check(!(await pat.eval(toldMoved)), "this page isn't told 'opened on another device'");

  step("the laptop's map request arrives late: refused — Pat's map stays connected");
  // (the server answers "ok" only if the laptop's request was refused)
  await server("older_device_refused world");
  // (a moment for a shut-down map to reach the page)
  await pat.eval(`new Promise((done) => setTimeout(() => done(true), 700))`);
  check(await pat.eval(mapLive), "Pat's map is still connected", await pat.eval(`worldChannel && worldChannel.state`));
  check(!(await pat.eval(toldMoved)), "and Pat isn't told 'opened on another device'");
});
