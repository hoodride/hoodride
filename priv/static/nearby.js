// Find the nearest (owner, 2026-11-07): Go online, ✋ Need a ride, or the
// locate button while either is on — the map centres on you and zooms just
// far enough out to show the nearest person you're looking for (a rider:
// cars; an online driver: ✋), but never past the widest view that still
// shows people one by one (beyond it the map shows counts). It uses only
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

  // The widest zoom (the smallest number) at which a screen centred here
  // still shows people one by one — at most `maxZoom`. Halving the range
  // until it's under a hundredth of a zoom level, then the answer is
  // checked as it is: a step in on any edge case, never one out.
  function widestMarkerZoom({ viewport, h3, center, size, rungs, budget, maxZoom }) {
    const fits = (z) => showsMarkers(viewport, h3, screenAt(center, z, size), rungs, budget);
    if (!fits(maxZoom)) return maxZoom;
    let lo = 1; // too wide (the whole world: counts, or nothing)
    let hi = maxZoom; // fits
    if (fits(lo)) return lo;
    while (hi - lo > 0.005) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    let z = Math.ceil(hi * 100) / 100;
    while (z < maxZoom && !fits(z)) z = Math.min(maxZoom, Math.round((z + 0.01) * 100) / 100);
    return z;
  }

  // The zoom at which `target` is on screen with the map centred on `me`,
  // clear of what covers the map's edges (`pad` {top, bottom, left, right}
  // px: the banner at the top, the buttons at the bottom) — the closest
  // such zoom. Infinity: the same spot (any zoom shows it).
  function fitZoom(me, target, size, pad) {
    const dx = ((target.lng - me.lng) / 360) * TILE; // px at zoom 0
    const dy = (mercY(target.lat) - mercY(me.lat)) * TILE; // + is down
    const roomX = size.w / 2 - (dx >= 0 ? pad.right : pad.left);
    const roomY = size.h / 2 - (dy >= 0 ? pad.bottom : pad.top);
    const zx = dx === 0 ? Infinity : Math.log2(Math.max(roomX, 1) / Math.abs(dx));
    const zy = dy === 0 ? Infinity : Math.log2(Math.max(roomY, 1) / Math.abs(dy));
    return Math.min(zx, zy);
  }

  function metersBetween(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLng = (b.lng - a.lng) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Where to put the camera, centred on `me`: `people` [{pos}] are those
  // the map has (each at the block it shows them in). Of those who'd be
  // on screen at the widest zoom, the nearest: the zoom showing them, never
  // closer than `maxZoom` (the usual view). None: the widest zoom, and
  // nearest null ("nobody nearby yet").
  function decide({ me, people, size, pad, widestZoom, maxZoom }) {
    let best = null;
    let bestM = Infinity;
    people.forEach((p) => {
      if (fitZoom(me, p.pos, size, pad) < widestZoom) return; // off that screen
      const m = metersBetween(me, p.pos);
      if (m < bestM) {
        best = p;
        bestM = m;
      }
    });
    if (!best) return { zoom: widestZoom, nearest: null };
    const z = Math.min(maxZoom, Math.max(widestZoom, fitZoom(me, best.pos, size, pad)));
    return { zoom: z, nearest: best };
  }

  // who you're looking for: a rider with ✋ up, cars; a driver online, ✋;
  // anyone else, or anyone in a ride, nobody (the button works as before)
  function lookingFor({ mode, handRaised, online, ride }) {
    if (ride) return null;
    if (mode === "rider" && handRaised) return "driver";
    if (mode === "driver" && online) return "hand";
    return null;
  }

  return { screenAt, showsMarkers, widestMarkerZoom, fitZoom, metersBetween, decide, lookingFor };
});
