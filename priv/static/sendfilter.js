// When to send our own position. Pure rules, shared by the browser
// (HoodSendFilter) and test_js/sendfilter.test.mjs.
//
// Industry "distance filter + stationary heartbeat": send only when it
// matters — moved far enough (swallows parked GPS wobble), crossed into a
// different cell (`keys`, e.g. cell + parent cells), or the heartbeat came
// due. The heartbeat keeps a parked driver vouched-for: the server reaps
// drivers silent for 3 minutes as frozen. Each send draws its own heartbeat
// (20 s ±20% → 16–24 s, far inside the 3 min reap) so phones that
// reconnected together after a deploy don't stay in step. The ±20% is a
// judgement call (any ~10–50% meets the needs: spread fast, stay far inside
// the reap, keep the 20 s average); no standard fixes the fraction — SCTP
// (RFC 9260 §8.3) jitters only the ~1 s RTO part of its 30 s heartbeat.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodSendFilter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t, tc } = I18n;
  const HEARTBEAT_MS = 20000;
  const HEARTBEAT_JITTER = 0.2;
  // a browsing car is a SPOT: no distance is worth a send — only a new spot
  // (the `keys`) or the heartbeat
  const BROWSE_MIN_METERS = Infinity;
  const RIDE_MIN_METERS = 10; // mid-ride position (two people meeting up)

  // great-circle distance (haversine), metres
  function metersBetween(a, b) {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // last: what we last sent ({lat, lng, keys, at, heartbeatMs?}) or null
  function shouldSend(last, now, pos, keys, minMeters) {
    if (!last) return true;
    // a reload-seeded `last` has no drawn heartbeat: the plain period applies
    if (now - last.at >= (last.heartbeatMs ?? HEARTBEAT_MS)) return true;
    if (metersBetween(pos, last) >= minMeters) return true;
    return keys !== last.keys;
  }

  // record a send, drawing the next heartbeat
  function stamp(pos, keys, now, random) {
    const heartbeatMs = HEARTBEAT_MS * (1 + (random() * 2 - 1) * HEARTBEAT_JITTER);
    return { lat: pos.lat, lng: pos.lng, keys, at: now, heartbeatMs };
  }

  // ----- the fuzzed position: what a car or a ✋ says about where it is -----
  // On the browse map a car is a SPOT (a res-9 hex, ~block-sized) — never a
  // point; exact positions go only to a ride partner. Snapped to a fixed
  // grid, never jittered: random noise averages out over many updates.
  //
  // A plain "the hex I'm in" leaks at the edges: a phone parked on a border
  // wobbles across it, and the flip-flop pins it to that line (between
  // three hexes, to a corner). So the spot is STICKY (hysteresis): it moves
  // only when the move can't be GPS noise. The test is how much closer the
  // new hex's centre is than the current one's. A fix off by up to its
  // accuracy r can shift that difference by up to 2r (one distance grows by
  // r as the other shrinks by r), so the spot moves only past 2r. Very poor
  // fixes (indoors, Wi-Fi: hundreds of metres) would freeze a moving car,
  // so r is capped at half the hex's average edge (H3's own figure, ~100 m
  // at res 9): past one edge length, the move is real. The same rule against
  // a spot remembered on the device keeps a home on an edge from showing in
  // A one day and B the next.
  //
  // prev: the current spot (or null); f: {lat, lng, accuracy?} → the spot
  function stickySpot(prev, f, h3, res) {
    const here = h3.latLngToCell(f.lat, f.lng, res);
    if (!prev || here === prev) return here;
    const r = Math.min(f.accuracy || 0, h3.getHexagonEdgeLengthAvg(res, "m") / 2);
    const dist = (cell) => {
      const [lat, lng] = h3.cellToLatLng(cell);
      return metersBetween(f, { lat, lng });
    };
    return dist(prev) - dist(here) > 2 * r ? here : prev;
  }

  // Without a real GPS fix the app is at a placeholder location: nothing
  // may be broadcast from it, and nothing may be switched ON (a car or a ✋
  // there would be in the wrong city). Switching OFF is always allowed —
  // nobody gets stuck online. what: "send" | "turn_on" | "turn_off"
  function gpsAllows(haveFix, what) {
    return what === "turn_off" || !!haveFix;
  }

  // ----- location: the web.dev "User Location" checklist -----
  // Ask only on a tap; GPS only while something needs your position
  // (clearWatch otherwise); handle every error; a "finding" banner after
  // ~5 s. Plus one rule of ours: only a reading whose error fits in one
  // block (`accuracy`, the phone's own 95% radius, ≤ H3's average edge)
  // may place your car or ✋ or go to your ride partner. A coarser one —
  // GPS warming up, or iPhone's Precise Location off / Android's
  // "Approximate" (km-scale, on purpose) — only moves your blue dot.

  // Android's approximate location is "within about 3 km²" (≈ 1 km radius);
  // iPhone's approximate reports 3–9 km. Anything this coarse is the
  // phone's privacy setting, not GPS still warming up.
  const APPROXIMATE_M = 1000;
  const FINDING_AFTER_MS = 5000; // web.dev: banner if no result in ~5 s
  const PRECISE_HINT_AFTER_MS = 15000; // still nothing good: it's the setting

  // → "good" | "poor" | "approximate"
  function readingQuality(accuracy, h3, res = 9) {
    if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return "poor";
    if (accuracy <= h3.getHexagonEdgeLengthAvg(res, "m")) return "good";
    return accuracy >= APPROXIMATE_M ? "approximate" : "poor";
  }

  // GPS (a live watch) only while something needs your position NOW: on
  // duty, a ✋ waiting to be placed (a placed one is sent once and kept by
  // the server), GO ONLINE waiting for a good reading, or a ride under way.
  // A pending request sends nothing — GPS starts when the ride does.
  function gpsNeeded({ mode, online, ride, pending }) {
    if (pending && (pending.online || pending.hand)) return true;
    if (mode === "driver" && online) return true;
    return !!ride && (ride.status === "connected" || ride.status === "arrived");
  }

  function platformOf(userAgent) {
    if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
    if (/Android/.test(userAgent)) return "android";
    return "other";
  }

  // which browser, for the steps (its own switch) — named ONLY when it says
  // so: Brave can hide its mark and Firefox on iPhone can send Safari's
  // exact identity, so app: null means "looks like Safari / unknown" and the
  // wording covers both. hasBraveApi: navigator.brave exists (Brave's own
  // recommended check). In-app browsers (Instagram, Facebook): location
  // belongs to THAT app. → { platform, app }
  function browserOf(userAgent, hasBraveApi = false) {
    const ua = userAgent || "";
    const platform = platformOf(ua);
    const marks =
      platform === "ios"
        ? [[/Instagram/, "Instagram"], [/FBAN|FBAV/, "Facebook"], [/CriOS\//, "Chrome"], [/FxiOS\//, "Firefox"],
           [/EdgiOS\//, "Edge"], [/\bBrave\b/, "Brave"]]
        : platform === "android"
          ? [[/SamsungBrowser\//, "Samsung Internet"], [/EdgA\//, "Edge"], [/Firefox\//, "Firefox"], [/\bBrave\b/, "Brave"]]
          : [];
    const found = marks.find(([re]) => re.test(ua));
    if (found) return { platform, app: found[1] };
    if (hasBraveApi) return { platform, app: "Brave" };
    // Android without another mark: Chrome (its address-bar steps fit the
    // other Chrome-based browsers too)
    return { platform, app: platform === "android" ? "Chrome" : null };
  }

  // what location is for: the end of a sentence ("… allow it {why}")
  const PURPOSE = {
    drive: () => tc("why location is needed", "to drive"),
    hand: () => tc("why location is needed", "to ask for a ride"),
    ride: () => tc("why location is needed", "so your ride partner can find you"),
    request: () => tc("why location is needed", "so your driver can find you"),
    locate: () => tc("why location is needed", "to show where you are"),
  };

  // iPhone: Apple's one path, to the browser APP's switch (Apple: Settings ›
  // Privacy & Security › Location Services › the app). Safari's entry is
  // "Safari Websites"; unknown might be a browser hiding its name.
  function iosEntry(app) {
    return app ? app : t("Safari Websites (or your browser's name, if you don't use Safari)");
  }
  // Android: the phone lets the browser app use location (Settings › Apps)
  function androidAppSteps(app) {
    return t("Settings › Apps › {app} › Permissions › Location", { app: app || t("your browser") });
  }

  // Chrome on Android (May 2026) asks "Precise / Approximate" per site; a
  // site set to Approximate is undone from the address-bar icon (Google:
  // Permissions › Reset permissions), then the question comes again
  function chromeLike(app) {
    return app !== "Samsung Internet" && app !== "Firefox";
  }

  function preciseSteps(p, app, standalone) {
    if (p === "ios") return t("Settings › Privacy & Security › Location Services › {app} › Precise Location: on", { app: iosEntry(app) });
    if (p === "android") {
      const phone = t("{steps} › Use precise location", { steps: androidAppSteps(app) });
      return chromeLike(app) && !standalone
        ? t(
            "{steps} — or, if you chose Approximate for Hood Ride: tap the icon at the left of the web address › Permissions › Reset permissions, then try again and choose Precise",
            { steps: phone }
          )
        : phone;
    }
    return t("allow precise location for this site in your browser's settings");
  }

  // in a browser tab: the browser's own site permission (Google's address-bar
  // steps for Chrome and the browsers built on it; Samsung's and Firefox's
  // menus), then the phone's switch for that app. An installed app
  // (standalone) has no address bar: the browser's own settings. iPhone
  // keeps one Settings path for both.
  function allowSteps(p, app, standalone) {
    // Precise too, on the same screen: Hood Ride places you within one block,
    // which "approximate" can't
    if (p === "ios")
      return t("Settings › Privacy & Security › Location Services › {app} › While Using the App, and turn on Precise Location", {
        app: iosEntry(app),
      });
    if (p === "android") {
      const site =
        app === "Samsung Internet"
          ? t("open the menu › Settings › Sites and downloads › Site permissions › Location")
          : app === "Firefox"
            ? t("open ⋮ › Settings › Site settings › Location › Ask to allow")
            : standalone
              ? t("open {app} › ⋮ › Settings › Site settings › Location › allow Hood Ride", { app: app || t("your browser") })
              : t("tap the icon at the left of the web address bar (top of the screen) › Permissions › Location › Allow (choose Precise if asked)");
      return t("{site} — and in your phone's {steps} › Allow, with Use precise location on", { site, steps: androidAppSteps(app) });
    }
    return standalone
      ? t("open your browser's Settings › Privacy and security › Site settings › Location › allow Hood Ride")
      : t("click the icon at the left of the web address bar (top of the browser) › Location › Allow");
  }
  const DEVICE_STEPS = {
    ios: () => t("turn on Location Services (Settings › Privacy & Security)"),
    android: () => t("turn on Location (swipe down › Location)"),
    other: () => t("turn on location for this device"),
  };

  // what to tell someone about their location, or null for nothing.
  // status: "searching" | "denied" | "unavailable"
  // quality: of the latest reading (null = none yet); waitedMs: since asked
  // permission: the browser's answer so far ("prompt" = still unanswered)
  // standalone: running as an installed app (no web address bar)
  // app: the browser, when it says which (browserOf) — null: unknown
  function locationMessage({ status, quality, waitedMs, platform, app = null, context, permission, standalone }) {
    const why = (PURPOSE[context] || PURPOSE.locate)();
    const p = DEVICE_STEPS[platform] ? platform : "other";
    // on a phone the fix is in Settings, OUTSIDE the browser — which keeps
    // its "no" for the open page; coming back reloads (locator.js onVisible)
    if (status === "denied") {
      const steps = t("📍 Location is blocked for Hood Ride — allow it {why}: {steps}", { why, steps: allowSteps(p, app, standalone) });
      return p === "other" ? steps : t("{steps}. Hood Ride reloads when you come back.", { steps });
    }
    if (status === "unavailable") return t("📍 Location is off on this device — {steps} {why}", { steps: DEVICE_STEPS[p](), why });
    // an unanswered prompt sends no callback at all (Firefox "Not now", or
    // just ignored): the question is still open — it isn't the setting
    if (quality !== "approximate" && permission === "prompt" && waitedMs >= PRECISE_HINT_AFTER_MS)
      return t("📍 Allow location when your browser asks — Hood Ride needs it {why}", { why });
    if (quality === "approximate" || waitedMs >= PRECISE_HINT_AFTER_MS)
      return t("📍 Your location is only approximate — turn on Precise Location {why}: {steps}", {
        why,
        steps: preciseSteps(p, app, standalone),
      });
    if (waitedMs >= FINDING_AFTER_MS) return t("📍 Finding your location…");
    return null;
  }

  // on duty but sending nothing (no trusted reading): the server drops a
  // silent car after 3 minutes, so say plainly that riders can't see you —
  // and, if location is blocked or off, why
  function noFixBanner({ haveFix, mode, online, geoStatus, platform, app = null, standalone }) {
    if (haveFix || mode !== "driver" || !online) return null;
    if (geoStatus === "denied" || geoStatus === "unavailable") {
      const why = locationMessage({ status: geoStatus, platform, app, context: "drive", standalone });
      return t("Riders can't see you. {why}", { why });
    }
    return t("📍 Waiting for your location — riders can't see you yet");
  }

  // (where auto-arrival aims — the pin, or an EXACT and FRESH partner
  // position, never a block centre — lives in ridepos.js: arrivalTarget)

  // after a reload the server row already holds our last position: seed the
  // filter WITHOUT sending (GPS hasn't fixed yet; sending would teleport the
  // marker). The first real fix far enough away, or the heartbeat, restamps.
  function seed(pos, keys, now) {
    return { lat: pos.lat, lng: pos.lng, keys, at: now };
  }

  return {
    metersBetween,
    shouldSend,
    stamp,
    seed,
    stickySpot,
    gpsAllows,
    noFixBanner,
    readingQuality,
    gpsNeeded,
    platformOf,
    browserOf,
    locationMessage,
    FINDING_AFTER_MS,
    PRECISE_HINT_AFTER_MS,
    HEARTBEAT_MS,
    HEARTBEAT_JITTER,
    BROWSE_MIN_METERS,
    RIDE_MIN_METERS,
  };
});
