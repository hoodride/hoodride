// Error reports from phones (owner, 2026-11-10): when the app hits an
// unexpected error, a small report goes to the server — WHAT broke, never
// who: the kind, the message scrubbed of anything personal (links, emails,
// numbers of 2+ digits — ids, positions, phone numbers), the code places (file and
// line only), the screen, the app version, the browser family. Each
// distinct error once; at most 5 a minute, 30 a session; a failed send is
// dropped quietly (reporting never breaks the app).
// Shared by the browser (HoodErrors) and test_js/errors.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodErrors = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_MESSAGE = 200;
  const PER_MINUTE = 5;
  const PER_SESSION = 30;
  const PLACES = 3;
  const WHERE = ["map", "chat", "ride", "settings", "search", "start", "sync", "other"];

  // anything that could name or place a person: out
  function scrub(text) {
    return String(text)
      .replace(/\b(?:https?|wss?):\/\/\S+/gi, "<link>")
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
      // a number of 2+ digits (with its . - ( ) and spaces: a phone number, a
      // position) — small account ids are 1–3 digits; a lone digit stays
      .replace(/\d[\d.\-() ]*\d/g, "<n>")
      .slice(0, MAX_MESSAGE);
  }

  // "file.js:line:col" for the first few frames: no host, no query
  function places(stack) {
    const out = [];
    const re = /([\w.-]+\.js)(?:\?[^:\s)]*)?:(\d+):(\d+)/g;
    let m;
    while ((m = re.exec(String(stack || ""))) && out.length < PLACES) out.push(`${m[1]}:${m[2]}:${m[3]}`);
    return out;
  }

  function describe(e, where, build, browser) {
    const isErr = e && typeof e === "object" && "message" in e;
    return {
      kind: isErr && typeof e.name === "string" && /^\w{1,40}$/.test(e.name) ? e.name : "Error",
      message: scrub(isErr ? e.message : String(e)),
      at: isErr ? places(e.stack) : [],
      where: WHERE.includes(where) ? where : "other",
      build,
      browser,
    };
  }

  function create({ send, now, build, browser }) {
    const seen = new Set();
    let total = 0;
    let windowStart = -Infinity;
    let inWindow = 0;
    return {
      report(e, where = "other") {
        try {
          const r = describe(e, where, build, browser);
          const key = `${r.kind}|${r.message}|${r.at[0] || ""}`;
          if (seen.has(key) || total >= PER_SESSION) return;
          const at = now();
          if (at - windowStart >= 60000) {
            windowStart = at;
            inWindow = 0;
          }
          if (inWindow >= PER_MINUTE) return;
          seen.add(key);
          inWindow += 1;
          total += 1;
          send(r);
        } catch (_) {
          // never: a report failing must not break what it reports on
        }
      },
    };
  }

  // a failure of the network, not of the code: "Failed to fetch" (Chrome),
  // "NetworkError when attempting to fetch" (Firefox), "Load failed"
  // (Safari), the map's AJAXError for its files
  function isNetwork(e) {
    const name = e && typeof e === "object" ? String(e.name || "") : "";
    const msg = e && typeof e === "object" ? String(e.message || "") : String(e);
    return (
      name === "AJAXError" ||
      /^(Failed to fetch|NetworkError when attempting to fetch|Load failed|The network connection was lost)/.test(msg) ||
      // (and the browser's own harmless notice — not a failure at all; a
      // map resizing sets it off: seen in the journeys, 2026-11-10)
      /^ResizeObserver loop/.test(msg)
    );
  }

  // in the page: errors caught from the very START — this file loads before
  // the app's own — and queued (up to 5) until the app attaches its handler
  // (attach, the app's first lines): a crash while the app is starting is
  // reported too, not only the ones after it got going
  let target = null;
  const early = [];
  function deliver(e) {
    if (target) {
      try {
        target(e);
      } catch (_) {
        // reporting never breaks anything
      }
    } else if (early.length < 5) early.push(e);
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("error", (ev) => deliver(ev.error || ev.message));
    window.addEventListener("unhandledrejection", (ev) => deliver(ev.reason));
  }
  function attach(fn) {
    target = fn;
    early.splice(0).forEach(deliver);
  }

  return { create, scrub, places, isNetwork, attach };
});
