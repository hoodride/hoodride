// What covers the map, part 1 (owner, 2026-11-09 — "if you can see it on
// the map, it counts"; "test it to death"): a phone, the demo, a rider with
// ✋ up. Each case is worked out by the test's own copy of the rule first
// (cover.mjs) — "found at once", "found only further out", or "nobody" — and
// the search must stop exactly there, having taken exactly those steps.
//
//   * the marker sits where the maths says (the rule's ground truth);
//   * BESIDE a cover counts (the box rule's point): beside the locate button,
//     beside the bottom bar's button in the same row (the row is see-through);
//   * UNDER a cover doesn't: the locate button, the bottom bar's button, a
//     3-line banner, the title, the map's credits (open and folded), the chat;
//   * a pixel into a cover doesn't count; a pixel clear does — every side;
//   * the screen's edges: a pixel off doesn't count; a pixel on does;
//   * your blue dot: a car drawn over it counts;
//   * the chat open close to the screen's middle: cars above it still count;
//   * the banner growing after the search started: measured as it is.
// The rest: findnearestpause.mjs (behind drawers), findnearestnobody.mjs
// ("nobody nearby yet"), findnearestcover2/3/3b/4/5/6.mjs (other covers,
// screens, real accounts), findnearestovertime/backoff/driving/
// settle/faults/away/dot.mjs (over
// time).
import { journey, step, check } from "./cdp.mjs";
import {
  demo, freeze, riderLooking, box, mapSize, place, at, half, drawnWherePredicted, inside, leftOf, below, above, longBanner, LONG, onlyUnder, search,
} from "./cover.mjs";

