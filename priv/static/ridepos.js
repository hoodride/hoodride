// Your ride partner's position: when you announce yours, when theirs is
// fresh, what auto-arrival may aim at, and "last seen". Shared by the
// browser (HoodRidePos) and test_js/ridepos.test.mjs.
//
// Positions travel only inside a ride (exact, partner to partner). The
// server keeps each person's LAST one for the ride, and a partner who
// (re)joins gets it right away with its age (RideChannel :confirm_seat) — a
// reloaded app no longer waits up to ~24 s for someone standing still.
//
// FRESH = younger than two of the longest heartbeats. Presence systems call
// someone gone only after ~two missed beats (PubNub: heartbeat =
// timeout/2 − 1), so a single late heartbeat never flashes "last seen".
// A stale position is still the best we have (a driver in Google Maps: a
// backgrounded web app gets no GPS, a platform limit) — so it's shown as
// "last seen …", and auto-arrival never fires on it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sendfilter.js"));
  else root.HoodRidePos = factory(root.HoodSendFilter);
})(typeof self !== "undefined" ? self : this, function (SendFilter) {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t } = I18n;
  const FRESH_MS = 2 * SendFilter.HEARTBEAT_MS * (1 + SendFilter.HEARTBEAT_JITTER);

  function fresh(ageMs) {
    return typeof ageMs === "number" && ageMs < FRESH_MS;
  }

  // a peer_pos as it arrives: the server's age (a rejoin hand-over) or 0
  // (live), and when it arrived on THIS device's steady clock
  function received(p, now) {
    return { lat: p.lat, lng: p.lng, ageAtArrival: typeof p.age_ms === "number" ? p.age_ms : 0, arrivedAt: now };
  }

  function ageMs(p, now) {
    return p.ageAtArrival + Math.max(0, now - p.arrivedAt);
  }

  // where auto-arrival aims: the pin, or the partner's EXACT and FRESH ride
  // position — never a browse spot's centre, never a stale position
  function arrivalTarget(peer, peerAgeMs) {
    if (peer.pin) return peer.pin;
    return peer.posExact && peer.pos && fresh(peerAgeMs) ? peer.pos : null;
  }

  // where Navigate goes (owner, 2026-11-02): the pin, or the partner's
  // EXACT ride position — a stale one too ("last seen there" says so) —
  // never a browse spot's centre (it went there when tapped too early)
  function navTarget(peer) {
    if (!peer) return null;
    if (peer.pin) return peer.pin;
    return peer.posExact === true && peer.pos ? peer.pos : null;
  }

  function lastSeen(peerAgeMs) {
    if (typeof peerAgeMs !== "number" || fresh(peerAgeMs)) return null;
    if (peerAgeMs >= 3_600_000) return t("last seen over an hour ago");
    return t("last seen {n} min ago", { n: Math.max(1, Math.round(peerAgeMs / 60_000)) });
  }

  // you announce your position only in a live ride, with a good reading
  // from the CURRENT watch (never a placeholder, coarse or leftover one)
  function mayAnnounce(ride, liveFix) {
    return !!ride && ["connected", "arrived"].includes(ride.status) && !!liveFix;
  }

  // "You've arrived" for a minute after "I'm here", then "Ride with X"
  // (owner, 2026-10-29: there's no trip-start
  // step, so "arrived" stayed up the whole drive). sinceMs: since arrival on
  // this device's steady clock; unknown (reloaded mid-ride) → riding
  const ARRIVED_SHOW_MS = 60_000;
  function arrivedPhase(sinceMs) {
    return typeof sinceMs === "number" && sinceMs < ARRIVED_SHOW_MS ? "arrived" : "riding";
  }

  // every ride (re)join: no "last sent", so the next tick announces at once
  // (an automatic rejoin used to keep the old send time and wait)
  function afterJoin() {
    return null;
  }

  return { FRESH_MS, fresh, received, ageMs, arrivalTarget, navTarget, lastSeen, mayAnnounce, afterJoin, ARRIVED_SHOW_MS, arrivedPhase };
});
