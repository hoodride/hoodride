// The map (owner, 2026-10-30): several cars on one block are one pile, a
// tap lists them by name; zoomed out, cars become counts; the map opens
// where you left it.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, showsCar, pinPulse, noPulse, holdAnswers, letAnswersGo, dropAndWait, restoreAndWait } from "./app.mjs";

// in the page: is the 📍 on this button pulsing (past its 1 s delay)?
const PULSING = `(id) => { const i = document.querySelector("#" + id + ' img[data-emoji="\u{1F4CD}"]'); const a = i ? i.getAnimations().filter((x) => x.animationName === "seeking") : []; return a.length > 0 && a[0].effect.getComputedTiming().progress !== null; }`;

// until the 📍 on this button pulses; if it never does, the button's state
async function pulses(p, id, what) {
  try {
    await p.waitFor(`(${PULSING})(${JSON.stringify(id)})`, what, 3000);
  } catch (e) {
    const state = await p.eval(`(() => {
      const b = document.getElementById(${JSON.stringify(id)});
      const imgs = [...b.querySelectorAll("img")];
      return {
        cls: b.className,
        text: b.textContent,
        imgs: imgs.map((i) => i.getAttribute("src") + ":" + i.getAnimations().map((a) => a.animationName + "@" + Math.round(a.currentTime ?? -1)).join("|")),
        pending: { hand: loc.pending.hand, online: loc.pending.online },
        shown: getComputedStyle(b).display,
      };
    })()`);
    throw new Error(`${e.message}
  button: ${JSON.stringify(state)}`);
  }
}

