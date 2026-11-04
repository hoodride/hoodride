// Opening the app: who is this? Shared by the browser (HoodBoot) and
// test_js/boot.test.mjs.
//
// The app used to show the sign-in screen for ANY failure of /api/state —
// a deploy restart (Cloudflare's 502), a database hiccup (500), the rate
// limit (429), no signal — though the session was fine. The rule auth
// clients follow: only a real "signed out" answer means signed out (here:
// 200 with user null, or 401/403); on anything else keep the session and
// try again, with a growing, randomised wait (the app's reconnect backoff),
// the server's own Retry-After when it gives one, and at once when the
// phone comes back online or the app is shown again.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodBoot = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // a Retry-After longer than this is treated as this: a bad header can't
  // park the app for an hour
  const MAX_RETRY_AFTER_MS = 60000;

  // r: {status, body, retryAfter} or null (no answer)
  function classify(r) {
    if (!r) return "retry";
    if (r.status === 401 || r.status === 403) return "out";
    if (r.status === 200 && r.body && typeof r.body === "object" && "user" in r.body)
      return r.body.user ? "in" : "out";
    return "retry";
  }

  // only the seconds form ("120"); a date or anything odd: use the backoff
  function retryAfterMs(header) {
    if (header == null || !/^\d+$/.test(String(header).trim())) return null;
    const ms = Number(header) * 1000;
    return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
  }

  // fetchState() → {status, body, retryAfter} (may throw); backoff(attempt)
  // → ms; onWaiting(attempt) after each failure; onError(e) if entering the
  // app itself throws (that is not a server failure: no retry, no sign-out)
  function create({ fetchState, onSignedIn, onSignedOut, onWaiting, backoff, setTimer, clearTimer, onError }) {
    let done = false;
    let busy = false;
    let timer = null;
    let attempt = 0;

    async function check() {
      if (done || busy) return;
      busy = true;
      if (timer) clearTimer(timer);
      timer = null;
      let r = null;
      try {
        r = await fetchState();
      } catch {
        r = null;
      }
      busy = false;
      const verdict = classify(r);
      if (verdict === "retry") {
        attempt++;
        onWaiting(attempt);
        timer = setTimer(check, retryAfterMs(r && r.retryAfter) ?? backoff(attempt));
        return;
      }
      done = true;
      try {
        if (verdict === "in") await onSignedIn(r.body);
        else onSignedOut();
      } catch (e) {
        if (onError) onError(e);
      }
    }

    return { start: check, poke: check };
  }

  return { classify, retryAfterMs, create, MAX_RETRY_AFTER_MS };
});
