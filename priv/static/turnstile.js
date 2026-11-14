// Cloudflare Turnstile on sign-in (review 2026-11-14; the server's side:
// HoodrideWeb.Turnstile). Off — no site key on the page — sign-in goes
// straight to Google, as before. On: when the sign-in button is tapped, the
// check runs (invisible for nearly everyone; at most one checkbox, in the
// reader's language), its pass is POSTed — never in the address, which
// ends up in logs — and the server, having checked it with Cloudflare,
// says where to go. Shared by the browser (HoodTurnstile) and
// test_js/turnstile.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodTurnstile = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  // the check's own wait at most (then: couldn't check — the person is told)
  const WAIT_MS = 30000;

  // Cloudflare's script, once (on the first sign-in tap, not on every page)
  function load(doc, win) {
    if (win.turnstile) return Promise.resolve(win.turnstile);
    return new Promise((ok, fail) => {
      const s = doc.createElement("script");
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => (win.turnstile ? ok(win.turnstile) : fail(new Error("no turnstile")));
      s.onerror = () => fail(new Error("blocked"));
      doc.head.appendChild(s);
    });
  }

  // one pass: rendered on the tap, run at once ("execute"), shown only if
  // it needs a click ("interaction-only"); the action the server expects
  function pass({ turnstile, siteKey, container, lang, setTimer = setTimeout }) {
    return new Promise((ok, fail) => {
      let id = null;
      const done = (f) => (v) => {
        if (id !== null) {
          try {
            turnstile.remove(id);
          } catch (_) {}
        }
        id = null;
        f(v);
      };
      const yes = done(ok);
      const no = done(() => fail(new Error("check")));
      id = turnstile.render(container, {
        sitekey: siteKey,
        action: "signin",
        appearance: "interaction-only",
        execution: "execute",
        language: lang || "auto",
        callback: yes,
        "error-callback": no,
        "expired-callback": no,
        "timeout-callback": no,
      });
      turnstile.execute(container);
      setTimer(() => id !== null && no(), WAIT_MS);
    });
  }

  // → { url } where to go, or { error: "blocked" | "failed" }
  async function start(provider, { siteKey, getTurnstile, container, lang, post, setTimer }) {
    const fallback = `/auth/${provider === "facebook" ? "facebook" : "google"}`;
    if (!siteKey) return { url: fallback };
    let token;
    try {
      token = await pass({ turnstile: await getTurnstile(), siteKey, container, lang, setTimer });
    } catch (_) {
      // the check couldn't run here (a blocker, a privacy setting) — said so
      return { error: "blocked" };
    }
    try {
      const r = await post({ provider, token });
      if (r && r.go) return { url: r.go };
    } catch (_) {}
    return { error: "failed" };
  }

  return { start, load, SCRIPT };
});
