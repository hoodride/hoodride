// Find the nearest (owner, 2026-11-07; step by step and the box rule
// 2026-11-09): Go online, ✋ Need a ride, or the locate button while either
// is on — the map centres on you and steps out half a level at a time
// (from the usual view, or closer in on a screen so big it shows counts
// there) until the nearest person you're looking for (a rider: cars; an
// online driver: ✋) is in sight — their whole marker, under nothing drawn
// over the map — but never past the widest view that still shows people one
// by one (beyond it the map shows counts). It uses only
// what the map already shows: no "where's the nearest?" question to the
// server, so nothing new about anyone's position leaves it.
//
// Pure functions — no map, no DOM — so the exact code the app runs is also
// run by the Node test suite (test_js/nearby.test.mjs). The map is MapLibre's:
// flat, north-up, 512-px tiles, Web Mercator. Rects are {n, s, e, w}.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodNearby = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const TILE = 512;
  const RAD = Math.PI / 180;
  const EARTH_M = 6371008.8;

  // a latitude's place down the world map, 0 (top) … 1 (bottom)
  function mercY(lat) {
    const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * RAD);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function latOf(y) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;
  }

  // what a screen of `size` {w, h} CSS px shows, centred on `center` {lat,
  // lng} at `zoom` — as map.getBounds() reads it
  function screenAt(center, zoom, size) {
    const world = TILE * 2 ** zoom;
    const cy = mercY(center.lat);
    const hw = size.w / 2 / world;
    const hh = size.h / 2 / world;
    return { n: latOf(cy - hh), s: latOf(cy + hh), e: center.lng + hw * 360, w: center.lng - hw * 360 };
  }

  // the people one by one: the first rung of the map's ladder
  // (HoodViewport.planWatch — the same call the map makes, so the two can't
  // disagree about where cars turn into counts)
  function showsMarkers(viewport, h3, rect, rungs, budget) {
    const plan = viewport.planWatch(h3, rect, rungs, budget);
    return !!plan && plan.res === rungs[0];
  }

  // Where the search starts (owner, 2026-11-09): the usual view `maxZoom` —
  // unless the screen is so big (a 2560×1440 monitor) that it already shows
  // counts there, not people one by one (the block limit): then the first
  // zoom closer in that does, to a hundredth (at most `limitZoom`).
  function markerStartZoom({ viewport, h3, center, size, rungs, budget, maxZoom, limitZoom = 18 }) {
    const fits = (z) => showsMarkers(viewport, h3, screenAt(center, z, size), rungs, budget);
    if (fits(maxZoom)) return maxZoom;
    // halving over whole hundredths (no rounding afterwards: rounding a
    // fraction up overshot by a hundredth, and left a sliver of a step)
    let lo = Math.round(maxZoom * 100); // counts
    let hi = Math.round(limitZoom * 100);
    if (!fits(hi / 100)) return hi / 100;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid / 100)) hi = mid;
      else lo = mid;
    }
    return hi / 100;
  }

  // The widest zoom (the smallest number) at which a screen centred here
  // still shows people one by one — at most `maxZoom`. Halving over whole
  // hundredths (as markerStartZoom): the answer is always one that was
  // checked to fit, and the work is bounded (~12 checks) whatever the
  // planner answers — never a hundredth-by-hundredth walk.
  function widestMarkerZoom({ viewport, h3, center, size, rungs, budget, maxZoom }) {
    const fits = (z) => showsMarkers(viewport, h3, screenAt(center, z, size), rungs, budget);
    if (!fits(maxZoom)) return maxZoom;
    let lo = 100; // too wide (the whole world: counts, or nothing)
    let hi = Math.round(maxZoom * 100); // fits
    if (fits(lo / 100)) return lo / 100;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid / 100)) hi = mid;
      else lo = mid;
    }
    return hi / 100;
  }

  // Where `pos` lands on a screen of `size` CSS px centred on `me` at `zoom`
  // (px from the screen's top-left) — as the map draws it: flat, north up
  // (the map never turns or tilts). Across the 180° line the map draws the
  // nearer copy of the world: the shorter way round.
  function screenPoint(me, pos, zoom, size) {
    const scale = TILE * 2 ** zoom;
    const dLng = ((((pos.lng - me.lng + 180) % 360) + 360) % 360) - 180;
    return {
      x: size.w / 2 + (dLng / 360) * scale,
      y: size.h / 2 + (mercY(pos.lat) - mercY(me.lat)) * scale,
    };
  }

  // How far a drawn marker reaches from its middle, each side on its own
  // ({l, r, t, b} px): its box `el` and the boxes of what it draws (a
  // group's "+N" badge pokes out of one corner only). Boxes:
  // {left, right, top, bottom}; an empty one (not laid out) is skipped.
  function markerReach(el, parts) {
    const cx = (el.left + el.right) / 2;
    const cy = (el.top + el.bottom) / 2;
    let l = cx - el.left;
    let r = el.right - cx;
    // (up/down, not t: t is the translation helper — never hidden)
    let up = cy - el.top;
    let down = el.bottom - cy;
    for (const p of parts) {
      if (!(p.right > p.left && p.bottom > p.top)) continue;
      l = Math.max(l, cx - p.left);
      r = Math.max(r, p.right - cx);
      up = Math.max(up, cy - p.top);
      down = Math.max(down, p.bottom - cy);
    }
    return { l, r, t: up, b: down };
  }

  // "If you can see it on the map, it counts" (owner, 2026-11-09): a marker
  // centred at `pt`, reaching `reach` px each side ({l, r, t, b}, as
  // markerReach measures it; or {x, y}: the same each way — a single
  // marker's 22), is in sight when the WHOLE marker is on the screen and
  // overlaps none of the `covers` — the boxes of everything over the map,
  // measured where they are ({top, bottom, left, right}, the map's pixels).
  // Touching an edge is fine; one pixel over isn't. Written so that anything
  // that isn't a number (broken data) is NOT in sight: a cover that can't be
  // measured counts as covering.
  function inSight(pt, reach, size, covers) {
    // its middle off the screen: not in sight — and its size never measured
    // (a crowd far off costs nothing)
    if (!(pt.x >= 0 && pt.x <= size.w && pt.y >= 0 && pt.y <= size.h)) return false;
    const l = pt.x - (reach.l ?? reach.x);
    const r = pt.x + (reach.r ?? reach.x);
    const top = pt.y - (reach.t ?? reach.y);
    const bottom = pt.y + (reach.b ?? reach.y);
    if (!(l >= 0 && r <= size.w && top >= 0 && bottom <= size.h)) return false;
    return covers.every((c) => r <= c.left || l >= c.right || bottom <= c.top || top >= c.bottom);
  }

  function metersBetween(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLng = (b.lng - a.lng) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // The zooms the search steps through (owner, 2026-11-09): the usual view
  // first, then `step` wider each time (half a level: twice the ground),
  // ending exactly at the widest view that still shows people one by one.
  // A step less than half a step short of the widest is left out: a sliver
  // of a last step would be one more wait for the server, for nothing.
  function zoomSteps(maxZoom, widestZoom, step) {
    const zs = [maxZoom];
    for (let z = maxZoom - step; z >= widestZoom + step / 2 - 1e-9; z -= step) zs.push(Math.round(z * 100) / 100);
    if (widestZoom < maxZoom) zs.push(widestZoom);
    return zs;
  }

  // When everyone a search found has gone, how long before it looks again
  // (owner, 2026-11-09): 5 s, doubling each time it keeps happening (`n`:
  // how many times so far), at most 60 s — each ±20% at random (`rand` in
  // [0, 1)): phones that lose the same car don't all ask the server at once
  // (as the location heartbeat, sendfilter.js)
  function researchWait(n, rand) {
    const base = Math.min(5000 * 2 ** Math.max(0, n), 60000);
    return base * (1 + 0.2 * (2 * rand - 1));
  }

  // Time passed since `at` ({p, d}: the steady clock — performance.now — and
  // the wall clock — Date.now) by `now` (the same): whichever says more. A
  // phone asleep stops the steady clock; a clock set back stops the wall
  // clock: never "no time passed" either way.
  function elapsed(at, now) {
    return Math.max(now.p - at.p, now.d - at.d);
  }

  // The steps of a search that looks again from where the map is (`from`):
  // only those as wide or wider — never zooming back in (nobody in sight
  // here means nobody closer in either); wider than the widest: the widest
  function stepsFrom(steps, from) {
    const out = steps.filter((z) => z <= from + 1e-6);
    return out.length ? out : steps.slice(-1);
  }

  // Anyone in sight on a screen of `size` centred on `me` at `zoom` (the
  // search's next step, worked out before the map gets there). `people`
  // [{pos, half?}]: where the map shows them, how far their marker reaches
  // each side ({l, r, t, b}, measured only when asked — or {x, y}; else
  // `half`).
  function anyoneAt({ me, people, size, covers, zoom, half }) {
    return people.some((p) => inSight(screenPoint(me, p.pos, zoom, size), p.half || half, size, covers));
  }

  // How far a solid ring drawn round an element reaches past its box (px),
  // from its computed style: a box-shadow that is only a spread — no
  // offset, no blur, not inset, not invisible (the raised ✋'s yellow ring)
  // — or an outline (a focus ring: its width and offset). Soft shadows
  // don't count (you see the map through them). Nothing: 0. (Every engine
  // writes it the same way: the colour, then the lengths in px.)
  function ringReach({ boxShadow, outlineStyle, outlineWidth, outlineOffset }) {
    let reach = 0;
    for (const part of shadows(boxShadow)) {
      if (/\binset\b/.test(part) || invisible(part)) continue;
      const n = (part.replace(/[a-z-]+\([^)]*\)/gi, "").match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
      if (n.length === 4 && n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] > 0) reach = Math.max(reach, n[3]);
    }
    const w = parseFloat(outlineWidth) || 0;
    if (outlineStyle && outlineStyle !== "none" && w > 0) reach = Math.max(reach, w + (parseFloat(outlineOffset) || 0));
    return reach;
  }

  // a box-shadow's shadows, one by one (a comma inside a colour, as in
  // rgb(1, 2, 3), doesn't split one)
  function shadows(value) {
    if (!value || value === "none") return [];
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of String(value)) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
  // a shadow you can't see: "transparent", or a colour whose ALPHA is 0 —
  // after the slash of rgb(0 0 0 / 0), or the 4th value of rgba(0, 0, 0, 0)
  // (never a colour that merely ends in 0: rgb(255, 204, 0) is yellow)
  function invisible(part) {
    if (/\btransparent\b/i.test(part)) return true;
    const m = /\(([^)]*)\)/.exec(part);
    if (!m) return false;
    const alpha = m[1].includes("/") ? m[1].split("/")[1] : m[1].split(",")[3];
    return alpha !== undefined && parseFloat(alpha) === 0;
  }

  // who you're looking for: a rider with ✋ up, cars; a driver online, ✋;
  // anyone else, or anyone in a ride, nobody (the button works as before)
  function lookingFor({ mode, handRaised, online, ride }) {
    if (ride) return null;
    if (mode === "rider" && handRaised) return "driver";
    if (mode === "driver" && online) return "hand";
    return null;
  }

  return { ringReach, researchWait, stepsFrom, elapsed, screenAt, showsMarkers, markerStartZoom, widestMarkerZoom, screenPoint, markerReach, inSight, metersBetween, zoomSteps, anyoneAt, lookingFor };
});
