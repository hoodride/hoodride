// "How far away" — shared by the browser (HoodDistance) and
// test_js/distance.test.mjs. ARCHITECTURE.md "Distances".
//
// THE DRIVE, ESTIMATED. Positions give the straight line; the drive is
// longer, and with no routing service (paid APIs send trips to a third
// party; a self-hosted router is a server of its own) the established
// estimate is the straight line times a "detour index" / "circuity factor"
// (Cole & King 1968; Love & Morris 1979 — it beat the grid "Manhattan"
// distance on urban samples; country factors, Ballou, Rahardja & Sakai
// 2002). Measured: US grid cities ~1.18-1.20, city pairs (median) 1.235,
// ~300 European cities ~1.34, curvy suburbs > 1.5; 1.3 is the usual middle
// (geocoding services quote it as "typical urban/suburban"). An average,
// not a route: one trip can be 1.0 or 2x (a river, a highway). Shown
// plainly, "0.8 mi away" (owner's choice, like most "X away" lists), not
// "0.8 mi".
//
// WHAT IT MEASURES TO, best first: the ride partner's exact position (only
// ride partners share one); the block they show on your map (a car or a ✋
// your role sees); the block they last SHARED by messaging or requesting a
// ride (someone not driving shares a ~170 m block that way — with its age,
// since it's a snapshot); else nothing. Never anyone's live position
// outside a ride.
//
// MILES OR KM, automatically — the standard way: the user's locale looked
// up in Unicode CLDR's unit preferences for ROAD length (the data phones'
// own formatters use; CLDR supplemental "unitPreferenceData"): mile for US
// and GB, kilometer for everyone else (the "001" world default). Browsers
// can't do this lookup themselves yet (TC39 "smart unit preferences",
// Stage 1), so it's done here: the region comes from the first browser
// language that names one (en-GB, fr-CA); if none does, the language's
// likeliest region (Intl.Locale maximize: en → US, de → DE); if nothing is
// usable, miles (Hood Ride launches in the US). navigator.languages, not
// Intl's default locale: Chrome builds that from its UI language and can
// lose the region. Known limit: iPhone Safari takes the region from the
// chosen LANGUAGE, not the Region setting.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodDistance = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t } = I18n;
  const ROAD_FACTOR = 1.3;
  const METERS_PER = { mi: 1609.34, km: 1000 };
  // under 0.1 mi by road (~160 m): "nearby" — the same real distance in
  // either unit
  const NEARBY_M = 0.1 * METERS_PER.mi;
  // CLDR length/road: the regions whose preference is mile
  const MILE_REGIONS = new Set(["US", "GB"]);

  // "mi" | "km" for these browser languages (navigator.languages)
  function unitOf(languages) {
    if (typeof Intl === "undefined" || typeof Intl.Locale !== "function") return "mi";
    const tags = [];
    for (const l of languages || []) {
      try {
        tags.push(new Intl.Locale(l));
      } catch (_) {} // not a language tag: skip it
    }
    const named = tags.find((tag) => tag.region);
    const region = named ? named.region : tags.length ? tags[0].maximize().region : undefined;
    if (!region) return "mi";
    return MILE_REGIONS.has(region) ? "mi" : "km";
  }

  // "0.8 mi" | "1.3 km" | "nearby" — `m` is the straight line
  function distance(m, unit) {
    const road = m * ROAD_FACTOR;
    if (road < NEARBY_M) return t("nearby");
    return `${(road / METERS_PER[unit]).toFixed(1)} ${unit}`;
  }

  // "0.8 mi away" | "nearby"
  function away(m, unit) {
    // (by the distance itself, not its words: those are translated)
    if (m * ROAD_FACTOR < NEARBY_M) return distance(m, unit);
    return t("{distance} away", { distance: distance(m, unit) });
  }

  // how long ago a shared block was sent — once it's a minute old
  function ago(ms) {
    if (ms == null || ms < 60_000) return "";
    const min = Math.floor(ms / 60_000);
    return min < 60 ? t("{n} min ago", { n: min }) : t("{n} h ago", { n: Math.floor(min / 60) });
  }

  // the position to measure to: {lat, lng, ageMs} (ageMs only for a shared
  // block: the server's age when it arrived + the time since), or null
  function target({ ridePos, mapPos, shared, now }) {
    if (ridePos) return { lat: ridePos.lat, lng: ridePos.lng, ageMs: null };
    if (mapPos) return { lat: mapPos.lat, lng: mapPos.lng, ageMs: null };
    if (shared) return { lat: shared.lat, lng: shared.lng, ageMs: shared.ageAtRx + (now - shared.rxAt) };
    return null;
  }

  // "0.6 mi away · 20 min ago" — or "" (no position of mine, or theirs)
  function label(here, target, metersBetween, unit) {
    if (!here || !target) return "";
    const age = ago(target.ageMs);
    return away(metersBetween(here, target), unit) + (age ? ` · ${age}` : "");
  }

  return { ROAD_FACTOR, unitOf, distance, away, ago, target, label };
});
