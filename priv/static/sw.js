// named after the build when served (HoodrideWeb.PageController): no bumping
const CACHE = "hoodride-dev";
// everything the shell needs to BOOT must be install-time cached — h3,
// phoenix and maplibre are load-bearing, not optional (found by the
// offline-cache audit; maplibre is vendored so this list is complete).
// Served as "app.js?vsn=<fingerprint>" — the page's exact addresses
// (HoodrideWeb.StaticVersions): offline, only an exact match is found.
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "h3-js.umd.js",
  "viewport.js",
  "sync.js",
  "sendfilter.js",
  "locator.js",
  "browse.js",
  "rehydrate.js",
  "update.js",
  "session.js",
  "ridepos.js",
  "reveal_queue.js",
  "mapframe.js",
  "msgcopy.js",
  "boot.js",
  "avatarretry.js",
  "distance.js",
  "modestore.js",
  "viewstore.js",
  "readstore.js",
  "car.js",
  "icons.js",
  "avatar.js",
  "chatlist.js",
  "chatscroll.js",
  "navlink.js",
  "googlerefresh.js",
  "phoenix.min.js",
  "maplibre-gl.js",
  "maplibre-gl.css",
  "manifest.json",
  "car.png",
  "car-avatar.png",
  "hand.svg",
  "pin.svg",
  "compass.svg",
  "chat.svg",
  "hand-avatar.svg",
  "person.svg",
  "github-invertocat-white.svg",
  "discord-symbol-white.svg",
  "favicon.ico",
  "icon-180.png",
  "icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

// a new CACHE name wipes every older cache — including whatever an older
// worker stored that it shouldn't have (see the fetch rule below)
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only OUR OWN app files are cached, never /api/ or /auth/:
// - /api/state carries every conversation with its message text and the
//   ride. Cached, it would outlive logout on a shared
//   device and come back offline as stale "truth".
// - other sites (map tiles, the map style) are left to the browser's own
//   HTTP cache, which follows the provider's headers and its own size
//   limits. Caching them here grew without bound (Workbox warns this is
//   the top cause of quota blow-ups) and kept a record of every area viewed.
// Network first, fall back to cache when offline.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  // profile photos: the browser's own cache keeps them (private, immutable);
  // a copy here would hold others' photos past a sign-out, errors included
  if (url.pathname.startsWith("/avatars/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        // only a good answer: while the server is down Cloudflare answers
        // with its own error page, which must never replace the good copy
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
        // the server down (Cloudflare's 502/530 page, a restart's 503): the
        // saved app instead — it says "Can't reach Hood Ride — retrying…" and
        // comes back by itself. A 4xx is a real answer: passed on
        if (res.status >= 500) return caches.match(e.request).then((hit) => hit || res);
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
