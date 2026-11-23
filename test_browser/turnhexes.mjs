// Turning the phone changes what's on screen — and so which hexes the app
// listens to (owner, 2026-11-22: "when shifting to side, does it update which
// hex it listens to / leave?"). The map resizes itself (MapLibre trackResize)
// and a resize fires moveend → syncGeoSubscriptions: the hexes now in view
// joined, those gone out of view (past the margin) left. Proven end to end:
// a car in a hex seen only sideways reaches her once she turns.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, DRAWN } from "./app.mjs";

const UP = { w: 390, h: 844 };
const SIDE = { w: 844, h: 390 };
// markers (res 8), ~76 hexes watched (the budget: 110). Here a hex (~125 px)
// and the margin (~105 px) leave room in what turning adds to each side
// (422 − 195 = 227 px). The map's zoom is 512 px tiles: a zoom level less
// than 256 px tiles at the same scale
const ZOOM = 12.75;

const frames = (p, n = 2) =>
  p.eval(`new Promise((ok) => { let i = ${n}; const f = () => (--i <= 0 ? ok(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const facing = (p, type) =>
  p.eval(`(Object.defineProperty(screen, "orientation", { value: Object.assign(new EventTarget(), { type: ${JSON.stringify(type)}, angle: 0 }), configurable: true }), true)`);
async function turn(p, { w, h }) {
  await facing(p, w > h ? "landscape-primary" : "portrait-primary");
  await p.phone(w, h);
  await frames(p, 4);
  await p.waitFor(`!map.isMoving() && worldSync.settled()`, "the map still, its hexes answered");
}

await journey("turnhexes: turning the phone — the hexes now in view joined, those out of view left", async (browser) => {
  step("Rita upright; Dan's car in a hex just past what she listens to — on screen once she turns");
  const rita = await browser.person("BT-TurnRita");
  await rita.phone(UP.w, UP.h);
  await facing(rita, "portrait-primary");
  // (planned afresh at the phone's size: the window was a computer's before
  // .phone(), and a smaller screen inside an older plan keeps it — the
  // margin's rule, on purpose. Another zoom and back plans anew)
  await rita.eval(`(map.jumpTo({ center: [${HOME.longitude}, ${HOME.latitude}], zoom: ${ZOOM - 1} }), true)`);
  await rita.waitFor(`!map.isMoving() && worldSync.settled()`, "(another zoom answered)");
  await rita.eval(`(map.jumpTo({ center: [${HOME.longitude}, ${HOME.latitude}], zoom: ${ZOOM} }), true)`);
  await rita.waitFor(`!map.isMoving() && worldSync.settled()`, "her hexes answered");
  // the hexes, picked from the app's own margin (never guessed): Dan's
  // wholly east of what she listens to upright, its middle on the sideways
  // screen; one wholly north of what she'll listen to sideways, on her
  // upright screen
  const cells = await rita.eval(`(() => {
    const c = map.project([${HOME.longitude}, ${HOME.latitude}]);
    const at = (dx, dy) => { const q = map.unproject([c.x + dx, c.y + dy]); return h3.latLngToCell(q.lat, q.lng, H3_RES); };
    const corners = (cell) => h3.cellToBoundary(cell);
    const mid = (cell) => { const [lat, lng] = h3.cellToLatLng(cell); const q = map.project([lng, lat]); return { x: q.x - c.x, y: q.y - c.y }; };
    const plan = plannedArea.rect;
    let dan = null;
    for (let dy = -${SIDE.h / 2} + 40; dy <= ${SIDE.h / 2} - 40 && !dan; dy += 8)
      for (let dx = 0; dx <= ${SIDE.w / 2} && !dan; dx += 4) {
        const cell = at(dx, dy);
        const m = mid(cell);
        if (corners(cell).every(([, lng]) => lng > plan.e) && m.x < ${SIDE.w / 2} - 20 && Math.abs(m.y) < ${SIDE.h / 2} - 40) dan = cell;
      }
    // what she'll listen to sideways: the sideways screen (same middle,
    // ${SIDE.h / 2} px up and down, ${SIDE.w / 2} across) with the margin
    const top = map.unproject([c.x, c.y - ${SIDE.h / 2}]), bottom = map.unproject([c.x, c.y + ${SIDE.h / 2}]);
    const left = map.unproject([c.x - ${SIDE.w / 2}, c.y]), right = map.unproject([c.x + ${SIDE.w / 2}, c.y]);
    const sidePlan = HoodViewport.padRect(h3, { n: top.lat, s: bottom.lat, e: right.lng, w: left.lng }, H3_RES);
    let north = null;
    for (let dy = -${UP.h / 2} + 10; dy <= 0 && !north; dy += 4) {
      const cell = at(0, dy);
      if (corners(cell).every(([lat]) => lat > sidePlan.n)) north = cell;
    }
    const [lat, lng] = dan ? h3.cellToLatLng(dan) : [0, 0];
    return { dan, north, danAt: { latitude: lat, longitude: lng }, geo: worldSync.wantedGeoSize() };
  })()`);
  check(!!cells.dan && !!cells.north, "(a hex for each found at this zoom)", cells);
  const dan = await browser.person("BT-TurnDan", cells.danAt);
  const danId = await dan.id();
  await goOnline(dan);
  // (Dan's car in that hex: where his phone is)
  check((await dan.eval(`h3.latLngToCell(state.me.lat, state.me.lng, H3_RES)`)) === cells.dan, "(Dan's car in the hex picked)");
  await rita.waitFor(`!map.isMoving() && worldSync.settled()`, "her hexes answered");
  check(!(await rita.eval(`worldSync.wantedGeoHas(${JSON.stringify(cells.dan)})`)), "(upright: Dan's hex not listened to)", cells);
  check(await rita.eval(`worldSync.wantedGeoHas(${JSON.stringify(cells.north)})`), "(upright: the hex up top, on her screen, listened to)", cells);
  check(!(await rita.eval(DRAWN(danId))), "(upright: Dan's car not on her map)");

  step("she turns sideways: Dan's hex joined — his car on her map; the hex up top, now off screen, left");
  await turn(rita, SIDE);
  await rita.waitFor(`worldSync.wantedGeoHas(${JSON.stringify(cells.dan)})`, "Dan's hex listened to");
  await rita.waitFor(DRAWN(danId), "Dan's car on her map (the server sent it)");
  check(!(await rita.eval(`worldSync.wantedGeoHas(${JSON.stringify(cells.north)})`)), "the hex up top no longer listened to", cells);

  step("upright again: the hex up top joined back, Dan's left");
  await turn(rita, UP);
  await rita.waitFor(`worldSync.wantedGeoHas(${JSON.stringify(cells.north)})`, "the hex up top listened to again");
  check(!(await rita.eval(`worldSync.wantedGeoHas(${JSON.stringify(cells.dan)})`)), "Dan's hex left", cells);
  check(rita.errors.length === 0, "no page errors", rita.errors);
});
