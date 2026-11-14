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

  // Cloudflare's script, once — fetched when the sign-in screen shows
  // (preload), so a tap doesn't wait for it (owner, 2026-11-14: sign-in got
  // slower). A failed fetch is tried again on the tap.
  let loading = null;
  function load(doc, win) {
    if (win.turnstile) return Promise.resolve(win.turnstile);
    if (loading) return loading;
    loading = new Promise((ok, fail) => {
      const s = doc.createElement("script");
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => (win.turnstile ? ok(win.turnstile) : fail(new Error("no turnstile")));
      s.onerror = () => fail(new Error("blocked"));
      doc.head.appendChild(s);
    }).catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  }

  // ahead of the tap, quietly: a blocker is only said on the tap. Only once
  // the page has loaded — a script added before that holds up the page's
  // own load event until Cloudflare answers (a journey caught it)
  const preload = (doc, win) =>
    new Promise((ok) => (doc.readyState === "complete" ? ok() : win.addEventListener("load", () => ok(), { once: true })))
      .then(() => load(doc, win))
      .catch(() => null);

  // one pass: rendered on the tap, run at once ("execute"), shown only if
  // it needs a click ("interaction-only"); the action the server expects
  function pass({ turnstile, siteKey, container, lang, setTimer = setTimeout }) {
    return new Promise((ok, fail) => {
      let id = null;
      // the box takes room only while Cloudflare needs a click (Turnstile's
      // before/after-interactive callbacks) — invisible, nothing on the
      // screen moves (owner, 2026-11-14: the button jumped down and back)
      const shown = (on) => container && container.classList && container.classList[on ? "add" : "remove"]("shown");
      const done = (f) => (v) => {
        shown(false);
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
        "before-interactive-callback": () => shown(true),
        "after-interactive-callback": () => shown(false),
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

  return { start, load, preload, SCRIPT };
});
