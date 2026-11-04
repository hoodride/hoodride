// Offline: nothing pretends to work while Hood Ride can't be reached
// ("Reconnecting…", ✋ / Go online / Drive-Ride refused, nothing changes on
// screen), and each works once the connection is back (owner, 2026-10-30).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, bannerIs, dropAndWait, restoreAndWait, fill, ink, ring, YELLOW, DARK, WHITE, showsIcon } from "./app.mjs";

const CANT = "Can't reach Hood Ride — try again";

await journey("offline: refused while disconnected, working once back", async (browser) => {
  step("Rita (rider) and Dan (driver, online) sign in");
  const rita = await browser.person("BT-Rita");
  const dan = await browser.person("BT-Dan");
  await goOnline(dan);

  step("Rita's connection drops: 'Reconnecting to Hood Ride…'");
  await dropAndWait(rita);

  step("✋ while disconnected: refused, not raised");
  await rita.click("btn-hand");
  await bannerIs(rita, CANT);
  check((await rita.eval("state.handRaised")) === false, "✋ stays down");

  step("back: ✋ goes up");
  await restoreAndWait(rita);
  check((await fill(rita, "btn-hand")) === DARK, "✋ Need a ride is dark (the yellow hand shows on it)", await fill(rita, "btn-hand"));
  check((await ink(rita, "btn-hand")) === WHITE, "… with white words", await ink(rita, "btn-hand"));
  check(!(await ring(rita, "btn-hand")), "… and no ring");
  await rita.click("btn-hand");
  await rita.waitFor("state.handRaised", "✋ up");
  check((await fill(rita, "btn-hand")) === DARK, "Looking for a ride… is dark", await fill(rita, "btn-hand"));
  check((await ink(rita, "btn-hand")) === YELLOW, "… with yellow words", await ink(rita, "btn-hand"));
  check(await ring(rita, "btn-hand"), "… and a yellow ring: you're waiting", await rita.eval(`getComputedStyle(document.getElementById("btn-hand")).boxShadow`));
  await bannerIs(rita, "✋ Nearby drivers can see you need a ride");
  // the ✋ is the hand picture (icons.js), on the button and in the banner
  check(await showsIcon(rita, "#btn-hand", "hand.svg"), "the button: the hand picture");
  check(await showsIcon(rita, "#banner", "hand.svg"), "the banner: the hand picture");

  step("Dan sees Rita's ✋ (the server has it)");
  const ritaId = await rita.id();
  await dan.waitFor(`realEntries.has(${ritaId})`, "Dan sees the ✋", 15000);

  step("dropped again: lowering ✋ and switching to Drive are refused");
  await dropAndWait(rita);
  await rita.click("btn-hand");
  await bannerIs(rita, CANT);
  check((await rita.eval("state.handRaised")) === true, "✋ stays up");
  await rita.click("btn-mode");
  check((await rita.eval("state.mode")) === "rider", "still a rider");

  step("back: ✋ comes down");
  await restoreAndWait(rita);
  await rita.click("btn-hand");
  await rita.waitFor("!state.handRaised", "✋ down");

  step("Dan's connection drops: going offline is refused, still online");
  await dropAndWait(dan);
  await dan.click("btn-online");
  await bannerIs(dan, CANT);
  check((await dan.eval("state.online")) === true, "Dan stays online");

  step("back: Dan goes offline");
  await restoreAndWait(dan);
  await dan.click("btn-online");
  await dan.waitFor("!state.online", "Dan offline");

  step("dropped: going online is refused, still offline");
  await dropAndWait(dan);
  await dan.click("btn-online");
  await bannerIs(dan, CANT);
  check((await dan.eval("state.online")) === false, "Dan stays offline");
  await restoreAndWait(dan);

  // the second half of the fix: the tap is made while connected and waits
  // for GPS; the connection drops; then the reading comes — refused, and
  // the message must survive the banner redraw that follows the reading
  step("Gail opens the app with no GPS signal yet; taps ✋: waiting for a reading");
  const gail = await browser.person("BT-Gail", null);
  await gail.click("btn-hand");
  await gail.waitFor("loc.pending.hand", "the tap waits for GPS");

  step("her connection drops; then the reading comes: refused, and the message stays");
  await dropAndWait(gail);
  await gail.locate(HOME);
  await gail.waitFor("!loc.pending.hand", "the reading completed the tap");
  await bannerIs(gail, CANT);
  await new Promise((r) => setTimeout(r, 1000));
  check((await gail.banner()) === CANT, "the message is still there a second later", await gail.banner());
  check((await gail.eval("state.handRaised")) === false, "✋ stays down");
  await restoreAndWait(gail);

  // map tiles come from the internet: one that can't load (no signal) is
  // left blank and asked for again on the next move — not an error
  // (owner, 2026-11-01: a blip failed the gate with the map library's
  // own "Error" lines). Any other map error is still reported.
  step("no signal while the map needs new tiles: no errors");
  await rita.offline(true);
  await rita.eval(`map.jumpTo({ center: [2.35, 48.85], zoom: 12 }), true`);
  await rita.waitFor(`(() => { const t = map.style.sourceCaches?.openmaptiles?._tiles || {}; return Object.values(t).some((x) => x.state === "errored"); })()`, "a tile failed to load", 15000);
  await rita.offline(false);
  check(rita.errors.length === 0, "no page errors from the tiles", rita.errors);

  step("any other map error is still reported");
  await rita.eval(`map.fire("error", { error: new Error("journey: a real map error") }), true`);
  await rita.waitFor(`true`, "a moment");
  const reported = rita.errors.filter((e) => e.includes("journey: a real map error"));
  check(reported.length === 1, "reported as a page error", rita.errors);
  rita.errors.splice(0, rita.errors.length, ...rita.errors.filter((e) => !reported.includes(e)));
});
