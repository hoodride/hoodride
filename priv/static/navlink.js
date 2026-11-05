// Navigate: the Google Maps directions link, and how to open it. A real
// link the driver taps — window.open(…, "_blank") made a new tab on
// iPhone that handed the link to the Google Maps app and was left behind,
// blank (owner, 2026-10-29). Phones: the SAME tab — the app takes the link
// (Google registers /maps/dir/* for com.google.Maps) and Hood Ride stays
// where it was; with no app, Google Maps' site opens and Back returns.
// Computers have no Maps app: a new tab, so Hood Ride stays open.
// Shared by the browser (HoodNavLink) and test_js/navlink.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodNavLink = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // The driver's own map app (owner, 2026-11-02 — as Uber's drivers pick
  // theirs). A website can't ask the phone for "the default map app" (iOS
  // has that setting only in the EU; geo: links aren't reliable from a web
  // page), so the driver chooses once. Each app's own documented web link:
  // the app opens when installed, else its website.
  const APPS = {
    // Google's Maps URLs: api=1, the comma encoded (%2C)
    google: { label: "Google Maps", url: (target) => `https://www.google.com/maps/dir/?api=1&destination=${target.lat}%2C${target.lng}` },
    // Apple: each iPhone the link of its own iOS. The unified directions
    // link came with iOS 18.4, and the old ?daddr= form "no longer behaves
    // as expected" on recent iOS — Apple's engineer pointed to the unified
    // one (developer forums thread 784030, May 2025); no source says older
    // iOS reads it, so they keep the old link that worked there.
    // Unreadable version: the current one.
    apple: {
      label: "Apple Maps",
      url: (target, ua) => {
        const v = iosVersion(ua);
        return v && (v[0] < 18 || (v[0] === 18 && v[1] < 4))
          ? `https://maps.apple.com/?daddr=${target.lat},${target.lng}&dirflg=d`
          : `https://maps.apple.com/directions?destination=${target.lat},${target.lng}&mode=driving`;
      },
    },
    // Waze's deep link (developers.google.com/waze/deeplinks)
    waze: { label: "Waze", url: (target) => `https://waze.com/ul?ll=${target.lat}%2C${target.lng}&navigate=yes` },
  };
  const KEY = "hoodride_navapp";

  // the iOS version in the browser's identity text ("iPhone OS 18_4_1"):
  // [major, minor], or null when it isn't an iPhone's
  function iosVersion(ua) {
    const m = /OS (\d+)_(\d+)/.exec(ua || "");
    return m && /iPhone|iPad|iPod/.test(ua) ? [Number(m[1]), Number(m[2])] : null;
  }

  // the directions address in `app` (Google Maps unless chosen), or null;
  // `ua`: the browser's identity text (Apple's link depends on the iOS)
  function href(target, app = "google", ua = "") {
    if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng) || !APPS[app]) return null;
    return APPS[app].url(target, ua);
  }

  // platform: HoodSendFilter.platformOf — "ios" | "android" | "other"
  function target(platform) {
    return platform === "ios" || platform === "android" ? "_self" : "_blank";
  }

  // what this phone can open: Apple Maps only on iPhone (elsewhere its
  // link is just a web page)
  function choices(platform) {
    return platform === "ios" ? ["google", "apple", "waze"] : ["google", "waze"];
  }

  function label(app) {
    return APPS[app] ? APPS[app].label : "";
  }

  // remembered on this phone only, never sent anywhere; a choice this
  // phone can't use, junk, or blocked storage: null (it asks again)
  function chosen(storage, platform) {
    if (!storage) return null;
    try {
      const v = storage.getItem(KEY);
      return choices(platform).includes(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  function choose(storage, app) {
    if (!storage || !APPS[app]) return;
    try {
      storage.setItem(KEY, app);
    } catch (_) {}
  }

  return { href, target, choices, label, chosen, choose, iosVersion };
});
