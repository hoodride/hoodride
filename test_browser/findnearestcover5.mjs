// What covers the map, part 5 (owner, 2026-11-09 — "if you can see it on
// the map, it counts"; "test it to death"): the driver's side with real
// accounts, right to left. Dora drives, in Arabic (the locate button on the
// left); four riders raise ✋ on one block: one ✋ group with its "+1"
// badge — top LEFT, right to left. Its badge alone over the locate button
// hides it; its badge-free side can come right up to the screen's edge.
// Helpers and the rule: cover.mjs.
// The others: findnearestcover/2/3/3b/4/5/6.mjs, findnearestpause.mjs,
// findnearestnobody.mjs, findnearestovertime/backoff/driving/
// settle/faults/away/dot.mjs.
import { journey, step, check, HOME, BASE } from "./cdp.mjs";
import { goOnline } from "./app.mjs";
import { oracle, box, mapSize, stopsWhereExpected } from "./cover.mjs";

const merc = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const unmerc = (m) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * m))) * 180) / Math.PI;
// where to stand so that `spot` lands at screen point `t` at the usual view
function standFor(spot, t, size) {
  const k = 512 * 2 ** 14;
  return { latitude: unmerc(merc(spot.lat) - (t.y - size.h / 2) / k), longitude: spot.lng - ((t.x - size.w / 2) * 360) / k };
}

const BLOCK = { latitude: HOME.latitude + 0.004, longitude: HOME.longitude + 0.003 };
const GROUP = (n) => `[...pileMarkers.values()].some((pm) => pm.type === "hand" && pm.ids.length === ${n} && !!pm.el.querySelector(".pile-more"))`;

// Dora (online: her GPS is on) stands at `at`, her map on her at the usual
// view, answered
async function standAt(dora, at) {
  await dora.locate(at);
  await dora.waitFor(`Math.abs(state.me.lat - ${at.latitude}) < 1e-7 && Math.abs(state.me.lng - ${at.longitude}) < 1e-7`, "Dora where she stands", 15000);
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "no search under way", 30000);
  await dora.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: INTENT_ZOOM }), true)`);
  await dora.waitFor(`!map.isMoving() && worldSync.settled() && serverRole === "driver" && ${GROUP(4)}`, "Dora's map answered, the ✋ group drawn", 15000);
}

await journey("findnearestcover5: the driver's side, right to left — a ✋ group's badge (top left)", async (browser) => {
  step("Dora online, in Arabic (right to left); four riders raise ✋ on one block: one ✋ group, its '+1' badge top LEFT");
  const dora = await browser.person("BT-Dora");
  await dora.phone(390, 844);
  await dora.goto(`${BASE}/privacy`);
  await dora.eval(`(document.cookie = "hoodride_lang=ar; path=/", true)`);
  await goOnline(dora);
  check((await dora.eval(`document.documentElement.dir`)) === "rtl", "(Dora's page right to left)");
  await oracle(dora);
  const riders = [];
  for (const name of ["BT-R1", "BT-R2", "BT-R3", "BT-R4"]) {
    const r = await browser.person(name, BLOCK);
    await r.phone(390, 844);
    await r.open();
    await r.click("btn-hand");
    await r.waitFor("state.handRaised", `${name}'s ✋ up`);
    riders.push({ r, id: await r.id() });
  }
  const ids = riders.map((x) => x.id);
  await dora.eval(`(map.jumpTo({ center: [${BLOCK.longitude}, ${BLOCK.latitude}], zoom: INTENT_ZOOM }), true)`);
  await dora.waitFor(GROUP(4), "the four ✋ in one group on Dora's map, with its badge", 20000);
  const spot = await dora.eval(`(() => { for (const pm of pileMarkers.values()) if (pm.type === "hand" && pm.ids.length === 4) { const a = pm.marker.getLngLat(); return { lat: a.lat, lng: a.lng }; } })()`);
  const size = await mapSize(dora);
  const loc = await box(dora, "#btn-locate");
  check(loc.left < size.w / 2, "(the locate button on the left, right to left)", loc);
  await standAt(dora, standFor(spot, { x: Math.round(size.w / 2), y: 420 }, size));
  const g = await dora.eval(`__o.drawnBox(__o.target(${ids[0]}).el).half`);
  check(g.l > g.r + 4 && g.t > g.b + 4, "(the badge pokes out top LEFT only)", g);

  step("the ✋ group's badge alone over the locate button (the group to its right): hidden — found only further out");
  await standAt(dora, standFor(spot, { x: Math.round(loc.right + g.r + 2), y: Math.round(loc.top + g.t - 4) }, size));
  const over = await dora.eval(`(() => { const t = __o.target(${ids[0]}); const r = __o.rel(t.el.querySelector(".pile-more").getBoundingClientRect()); const body = __o.rel(t.el.getBoundingClientRect()); const l = ${JSON.stringify(loc)}; const hit = (a) => a.right > l.left && a.left < l.right && a.bottom > l.top && a.top < l.bottom; return { badge: hit(r), body: hit(body) }; })()`);
  check(over.badge && !over.body, "(only the badge over the locate button)", over);
  check((await dora.eval(`(() => { const w = __o.stop(${JSON.stringify(ids)}, "#btn-locate"); return w.stop === w.steps[0]; })()`)), "(without the locate button: in sight at once — the button alone hides it)");
  check((await dora.eval(`__o.coveredBy(${ids[0]}, "#btn-locate")`)).ok, "(on the screen, the locate button is on top of it)", await dora.eval(`__o.coveredBy(${ids[0]}, "#btn-locate")`));
  await stopsWhereExpected(dora, ids, "a ✋ group's badge alone over the locate button (right to left)", { mustBe: "further" });

  step("its badge-free side (the right) 2 px in from the screen's edge: in plain sight — found at once");
  await standAt(dora, standFor(spot, { x: Math.round(size.w - g.r - 2), y: 420 }, size));
  await stopsWhereExpected(dora, ids, "a ✋ group's badge-free side near the screen's edge (right to left)", { mustBe: "usual" });

  for (const { r } of riders) await r.close();
  await dora.close();
});
