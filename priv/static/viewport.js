// Which H3 cells to watch for a map view. Pure functions — no map, no DOM,
// no globals — so the exact code the app runs is also run by the Node test
// suite (test_js/viewport.test.mjs). `h3` is passed in (the h3-js API).
// Rects are {n, s, e, w} in degrees.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodViewport = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EARTH_RADIUS_KM = 6371.0088;

  // The cheap size measure: rect area ÷ average hex area at `res` ≈ how many
  // cells touch it. Choosing the level from a measure like this, instead of
  // listing cells to find out, is the standard level-of-detail pattern
  // (deck.gl TileLayer picks tile zoom from a target tile size, Cesium from
  // screen-space error, CARTO's H3 layer from zoom). It used to be "list,
  // then check the budget", which froze the page zoomed out (cost ×4 per
  // zoom level; over a minute at zoom 5).
  function estimatedCells(h3, rect, res) {
    const rad = Math.PI / 180;
    const areaKm2 =
      EARTH_RADIUS_KM ** 2 *
      Math.min((rect.e - rect.w) * rad, 2 * Math.PI) *
      Math.abs(Math.sin(Math.min(rect.n, 85) * rad) - Math.sin(Math.max(rect.s, -85) * rad));
    return areaKm2 / h3.getHexagonAreaAvg(res, h3.UNITS.km2);
  }

  // Every cell that TOUCHES the rect, or null if more than `limit`.
  //
  // OVERLAP, not centre: plain polygonToCells counts a cell only if its
  // CENTRE is inside, so zoomed in (screen smaller than a cell) it returned
  // nothing and the map went blank with a car mid-screen. H3's overlap mode
  // includes a cell if its centre is inside, the rect lies inside it, or
  // their borders cross. h3-js is pinned at 4.5.0 because H3 still labels
  // this API experimental; if it's ever missing or throws, fall back to
  // centres plus the cells under the corners and centre.
  function cellsInRect(h3, rect, res, limit) {
    const set = new Set();
    for (const piece of worldPieces(rect)) {
      cellsInPiece(h3, piece, res).forEach((c) => set.add(c));
      if (set.size > limit) return null;
    }
    return set;
  }

  // MapLibre longitudes are continuous: pan around the globe and the same
  // street reads −434 or 286. H3 needs −180…180 and cannot take a polygon
  // spanning the 180° line ("does not support polygons with two adjacent
  // points > 180 degrees of longitude apart" — H3 polygonAlgos.h; deck.gl's
  // CARTO H3 layer splits wide boxes for the same reason). So shift the rect
  // into range, and split it in two where it crosses 180°.
  function worldPieces(rect) {
    if (rect.e - rect.w >= 360) return [{ ...rect, w: -180, e: 180 }];
    const k = Math.round((rect.e + rect.w) / 2 / 360);
    const w = rect.w - 360 * k;
    const e = rect.e - 360 * k;
    if (w < -180) return [{ ...rect, w: w + 360, e: 180 }, { ...rect, w: -180, e }];
    if (e > 180) return [{ ...rect, w, e: 180 }, { ...rect, w: -180, e: e - 360 }];
    return [{ ...rect, w, e }];
  }

  function cellsInPiece(h3, rect, res) {
    const corners = [
      [rect.n, rect.w],
      [rect.n, rect.e],
      [rect.s, rect.e],
      [rect.s, rect.w],
    ];
    try {
      return h3.polygonToCellsExperimental(
        [corners],
        res,
        h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping
      );
    } catch (_) {
      let cells;
      try {
        cells = h3.polygonToCells([corners], res);
      } catch (_e) {
        cells = [];
      }
      [...corners, [(rect.n + rect.s) / 2, (rect.e + rect.w) / 2]].forEach(([lat, lng]) =>
        cells.push(h3.latLngToCell(lat, lng, res))
      );
      return cells;
    }
  }

  // the rect grown by about one cell width (√3 × average edge) on every side
  function padRect(h3, r, res) {
    const padKm = Math.sqrt(3) * h3.getHexagonEdgeLengthAvg(res, h3.UNITS.km);
    const dLat = padKm / 111.32;
    const midLat = Math.min(Math.abs((r.n + r.s) / 2), 85) * (Math.PI / 180);
    const dLng = padKm / (111.32 * Math.cos(midLat));
    return { n: r.n + dLat, s: r.s - dLat, e: r.e + dLng, w: r.w - dLng };
  }

  function rectContains(outer, inner) {
    return inner.n <= outer.n && inner.s >= outer.s && inner.e <= outer.e && inner.w >= outer.w;
  }

  // The ladder (finest first, e.g. markers → agg7 → agg5). Choose the finest
  // level whose padded area is ESTIMATED to fit the budget, list it once,
  // and step one level coarser only if the EXACT count breaks the budget.
  // The estimate only steers which level is listed; the exact check is what
  // guarantees the server is never asked for more than `budget` cells.
  // Returns {res, rect, cells} — rect being what was watched — or null when
  // even the coarsest level doesn't fit (the zoom floor).
  function planWatch(h3, screen, rungs, budget) {
    let i = rungs.findIndex((res) => estimatedCells(h3, padRect(h3, screen, res), res) <= budget);
    for (; i >= 0 && i < rungs.length; i++) {
      const res = rungs[i];
      const rect = padRect(h3, screen, res);
      const cells = cellsInRect(h3, rect, res, budget);
      if (cells !== null) return { res, rect, cells };
    }
    return null;
  }

  return { estimatedCells, cellsInRect, padRect, rectContains, planWatch };
});
