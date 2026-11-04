// Update after deploy: when an app left open should reload. Shared by the
// browser (HoodUpdate) and test_js/update.test.mjs.
//
// A single-page app never navigates, so the browser never looks for a new
// version by itself: after a deploy, a page left open keeps running the old
// code. The page is stamped with the build it is (<meta name="hoodride-build">,
// HoodrideWeb.Build); the map channel's join reply says the server's. Best
// practice (Chrome's Workbox guide, LiveView's static tracking, common SPA
// practice): never yank a page someone is using — reload silently only
// while the app is hidden and nothing is in progress; otherwise offer
// "Update available — tap to reload" and wait for a safe moment.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodUpdate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // → "none" | "reload" (silently, now) | "offer" (the tap-to-reload button)
  function decide({ loadedBuild, serverBuild, hidden, busy }) {
    // nothing to compare: an older server, or a page that doesn't know its build
    if (!loadedBuild || !serverBuild || serverBuild === loadedBuild) return "none";
    return hidden && !busy ? "reload" : "offer";
  }

  // something a reload would interrupt: a ride, a request, a raised hand,
  // a shift, or a half-typed message (the reload restores the first four,
  // but a driver's GPS or a rider meeting up shouldn't blink for an update)
  // view: {mode, online, handRaised, ride: {status} | null, draft}
  function isBusy(view) {
    return (
      !!view.ride ||
      !!view.handRaised ||
      (view.mode === "driver" && !!view.online) ||
      (view.draft || "").trim() !== ""
    );
  }

  return { decide, isBusy };
});
