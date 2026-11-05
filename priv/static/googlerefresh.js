// "Refresh from Google" (owner, 2026-10-29). Hood Ride keeps its own copy of
// your name and photo, made when you sign in with Google — so a change made
// at Google needs a Google round trip to show here (no sign-out). After
// "Change on Google ↗" (in the Change box under your name, which also
// holds the "Refresh from Google" button), the next time you're back the
// app refreshes ONCE, silently (/auth/google?refresh=silent: Google shows
// nothing; any failure comes back still signed in) — unless something is in
// progress (HoodUpdate.isBusy, the rule app updates use). "Back" is any of:
// the page shown again, focus, or simply opening the app later (an iPhone
// home-screen app may never report the return). The button stays as the
// backup. Shared by the browser (HoodGoogleRefresh) and
// test_js/googlerefresh.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodGoogleRefresh = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t } = I18n;
  const DUE = "hoodride_google_refresh_due";
  // an earlier version also kept an "offer" flag (the button showed only
  // after Change); the button lives in the box now — signing out still
  // clears a phone's leftover
  const OLD_OFFER = "hoodride_google_refresh_offer";

  // storage can be missing or throw (private mode, blocked site data):
  // then nothing is remembered, and nothing breaks
  function get(s, k) {
    try {
      return !!s && s.getItem(k) === "1";
    } catch (_) {
      return false;
    }
  }
  function set(s, k) {
    try {
      if (s) s.setItem(k, "1");
    } catch (_) {}
  }
  function drop(s, k) {
    try {
      if (s) s.removeItem(k);
    } catch (_) {}
  }

  const isDue = (s) => get(s, DUE);

  // "Change on Google ↗" tapped: a refresh is due
  const changeTapped = (s) => set(s, DUE);

  // about to refresh: "due" goes FIRST — a refresh that fails can't loop
  const take = (s) => drop(s, DUE);

  // signed out: a shared phone's next person inherits nothing
  function forget(s) {
    drop(s, DUE);
    drop(s, OLD_OFFER);
  }

  // due, a Google account, back from being away, and nothing in progress
  function shouldRefresh({ due, google, away, busy }) {
    return !!(due && google && away && !busy);
  }

  // the server's answer after a refresh ("/?refresh=…"): what to tell the
  // person, or null. Only these; anything else in the address is ignored.
  // (Each a function: translated when shown, in the language then)
  const OUTCOMES = {
    failed: () => t("Couldn't refresh automatically — open Settings, tap Change, then Refresh from Google"),
    ride: () => t("You can refresh your name and photo after your ride"),
    limit: () => t("You've refreshed a lot — try again in a few minutes"),
    // the address is blocked for sign-ins (made-up codes from someone on
    // the same network): you're still signed in
    blocked: () => t("Couldn't refresh right now — try again later"),
  };
  function outcome(search) {
    const v = new URLSearchParams(search || "").get("refresh");
    return Object.prototype.hasOwnProperty.call(OUTCOMES, v) ? OUTCOMES[v]() : null;
  }

  // the address without the answer (it shouldn't show again on reload)
  function withoutOutcome(search) {
    const p = new URLSearchParams(search || "");
    p.delete("refresh");
    const rest = p.toString();
    return rest ? "?" + rest : "";
  }

  return { isDue, changeTapped, take, forget, shouldRefresh, outcome, withoutOutcome };
});
