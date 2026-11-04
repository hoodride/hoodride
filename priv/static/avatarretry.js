// A profile photo that fails to load (a weak signal, a busy server).
// Shared by the browser (HoodAvatarRetry) and test_js/avatarretry.test.mjs.
//
// The app shows 🙂 at once (app.js, the image error handler), then — only
// for our own photos (/avatars/…), only while that image is still on screen
// and still showing our 🙂 — tries again, at most twice, after ~2 s and
// ~4 s, randomised so a list of failures doesn't retry in step. The way
// image components that retry do it (a few growing retries, then the
// placeholder), never looping on the fallback itself.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodAvatarRetry = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_RETRIES = 2;
  const BASE_MS = 2000;

  // the wait before retry number `done + 1`, or null: no more
  function retryDelay(done, random = Math.random) {
    if (done >= MAX_RETRIES) return null;
    return Math.round(BASE_MS * 2 ** done * (0.5 + random()));
  }

  // our own photos only (never the 🙂 data: URL, never anyone else's host)
  function ours(src) {
    if (typeof src !== "string" || !src) return false;
    try {
      return new URL(src, "http://x").pathname.startsWith("/avatars/") && !src.startsWith("data:");
    } catch (_) {
      return false;
    }
  }

  // a fresh address each time, so a failed answer is never reused
  function retryUrl(src, n) {
    return src.replace(/\?r=\d+$/, "") + "?r=" + n;
  }

  return { retryDelay, retryUrl, ours, MAX_RETRIES };
});
