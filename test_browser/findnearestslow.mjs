// Find the nearest on a very slow connection (owner, 2026-11-07; no deadline,
// 2026-11-09). It used to wait 3 s, decide "nobody" with what it had, and
// give up on any answer after 30 s more. Now it waits at each step for the
// server's answer however long it takes — a slow phone gets the same result
// as a fast one, just later — and carries on from that same step. Nothing
// to stand in for an answer: no "nobody nearby yet" until the widest view is
// really answered and empty. A swipe, ✋ down or going offline still end it
// (findnearestlate.mjs, findnearestlook.mjs).
import { journey, step, check } from "./cdp.mjs";
import { goOnline, bannerIs } from "./app.mjs";
import { HOME } from "./cdp.mjs";

const RIDER = "✋ Nearby drivers can see you need a ride";
// each answer this late: four times the old 3 s give-up
const SLOW_MS = 12000;

await journey("findnearestslow: a very slow answer is waited for, and the search carries on", async (browser) => {
  step(`Dora online about 1.6 km north; Kim (home) zoomed right in, on a connection ${SLOW_MS / 1000} s slow`);
  const dora = await browser.person("BT-Dora", { latitude: HOME.latitude + 1.6 / 111.32, longitude: HOME.longitude });
  await goOnline(dora);
  const doraId = await dora.id();
  const kim = await browser.person("BT-Kim");
  await kim.phone(390, 844);
  await kim.open();
  await kim.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Kim's map loaded");
  await kim.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true`);
  await kim.waitFor(`!map.isMoving() && worldSync.settled() && !realEntries.has(${doraId})`, "zoomed in, Dora not on Kim's map");
  // the map's question reaches the server SLOW_MS late (so its answer does too)
  await kim.eval(`(() => {
    const push = worldChannel.push.bind(worldChannel);
    worldChannel.push = (event, ...rest) => {
      if (event !== "sync") return push(event, ...rest);
      const cbs = [];
      const later = { receive(status, cb) { cbs.push([status, cb]); return later; } };
      setTimeout(() => cbs.reduce((p, [status, cb]) => p.receive(status, cb), push(event, ...rest)), ${SLOW_MS});
      return later;
    };
    window.__lines = [];
    const b = document.getElementById("banner");
    new MutationObserver(() => window.__lines.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);

  step("Kim raises ✋: well past the old give-up it's still waiting at the first step — no 'nobody'");
  await kim.click("btn-hand");
  await kim.waitFor("state.handRaised", "Kim's ✋ up");
  await kim.waitFor(`nearLooking && !map.isMoving() && map.getZoom() === INTENT_ZOOM`, "at the usual view, waiting");
  await new Promise((r) => setTimeout(r, SLOW_MS - 2000));
  check(await kim.eval(`nearLooking && map.getZoom() === INTENT_ZOOM`), "still waiting at the first step");
  await bannerIs(kim, RIDER);

  step("the answers come, each late: the search carries on step by step and stops with Dora's car on screen");
  await kim.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 5 * SLOW_MS + 10000);
  const z = await kim.eval(`map.getZoom()`);
  check(z < 14, "stepped out", z);
  check(
    await kim.eval(`realEntries.has(${doraId}) && HoodNearby.fitZoom(state.me, realEntries.get(${doraId}).peer.pos, mapSize(), NEAR_PAD) >= map.getZoom() - 1e-9`),
    "Dora's car on screen, clear of the banner and buttons"
  );
  await bannerIs(kim, RIDER);
  const lines = await kim.eval("window.__lines");
  check(!lines.some((l) => l.includes("nobody nearby yet")), "never 'nobody nearby yet'", lines);
});
