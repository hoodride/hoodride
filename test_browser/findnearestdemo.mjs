// Find the nearest in the demo (owner, 2026-11-07): the same code as the
// real app (findnearest.mjs), with the pretend people — a rider's ✋ finds
// the nearest pretend car, a driver going online the pretend ✋.
import { journey, step, check, BASE } from "./cdp.mjs";
import { bannerIs } from "./app.mjs";

const settled = (p) => p.waitFor(`!nearLooking && !map.isMoving()`, `${p.name}: the map settled`);

await journey("findnearestdemo: in the demo, the map shows you the nearest", async (browser) => {
  const dee = await browser.visitor("BT-Dee");
  await dee.phone(390, 844);
  await dee.goto(`${BASE}/?demo=1`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 1`, "the demo's pretend drivers", 15000);

  step("rider: ✋ up — the nearest pretend car on screen, the usual line");
  if ((await dee.eval("state.mode")) !== "rider") await dee.click("btn-mode");
  // (the demo opens on you at 14 with its cars near: the checks below hold
  // before any search — so the search itself is checked to have run, and found)
  const seq0 = await dee.eval("nearSeq");
  await dee.click("btn-hand");
  await dee.waitFor("state.handRaised", "✋ up");
  // (the demo's pretend message 6 s after ✋ up: off — on a loaded machine it
  // could come before the banner below is read, and replace it: a timing
  // flake, removed 2026-11-09 — the search itself is no slower)
  await dee.eval(`(clearTimeout(handPingTimer), true)`);
  await settled(dee);
  const nearest = await dee.eval(`(() => {
    let best = null, m = Infinity;
    drivers.forEach((d) => { const x = HoodNearby.metersBetween(state.me, d.pos); if (x < m) { m = x; best = d; } });
    return map.getBounds().contains([best.pos.lng, best.pos.lat]);
  })()`);
  check(nearest, "the nearest car on screen");
  check(await dee.eval(`nearSeq > ${seq0} && foundWatch !== null && foundWatch.type === "driver"`), "(a search ran on ✋ up — and found a car)", await dee.eval("nearSeq"));
  check((await dee.eval("map.getZoom()")) <= 14, "never closer than 14");
  await bannerIs(dee, "✋ Nearby drivers can see you need a ride");

  step("driver: online — the pretend ✋ on screen, the usual line");
  await dee.click("btn-hand");
  await dee.waitFor("!state.handRaised", "✋ down");
  await dee.click("btn-mode");
  await dee.waitFor(`state.mode === "driver"`, "driver mode");
  const seq1 = await dee.eval("nearSeq");
  await dee.click("btn-online");
  await dee.waitFor("state.online && !!mockHand", "online, a ✋ around");
  await settled(dee);
  check(await dee.eval(`map.getBounds().contains([mockHand.pos.lng, mockHand.pos.lat])`), "the ✋ on screen");
  check(await dee.eval(`nearSeq > ${seq1} && foundWatch !== null && foundWatch.type === "hand"`), "(a search ran on going online — and found the ✋)", await dee.eval("nearSeq"));
  await bannerIs(dee, "🟢 You're online");
});