await journey("map: a pile, zoomed-out counts, where the map opens", async (browser) => {
  step("Rita (rider); Dan, Eve and Finn (drivers) online on the same block");
  const rita = await browser.person("BT-Rita");
  const drivers = [];
  for (const name of ["BT-Dan", "BT-Eve", "BT-Finn"]) {
    const d = await browser.person(name);
    await goOnline(d);
    drivers.push(d);
  }
  const ids = [];
  for (const d of drivers) ids.push(await d.id());
  for (const id of ids) await sees(rita, id);

  step("the cars on the map, the Drive button and the top bar show the car picture, not the emoji");
  check(await rita.eval(`[...pileMarkers.values()].every((pm) => pm.el.querySelector('img[src^="car.png"]') && !pm.el.textContent.includes("\u{1F697}"))`), "the map's cars");
  check(await showsCar(rita, "#btn-mode"), "the Drive button");
  // the car sits a space's width from its word, as "🚶 Ride" does — the
  // button's own 10 px gap made it 15 px and the button too wide (owner)
  const carToText = await rita.eval(`(() => { const b = document.getElementById("btn-mode"), i = b.querySelector("img"), r = document.createRange(); r.selectNodeContents(b.lastChild); return Math.round(r.getBoundingClientRect().left - i.getBoundingClientRect().right); })()`);
  check(carToText >= 3 && carToText <= 6, "the car a space's width from 'Drive'", carToText);
  check(await showsCar(rita, ".topbar-title"), "the top bar");

  step("beside the bottom button: the map, not the row — it drags from there; the button still taps");
  // (owner, 2026-11-02: the row spans the width and swallowed the map's drags)
  const spot = await rita.eval(`(() => { const r = document.getElementById("btn-hand").getBoundingClientRect(); return { x: Math.round(r.left / 2), y: Math.round(r.top + r.height / 2), bx: Math.round(r.left + r.width / 2), w: innerWidth }; })()`);
  check(spot.x > 5 && spot.x < spot.w, "a spot beside the button, on screen", spot);
  check(await rita.eval(`map.getCanvasContainer().contains(document.elementFromPoint(${spot.x}, ${spot.y}))`), "that spot is the map", await rita.eval(`(() => { const e = document.elementFromPoint(${spot.x}, ${spot.y}); return e && (e.id || e.className); })()`));
  check(await rita.eval(`document.getElementById("btn-hand").contains(document.elementFromPoint(${spot.bx}, ${spot.y}))`), "the button itself still catches its tap");
  const before = await rita.eval(`JSON.stringify(map.getCenter())`);
  await rita.drag(spot.x, spot.y, spot.x + 80, spot.y - 120);
  await rita.waitFor(`JSON.stringify(map.getCenter()) !== ${JSON.stringify(before)}`, "the map moved by a drag from beside the button", 5000);
  await rita.eval(`map.jumpTo({ center: ${before} }), true`);

  step("one pile of 3 on Rita's map; tapped, it lists all three by name");
  const key = await rita.waitFor(
    `(() => { for (const [k, pm] of pileMarkers) if (pm.ids.length === 3) return k; return null; })()`,
    "a pile of 3"
  );
  await rita.eval(`pileMarkers.get(${JSON.stringify(key)}).el.click(), true`);
  await rita.waitFor(`!document.getElementById("pile-sheet").classList.contains("hidden")`, "the pile list open");
  await rita.waitFor(
    `["BT-Dan", "BT-Eve", "BT-Finn"].every((n) => document.getElementById("pile-list").textContent.includes(n))`,
    "all three names in the list",
    15000
  );
  await rita.eval(`closePileSheet(), true`);

  step("zoomed out: no car markers, a count of 3 for the area");
  const view = await rita.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; })()`);
  await rita.eval(`map.jumpTo({ zoom: 11 }), true`);
  await rita.waitFor(`pileMarkers.size === 0`, "the car markers gone");
  // (drawn: a wanted cell's count, all answered — the app keeps counts it no longer draws)
  await rita.waitFor(`worldSync.settled() && [...aggData].some(([c, p]) => p.drivers === 3 && worldSync.wantedAggHas(c))`, "a count of 3 drivers drawn", 15000);
  // …in the area that holds their block: the server works it out from the
  // block itself (step 5, 2026-11-13 — it used to take the app's word)
  const danSpot = await drivers[0].eval("mySpot");
  check(await rita.eval(`[...aggData].some(([c, p]) => p.drivers === 3 && h3.cellToParent(${JSON.stringify(danSpot)}, h3.getResolution(c)) === c)`), "the count of 3 is where their block is", danSpot);

  step("a car claiming far-away areas counts only where it is; no car on file, no car on the map");
  // (as a cheater would: a hand-made message naming areas across the river)
  const across = { lng: -73.95, lat: 40.65 };
  const farAreas = await rita.eval(`[7, 5].map((r) => h3.latLngToCell(${across.lat}, ${across.lng}, r)).filter((c) => c !== h3.cellToParent(${JSON.stringify(danSpot)}, h3.getResolution(c)))`);
  check(farAreas.length > 0, "an area that isn't Dan's", farAreas);
  await drivers[0].eval(`userChannel.push("driver_update", { spot: mySpot, cell: ${JSON.stringify(farAreas[0])}, parents: ${JSON.stringify(farAreas)} }), true`);
  await rita.eval(`map.jumpTo({ center: [${across.lng}, ${across.lat}], zoom: 11 }), true`);
  await rita.waitFor(`worldSync.settled() && ${JSON.stringify(farAreas)}.some((c) => worldSync.wantedAggHas(c))`, "Rita looking at the far-away area");
  await new Promise((r) => setTimeout(r, 1000));
  check(await rita.eval(`${JSON.stringify(farAreas)}.every((c) => !(aggData.get(c)?.drivers > 0))`), "no car counted there", await rita.eval(`${JSON.stringify(farAreas)}.map((c) => aggData.get(c))`));
  const refused = await rita.eval(`new Promise((ok) => userChannel.push("driver_update", { spot: ${JSON.stringify(danSpot)} }).receive("error", (e) => ok(e.reason)).receive("timeout", () => ok("timeout")))`);
  check(refused === "no_car", "Rita (no car) sending a car by hand: refused", refused);

  step("back in: the pile is back");
  await rita.eval(`map.jumpTo({ center: [${view.lng}, ${view.lat}], zoom: ${view.zoom} }), true`);
  await rita.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 3)`, "the pile of 3 again");

  // drawn: only what the view wants NOW (owner, 2026-11-10). A sync's
  // answer can land after the view moved on: its data is kept (the server
  // holds it), but never drawn — no count hexes over the cars of a view
  // zoomed in meanwhile, no cars under the hexes of one zoomed out.
  // (the hexes actually drawn: what the map's count layer was last given)
  await rita.eval(`(() => { const src = map.getSource("agg-src"); const set = src.setData.bind(src); src.setData = (d) => { window.__hexes = d.features.map((f) => f.properties.total); return set(d); }; window.__hexes = []; return true; })()`);
  step("zoomed out, its answer held back: the cars no longer drawn at once — their data kept");
  await rita.waitFor(`worldSync.settled() && !map.isMoving()`, "settled on the pile");
  await holdAnswers(rita);
  await rita.eval(`map.jumpTo({ zoom: 11 }), true`);
  await rita.waitFor(`__heldAsks.length === 1 && !renderMarkersSoon.pending()`, "the zoom-out's ask held, the frame drawn");
  check(await rita.eval(`pileMarkers.size === 0`), "no car markers drawn under the counts", await rita.eval(`pileMarkers.size`));
  check(await rita.eval(`${JSON.stringify(ids)}.every((id) => realEntries.has(id))`), "their data kept (the server still holds those cells)");
  await letAnswersGo(rita);
  await rita.waitFor(`worldSync.settled() && __hexes.includes(3)`, "the count of 3 drawn", 15000);

  step("zoomed back in, its answer held back: the count hexes no longer drawn at once");
  await holdAnswers(rita);
  // (emptied: so "none drawn" below proves the layer WAS redrawn meanwhile)
  await rita.eval(`(window.__hexes = null), true`);
  await rita.eval(`map.jumpTo({ center: [${view.lng}, ${view.lat}], zoom: ${view.zoom} }), true`);
  await rita.waitFor(`__heldAsks.length === 1 && !renderAggSoon.pending()`, "the zoom-in's ask held, the frame drawn");
  check(await rita.eval(`Array.isArray(__hexes) && __hexes.length === 0`), "redrawn, with no count hexes over the cars", await rita.eval(`__hexes`));
  await letAnswersGo(rita);
  await rita.waitFor(`worldSync.settled() && [...pileMarkers.values()].some((pm) => pm.ids.length === 3)`, "the pile of 3 again");
  check(await rita.eval(`__hexes.length === 0`), "still no hexes", await rita.eval(`__hexes`));

  // the server folds a person's "left" into their newer update for a cell
  // this view doesn't watch: that update must take them OFF (else a ghost
  // where they were — find the nearest would call it found)
  step("an update for a cell the view doesn't watch: that car leaves the pile (no ghost)");
  const far = await rita.eval(`h3.latLngToCell(${view.lat} + 0.3, ${view.lng}, H3_RES)`);
  check(await rita.eval(`worldSync.wantedGeoHas((realEntries.get(${ids[0]}) || {}).cell)`), "(Dan drawn here first)");
  // the message and the check in one go, the frame after it read at once —
  // Dan's own next real update (every ~20 s) can't slip in between
  const r = await rita.eval(`new Promise((ok) => {
    worldChannel.trigger("batch", { items: [["driver_update", { id: ${ids[0]}, cell: ${JSON.stringify(far)}, spot: ${JSON.stringify(far)} }]] });
    const gone = !realEntries.has(${ids[0]});
    requestAnimationFrame(() => requestAnimationFrame(() => ok({ gone, inPile: [...pileMarkers.values()].some((pm) => pm.ids.includes(${ids[0]})) })));
  })`);
  check(r.gone && !r.inPile, "Dan's stale entry gone, no pile shows him", r);
  // (the server still has him here: a fresh look brings him back)
  await rita.eval(`map.jumpTo({ zoom: 11 }), true`);
  await rita.waitFor(`worldSync.settled() && !map.isMoving()`, "out");
  await rita.eval(`map.jumpTo({ center: [${view.lng}, ${view.lat}], zoom: ${view.zoom} }), true`);
  await rita.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 3)`, "the pile of 3 again");

  // a reconnect brings the map back EXACTLY as the server has it: whoever
  // left while Rita was cut off is gone (their "left" never reached her),
  // whoever came is there — and the count says so too (owner, 2026-11-10)
  step("Rita's connection drops; meanwhile Dan goes offline and Hal comes online on the block; back: Eve, Finn and Hal — never Dan; the count 3");
  await dropAndWait(rita);
  await drivers[0].click("btn-online");
  await drivers[0].waitFor("!state.online", "Dan offline");
  const hal = await browser.person("BT-Hal");
  await goOnline(hal);
  const halId = await hal.id();
  // (any live "left" for Dan reaching Rita from now on is counted: only the
  // reconnect's snapshot may take him off, or this proves nothing)
  await rita.eval(`(() => { const t = worldChannel.trigger; window.__danLeft = 0; window.__live = 0; worldChannel.trigger = function (e, p, ...a) { window.__live++; if (JSON.stringify(p || {}).includes('"driver_left"') && JSON.stringify(p).includes(String(${ids[0]}))) window.__danLeft++; if (e === "driver_left" && p && p.id === ${ids[0]}) window.__danLeft++; return t.call(this, e, p, ...a); }; return true; })()`);
  await restoreAndWait(rita);
  const want = JSON.stringify([ids[1], ids[2], halId].sort());
  await rita.waitFor(`worldSync.settled() && [...pileMarkers.values()].some((pm) => JSON.stringify([...pm.ids].sort()) === ${JSON.stringify(want)})`, "one pile: Eve, Finn and Hal", 20000);
  check(await rita.eval(`!realEntries.has(${ids[0]}) && ![...pileMarkers.values()].some((pm) => pm.ids.includes(${ids[0]}))`), "Dan nowhere on Rita's map");
  check(await rita.eval(`window.__live > 0`), "(live messages do pass through the count)", await rita.eval(`window.__live`));
  check(await rita.eval(`window.__danLeft === 0`), "(no live 'left' for Dan reached her: the reconnect's snapshot took him off)", await rita.eval(`window.__danLeft`));
  await rita.eval(`(window.__hexes = null), map.jumpTo({ zoom: 11 }), true`);
  await rita.waitFor(`worldSync.settled() && Array.isArray(__hexes) && __hexes.includes(3)`, "zoomed out: the count of 3 drawn", 15000);
  check(await rita.eval(`!__hexes.some((n) => n > 3)`), "no count above 3 (Dan not counted)", await rita.eval(`__hexes`));
  await rita.eval(`map.jumpTo({ center: [${view.lng}, ${view.lat}], zoom: ${view.zoom} }), true`);

  // with no location the map can't centre on you: it opens where you were
  step("Mo (no GPS signal) moves the map, closes the app, opens it: same place");
  const mo = await browser.person("BT-Mo", null);
  await mo.eval(`map.jumpTo({ center: [-73.9857, 40.7484], zoom: 13.5 }), true`);
  await mo.waitFor(`!map.isMoving()`, "the map settled");
  await new Promise((r) => setTimeout(r, 500));
  await mo.open();
  const at = await mo.waitFor(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; })()`, "the map");
  check(Math.abs(at.lng - -73.9857) < 0.001 && Math.abs(at.lat - 40.7484) < 0.001, "the same place", at);
  check(Math.abs(at.zoom - 13.5) < 0.01, "the same zoom", at);

  // finding your location (owner, 2026-11-01): the 📍 on the button pulses
  // gently — only after 1 s (NN/g: a looped animation under 1 s distracts),
  // and it stops the moment the wait ends; still for "Reduce motion"
  step("Mo (still no signal) taps Need a ride: the pin waits a second, then pulses");
  await mo.click("btn-hand");
  await mo.waitFor("loc.pending.hand", "the tap waits for GPS");
  check((await pinPulse(mo, "btn-hand")) === "waiting", "not yet in the first second", await pinPulse(mo, "btn-hand"));
  await pulses(mo, "btn-hand", "the pin pulsing after a second");
  await mo.eval(`(window.__pin = document.querySelector('#btn-hand img[data-emoji="\u{1F4CD}"]')), true`);
  // the app redraws its buttons whenever something nearby changes: the
  // pulse must carry on through a redraw, not start over
  for (let i = 0; i < 5; i++) {
    await mo.eval("refreshControls(), true");
    await new Promise((r) => setTimeout(r, 500));
    check((await pinPulse(mo, "btn-hand")) === "pulsing", "it keeps pulsing (never starts over)", await pinPulse(mo, "btn-hand"));
  }
  check(await mo.eval(`document.querySelector('#btn-hand img[data-emoji="\u{1F4CD}"]') === window.__pin`), "the same pin all along (not redrawn)");

  // (all before any reading: once the phone has a fresh one, a tap goes
  // straight through, with nothing to wait for)
  step("✕ (a second tap): the wait and the pulse stop");
  await mo.click("btn-hand");
  await mo.waitFor("!loc.pending.hand", "the wait cancelled");
  check(await noPulse(mo, "btn-hand"), "nothing pulses after ✕");

  step("Reduce motion on: the pin stays still");
  await mo.reduceMotion(true);
  await mo.click("btn-hand");
  await mo.waitFor("loc.pending.hand", "the tap waits for GPS");
  await new Promise((r) => setTimeout(r, 1500));
  check((await pinPulse(mo, "btn-hand")) === "still", "the pin still", await pinPulse(mo, "btn-hand"));
  await mo.click("btn-hand");
  await mo.waitFor("!loc.pending.hand", "the wait cancelled");
  await mo.reduceMotion(false);

  step("a tap again; the reading comes: Looking for a ride, nothing pulses");
  await mo.click("btn-hand");
  await pulses(mo, "btn-hand", "the pin pulsing");
  await mo.locate(HOME);
  await mo.waitFor("state.handRaised", "the hand up");
  check(await noPulse(mo, "btn-hand"), "nothing pulses on Looking for a ride");

  step("Zed (driver, no signal) taps GO ONLINE: the pin pulses; the reading comes: it stops");
  const zed = await browser.person("BT-Zed", null);
  check(
    await zed.eval(`fetch("/api/car", {method: "POST", headers: {"content-type": "application/json"}, body: ${JSON.stringify(JSON.stringify({ color: "Red", make: "Honda", model: "Fit" }))}}).then(r => r.ok)`),
    "Zed's car saved"
  );
  await zed.open();
  if ((await zed.eval("state.mode")) !== "driver") await zed.click("btn-mode");
  await zed.waitFor(`state.mode === "driver" && state.myCar !== undefined`, "driver mode, car known");
  await zed.click("btn-online");
  await zed.waitFor("loc.pending.online", "the tap waits for GPS");
  check((await pinPulse(zed, "btn-online")) === "waiting", "not yet in the first second", await pinPulse(zed, "btn-online"));
  await pulses(zed, "btn-online", "the pin pulsing after a second");
  await zed.locate(HOME);
  await zed.waitFor("state.online", "online");
  check(await noPulse(zed, "btn-online"), "nothing pulses on GO OFFLINE");
});
