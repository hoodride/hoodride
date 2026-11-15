// Phones and tablets only (owner, 2026-11-14): a desktop gets "Hood Ride
// works on your phone" and a QR code (index.html #desktop-box), and the app
// never starts there — no map, no connection. Shared by the browser
// (HoodDevice) and test_js/device.test.mjs.
//
// The device's kind from Bowser (bowser.js, vendored — the most used
// user-agent library, MIT, no dependencies): its platform type "mobile" or
// "tablet". Plus the two gaps every user-agent library has, both checked by
// what the device can do (MDN: prefer feature detection):
//   * an iPad that says it's a Mac — iPadOS 13+ Safari sends a Mac's user
//     agent; a Mac has no touchscreen: "Macintosh" with more than one touch
//     point is an iPad (MDN's maxTouchPoints > 1; is-mobile's featureDetect);
//   * a big Android tablet in Chrome's desktop mode — it says "Linux"
//     (developer.chrome.com/blog/desktop-mode): touch is its main input
//     (pointer: coarse). A touchscreen laptop's main input is its mouse.
// Not a lock — any browser can claim to be a phone — a sign for people.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodDevice = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the phone words, if Bowser itself can't be had (it failed to load): a
  // phone is never turned away for that
  const PHONE = /Mobi|Android|iPhone|iPod|iPad/;

  // → true when Hood Ride opens on this device
  // parse: the user agent → Bowser's platform type ("mobile", "tablet",
  // "desktop", …), or null without Bowser. mobileHint: the browser's own
  // word (navigator.userAgentData.mobile — Chrome and its kin), else null
  function allowed({ userAgent, mobileHint, maxTouchPoints, coarse, parse }) {
    const ua = typeof userAgent === "string" ? userAgent : "";
    if (mobileHint === true) return true;
    // (Bowser throws on an empty user agent; any failure of its own: the
    // phone words decide, as without it)
    let type = null;
    let failed = !parse;
    if (parse && ua) {
      try {
        type = parse(ua);
      } catch (_) {
        failed = true;
      }
    }
    if (type === "mobile" || type === "tablet") return true;
    if (failed && PHONE.test(ua)) return true;
    if (/Macintosh/.test(ua) && maxTouchPoints > 1) return true;
    return coarse === true;
  }

  // this page's own device; the server's "any device" (dev, the tests:
  // PageController) opens it anywhere
  function here(win) {
    if (win.document.querySelector('meta[name="hoodride-any-device"]')) return true;
    const nav = win.navigator || {};
    const b = win.bowser;
    return allowed({
      userAgent: nav.userAgent,
      mobileHint: nav.userAgentData && typeof nav.userAgentData.mobile === "boolean" ? nav.userAgentData.mobile : null,
      maxTouchPoints: nav.maxTouchPoints || 0,
      coarse: !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches),
      parse: b && b.getParser ? (ua) => b.getParser(ua).getPlatformType(true) : null,
    });
  }

  return { allowed, here };
});
