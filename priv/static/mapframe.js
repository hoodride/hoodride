// Map updates on the phone. Shared by the browser (HoodMapFrame) and
// test_js/mapframe.test.mjs.
//
// Every car update used to redraw EVERY marker on screen at once (regroup
// all piles, draw each), so a busy area cost "messages × cars" per second.
// Standard practice for a live map: change the data at once, draw at most
// once per screen frame (requestAnimationFrame — the browser pauses it in a
// hidden tab, and the pending draw runs when the tab is shown again).
//
// The server may send map updates as one "batch" (WorldChannel, :map_batch_ms):
// its items are fed, in order, to the same handlers single messages use.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodMapFrame = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // items: [[event, payload], ...]; anything malformed is skipped
  function unbatch(items, handlers) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const [event, payload] = item;
      if (!payload || typeof payload !== "object") continue;
      const handle = handlers[event];
      if (typeof handle === "function") handle(payload);
    }
  }

  // schedule(): draw on the next frame — once, however often it's called
  function createFrameRender(draw, requestFrame) {
    let pending = false;
    return function schedule() {
      if (pending) return;
      pending = true;
      requestFrame(() => {
        pending = false;
        draw();
      });
    };
  }

  return { unbatch, createFrameRender };
});
