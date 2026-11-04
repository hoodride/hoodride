// The map (owner, 2026-10-30): several cars on one block are one pile, a
// tap lists them by name; zoomed out, cars become counts; the map opens
// where you left it.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, showsCar, pinPulse, noPulse } from "./app.mjs";

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
  await rita.waitFor(`[...aggData.values()].some((p) => p.drivers === 3)`, "a count of 3 drivers", 15000);

  step("back in: the pile is back");
  await rita.eval(`map.jumpTo({ center: [${view.lng}, ${view.lat}], zoom: ${view.zoom} }), true`);
  await rita.waitFor(`[...pileMarkers.values()].some((pm) => pm.ids.length === 3)`, "the pile of 3 again");

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
