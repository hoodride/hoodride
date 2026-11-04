// The last mode a person picked — "driver" or "rider" — remembered on this
// device per account, so a reload or a sign-in comes back as what they
// were. Shared by the browser (HoodModeStore) and
// test_js/modestore.test.mjs.
//
// Only the MODE: what the server knows (an online shift, a ride, riders
// waiting) still wins in app.js's hydrate, and going online is never
// restored from here — that's a tap and a location, always. Kept across a
// sign-out (the same person signing back in gets theirs back), per account
// (someone else on this phone doesn't inherit it); a deleted account's is
// forgotten. Storage can be blocked (private mode): then nothing is
// remembered and nothing breaks.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodModeStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MODES = new Set(["driver", "rider"]);

  function key(userId) {
    return `hoodride_mode_${userId}`;
  }

  // "driver" | "rider" | null
  function read(storage, userId) {
    if (!storage || userId == null) return null;
    try {
      const v = storage.getItem(key(userId));
      return MODES.has(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  function save(storage, userId, mode) {
    if (!storage || userId == null || !MODES.has(mode)) return;
    try {
      storage.setItem(key(userId), mode);
    } catch (_) {}
  }

  function forget(storage, userId) {
    if (!storage || userId == null) return;
    try {
      storage.removeItem(key(userId));
    } catch (_) {}
  }

  return { key, read, save, forget };
});
