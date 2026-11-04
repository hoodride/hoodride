// The device you chose last wins: what this tab says when it connects.
// Shared by the browser (HoodSession) and test_js/session.test.mjs.
//
// The server gives a tab a STAMP (a fencing token, Hoodride.SessionStamp)
// when a connect of it is a CHOICE: a page load, a refresh, "Use here".
// Until the tab has its stamp, connecting is that choice (takeover). After,
// every connect is automatic and carries the stamp: it gets in only if no
// newer choice exists — so a phone that missed "you moved" can't come back
// and kick the laptop in use.
//
// The stamp lives in this page's memory only: a duplicated tab copies
// sessionStorage, and two tabs holding one stamp would both pass as "the
// chosen one". The one exception is our silent update reload (update.js):
// not a choice, so it hands the stamp to the reloaded page in a one-time
// note, read and deleted the moment the page starts.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodSession = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const NOTE = "hoodride_quiet_reload_stamp";

  // the socket params of the next connect attempt (strings: they travel in
  // the URL; a stamp is ~1.8e15 µs, inside JS's exact integers)
  function connectParams(stamp) {
    return stamp === null || stamp === undefined
      ? { takeover: "true" }
      : { stamp: String(stamp), takeover: "false" };
  }

  // just before our own silent reload
  function noteQuietReload(storage, stamp) {
    if (stamp === null || stamp === undefined) return;
    try {
      storage.setItem(NOTE, String(stamp));
    } catch (_) {}
  }

  // at page start: the stamp a quiet reload handed over, or null (a page
  // load the user caused). Read once: the next refresh is a choice again.
  function takeQuietReload(storage) {
    try {
      const v = storage.getItem(NOTE);
      storage.removeItem(NOTE);
      return v !== null && /^[1-9]\d{0,19}$/.test(v) ? Number(v) : null;
    } catch (_) {
      return null;
    }
  }

  // where "Sign in with Google" goes: Google, except on this machine, where
  // the dev login works (the server allows it only for a local request)
  function loginRoute(hostname) {
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "dev" : "google";
  }

  return { connectParams, noteQuietReload, takeQuietReload, loginRoute };
});