await journey("findnearestcover: a phone — beside counts, under doesn't, to the pixel", async (browser) => {
  const p = await demo(browser, "BT-Cover", { w: 390, h: 844, scale: 2 });
  await freeze(p);
  await riderLooking(p);
  const size = await mapSize(p);
  const { w, h } = size;

  step("the car's marker sits exactly where the maths puts it (what every case below stands on)");
  await place(p, { x: 120, y: 300 });
  await drawnWherePredicted(p);
  const hc = await half(p);
  check(hc.x >= 15 && hc.y >= 15, "(the car's marker measured)", hc);

  step("the locate button: beside it counts; under it, or a pixel into its side, doesn't; a pixel clear of it does");
  const loc = await box(p, "#btn-locate");
  await at(p, inside(loc), "further", "under the locate button", "car", "#btn-locate");
  await at(p, leftOf(loc, hc.x, 4), "usual", "beside the locate button (4 px clear, same height)");
  await at(p, leftOf(loc, hc.x, -1), "further", "a pixel into the locate button's side", "car", "#btn-locate");
  await at(p, leftOf(loc, hc.x, 1), "usual", "a pixel clear of the locate button's side");
  await at(p, above(loc, hc.y, -1), "further", "a pixel into the locate button's top", "car", "#btn-locate");
  await at(p, above(loc, hc.y, 1), "usual", "a pixel clear of the locate button's top");

  step("the map's credits: as a strip of text (as the map opens) it covers the bottom row; folded to its ⓘ, only that does");
  const strip = await box(p, ".maplibregl-ctrl-attrib");
  check(strip.right - strip.left > 200, "(the credits open as a strip, as the map loads)", strip);
  // (at the strip's left end: below nothing else — the ✋ button sits in the middle)
  await at(p, { x: Math.round(strip.left + 11), y: Math.round(strip.top + 4) }, "further", "under the credits' text", "car", ".maplibregl-ctrl");
  // (folded with a finger on its ⓘ, as a person does)
  const ib = await p.eval(`(() => { const el = document.querySelector(".maplibregl-ctrl-attrib-button"); const b = el.getBoundingClientRect(); const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2; const top = document.elementFromPoint(x, y); return { x, y, ok: !!top && el.contains(top) }; })()`);
  check(ib.ok, "(the credits' ⓘ is what a finger there touches)", ib);
  await p.tapAt(ib.x, ib.y);
  await p.waitFor(`!document.querySelector(".maplibregl-ctrl-attrib").classList.contains("maplibregl-compact-show")`, "the credits folded by a tap");
  const folded = await box(p, ".maplibregl-ctrl-attrib");
  check(folded.right - folded.left < 40, "(the credits folded to their ⓘ)", folded);
  await at(p, await onlyUnder(p, ".maplibregl-ctrl"), "further", "under the credits' ⓘ", "car", ".maplibregl-ctrl");

  step("the bottom bar: its ✋ button covers; beside it, in the same row, counts (the row itself is see-through)");
  const pill = await box(p, "#btn-hand");
  check(pill.left > 2 * hc.x + 4, "(room beside the ✋ button)", pill);
  await at(p, inside(pill), "further", "under the ✋ button", "car", "#bottom-controls > *");
  // (4 px off: clear of its 3 px yellow ring — the ring covers too:
  // findnearestdot.mjs)
  await at(p, leftOf(pill, hc.x, 4), "usual", "beside the ✋ button (clear of its ring), in the bottom bar's row");

  step("the banner: a pixel into its bottom doesn't count; a pixel clear does; under a 3-line banner doesn't");
  const ban = await box(p, "#banner");
  await at(p, below(ban, hc.y, -1, Math.round(w / 2)), "further", "a pixel into the banner", "car", "#banner");
  await at(p, below(ban, hc.y, 1, Math.round(w / 2)), "usual", "a pixel clear of the banner");
  const long = await longBanner(p);
  const ban3 = await box(p, "#banner");
  check(ban3.bottom - ban.bottom > 15, "(the long banner reaches at least a line further down)", { ban, ban3 });
  await at(p, { x: Math.round(w / 2), y: Math.round(ban3.bottom - 6) }, "further", "under the 3-line banner's last line", "car", "#banner");
  await at(p, below(ban3, hc.y, 1, Math.round(w / 2)), "usual", "a pixel clear of the 3-line banner");
  await long.off();

  step("the title (\"Hood Ride\") covers too");
  const title = await box(p, ".topbar-title");
  await at(p, inside(title), "further", "under the title", "car", ".topbar-title");

  step("the account and mode buttons on the top bar cover too");
  await at(p, await onlyUnder(p, "#btn-account"), "further", "under the account button", "car", "#btn-account");
  await at(p, await onlyUnder(p, "#btn-mode"), "further", "under the mode button", "car", "#btn-mode");

  step("every bottom-bar button that can show during a search covers: ✋, and Chat (once you have a chat) — GO ONLINE/OFFLINE: findnearestcover2.mjs; the others show only in a ride, when nobody's looked for");
  // (a chat to have: what shows the Chat button)
  await p.eval(`(chats.set(drivers[1], chats.get(drivers[1]) || { msgs: [] }), refreshControls(), true)`);
  const kids = await p.eval(`[...document.querySelectorAll("#bottom-controls > *")].filter((e) => !e.closest(".hidden") && e.getBoundingClientRect().width > 0).map((e) => e.id)`);
  check(kids.includes("btn-hand") && kids.includes("btn-chat"), "(the ✋ and Chat buttons showing)", kids);
  for (const id of kids) {
    const kb = await box(p, `#${id}`);
    await at(p, inside(kb), "further", `under the bottom bar's ${id}`, "car", "#bottom-controls > *");
  }
  await p.eval(`(chats.delete(drivers[1]), refreshControls(), true)`);

  step("the screen's edges: a pixel off doesn't count; a pixel on does (left, right, low on the screen)");
  const mid = Math.round(h * 0.55);
  await at(p, { x: hc.x - 1, y: mid }, "further", "a pixel off the left edge");
  await at(p, { x: hc.x + 1, y: mid }, "usual", "a pixel inside the left edge");
  await at(p, { x: w - hc.x + 1, y: mid }, "further", "a pixel off the right edge");
  await at(p, { x: w - hc.x - 1, y: mid }, "usual", "a pixel inside the right edge");

  step("a car right on your blue dot (drawn over it): in plain sight — found at once");
  await at(p, { x: Math.round(w / 2), y: Math.round(h / 2) }, "usual", "a car on your blue dot");

  step("the chat open: under it doesn't count; above it does");
  await p.eval(`(openChat(drivers[1]), true)`);
  await p.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat open");
  const chat = await box(p, "#chat");
  // (close by, under the chat, it stays under it as the map widens — toward
  // you, and you're under it too: never seen)
  await at(p, inside(chat, 0.3), "nobody", "under the chat, close by: never seen — 'nobody nearby yet'", "car", "#chat");
  await at(p, above(chat, hc.y, 2, Math.round(w / 2)), "usual", "just above the chat");
  await p.eval(`(closeChat(), true)`);
  await p.close();

  step("a shorter phone (390×600), the chat open within a marker of the screen's middle (the old strips said nobody could be seen): cars above it count — found at once");
  const s = await demo(browser, "BT-CoverShort", { w: 390, h: 600, scale: 2 });
  await freeze(s);
  await riderLooking(s);
  await s.eval(`(openChat(drivers[1]), true)`);
  await s.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, "the chat open");
  const sc = await box(s, "#chat");
  const ss = await mapSize(s);
  const hs = await half(s);
  check(sc.top - hs.y < ss.h / 2, "(the chat's top within a marker of the middle)", { sc, ss, hs });
  await at(s, above(sc, hs.y, 2, Math.round(ss.w / 2)), "usual", "above the chat, past the middle");
  await at(s, inside(sc, 0.3), "nobody", "under the chat: never seen — 'nobody nearby yet'", "car", "#chat");
  await s.eval(`(closeChat(), true)`);
  await s.close();

  step("the banner grows to 3 lines as the search starts: it stops where the GROWN banner leaves the car seen");
  const g = await demo(browser, "BT-CoverGrow", { w: 390, h: 844, scale: 2 });
  await freeze(g);
  await riderLooking(g);
  const gb = await box(g, "#banner");
  const hg = await half(g);
  await place(g, below(gb, hg.y, 3, 195));
  const before = await g.eval(`__o.stop(["car"])`);
  check(before.stop === 14, "(with one line, in sight at once)", before);
  // the banner grows the moment the search makes its first move — before it
  // first looks (100 ms later, the move itself 300 ms)
  await g.eval(`(__trace.length = 0, window.__onStep = (n) => { if (n === 1) { window.__setBanner = window.__setBanner || setBanner; setBanner = () => window.__setBanner(${JSON.stringify(LONG)}); setBanner(); } }, true)`);
  await g.click("btn-locate");
  await g.waitFor(`__trace.length >= 1`, "the first step");
  const grown = await g.eval(`__o.stop(["car"])`);
  check(await g.eval(`document.getElementById("banner").textContent.includes("A long line on purpose")`), "(the banner grew as the search started)");
  await g.eval(`(window.__onStep = null, true)`);
  check(grown.stop !== null && grown.stop < 14, "(the grown banner covers the car at the usual view)", grown);
  await g.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 30000);
  const gz = await g.eval(`({ z: map.getZoom(), nobody: nobodyNear, trace: __trace.slice() })`);
  check(Math.abs(gz.z - grown.stop) < 1e-6 && !gz.nobody, "stopped where the grown banner leaves the car seen", { gz, grown });
  await g.eval(`(setBanner = window.__setBanner, setBanner(contextBanner()), true)`);
  await g.close();
});
