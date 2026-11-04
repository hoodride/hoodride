// The map area last used — centre and zoom — remembered on this device per
// account, so the map opens where you were (the privacy page: "the app
// remembers the map area you last used so the map opens where you were";
// owner, 2026-10-29). Shared by the browser (HoodViewStore) and
// test_js/viewstore.test.mjs.
//
// Unlike the remembered mode (modestore.js), this is cleared on EVERY
// sign-out — the privacy page says "Signing out removes them" — and on a
// signed-out start (a sign-out from another device). Rounded to ~10 m.
// Storage can be blocked (private mode): then nothing is remembered and
// nothing breaks; anything malformed is ignored.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodViewStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PREFIX = "hoodride_view_";

  function key(userId) {
    return `${PREFIX}${userId}`;
  }

  const round = (x) => Math.round(x * 1e4) / 1e4;

  function valid(v) {
    return (
      v &&
      Number.isFinite(v.lng) &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.zoom) &&
      Math.abs(v.lng) <= 180 &&
      Math.abs(v.lat) <= 90 &&
      v.zoom >= 0 &&
      v.zoom <= 22
    );
  }

  // {lng, lat, zoom} | null
  function read(storage, userId) {
    if (!storage || userId == null) return null;
    try {
      const v = JSON.parse(storage.getItem(key(userId)));
      return valid(v) ? { lng: v.lng, lat: v.lat, zoom: v.zoom } : null;
    } catch (_) {
      return null;
    }
  }

  function save(storage, userId, view) {
    if (!storage || userId == null || !valid(view)) return;
    try {
      storage.setItem(key(userId), JSON.stringify({ lng: round(view.lng), lat: round(view.lat), zoom: round(view.zoom) }));
    } catch (_) {}
  }

  function forget(storage, userId) {
    if (!storage || userId == null) return;
    try {
      storage.removeItem(key(userId));
    } catch (_) {}
  }

  // every account's on this device
  function forgetAll(storage) {
    if (!storage) return;
    try {
      const mine = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(PREFIX)) mine.push(k);
      }
      mine.forEach((k) => storage.removeItem(k));
    } catch (_) {}
  }

  // where the map opens: the remembered area, else the placeholder at the
  // app's usual zoom
  function startView(saved, fallback, zoom = 14) {
    return saved ? { center: [saved.lng, saved.lat], zoom: saved.zoom } : { center: [fallback.lng, fallback.lat], zoom };
  }

  return { key, read, save, forget, forgetAll, startView };
});
