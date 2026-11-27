// An open pile list ("2 cars here") isn't rebuilt at every GPS reading
// (review, 2026-11-24): refreshControls runs at each one (~1 a second
// while driving or a ✋ is up); it used to redraw the markers each time,
// and the redraw rebuilds the open list — a tap on a row lost as the row
// was replaced under the finger. Now it redraws only when what the map
// shows changes (mode, ride, online).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees } from "./app.mjs";

await journey("pilekeep: an open pile list survives refreshes (GPS readings) — its rows not rebuilt", async (browser) => {
  step("Dan and Eve park at the same spot: Pia sees one pile of two; she opens its list");
  const pia = await browser.person("BT-PilePia");
  const at = { latitude: HOME.latitude + 0.004, longitude: HOME.longitude };
  const dan = await browser.person("BT-PileDan", at);
  const eve = await browser.person("BT-PileEve", at);
  await goOnline(dan);
  await goOnline(eve);
  const [danId, eveId] = [await dan.id(), await eve.id()];
  await sees(pia, danId, "(Dan's car)");
  await sees(pia, eveId, "(Eve's car)");
  await pia.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 2)`, "one pile of two");
  await pia.eval(`(onPileTap([...pileMarkers.values()].find((pm) => pm.ids.length === 2)), true)`);
  await pia.waitFor(`!!state.pileKey && document.querySelectorAll("#pile-list button").length >= 2`, "the list open, two rows");

  step("ten refreshes (as GPS readings), a frame apart: the rows are the same elements — never rebuilt under a finger");
  // (each refresh, then two frames: was the list rebuilt? A real map
  // update landing in a window rebuilds it too — by design, its cars
  // changed — so one is allowed; every refresh rebuilding it is the bug)
  const kept = await pia.eval(`new Promise((ok) => {
    let n = 10, rebuilt = 0;
    const tick = () => {
      const first = document.querySelector("#pile-list button");
      refreshControls();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!first.isConnected) rebuilt++;
        --n > 0 ? tick() : ok({ rebuilt });
      }));
    };
    tick();
  })`);
  check(kept.rebuilt <= 1, "refreshes don't rebuild the open list (at most one real map update did)", kept);
  check(pia.errors.length === 0, "no page errors", pia.errors);
});
