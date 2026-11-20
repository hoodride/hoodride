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
  // reported too, not only the ones after it got going. And until the load
  // check (loadcheck.js, the page's last script) has looked (settle): a
  // file that arrived EMPTY makes the files after it crash, and only the
  // check can tell — those are its echo, dropped (fifth review,
  // 2026-11-19). No check (its file missing): sent once the page is read
  let target = null;
  let settled = false;
  // a file the app needs is missing (the check said): later crashes are echo
  let echo = false;
  const early = [];
  // the syntax errors of files that arrived CUT OFF: the cut, not a crash —
  // never sent, whatever the check decides (an optional file's too;
  // seventh review). By name|message: some browsers give no error object
  const cuts = new Set();
  // the app's own reports made during the start (reportError): they wait
  // for the check too (whenSettled; seventh review)
  const waiting = [];
  function deliver(e) {
    if (cuts.has(keyOf(e))) return;
    if (target && settled) {
      try {
        target(e);
      } catch (_) {
        // reporting never breaks anything
      }
    } else if (early.length < 5 && !early.some((x) => same(x, e))) early.push(e);
  }
  // the same error again (held: one copy — a repeat thrown every frame
  // never pushes a different one out; sixth review)
  function keyOf(x) {
    return x && typeof x === "object" ? `${x.name}|${x.message}` : String(x);
  }
  function same(a, b) {
    return keyOf(a) === keyOf(b);
  }
  function flush() {
    if (target && settled) early.splice(0).forEach(deliver);
  }
  // the check has looked: `drop` — a file the app needs is missing: what
  // crashed so far is its echo
  function settle(drop) {
    if (settled) return;
    settled = true;
    if (drop) {
      echo = true;
      early.splice(0);
      waiting.splice(0);
    }
    flush();
    waiting.splice(0).forEach((fn) => {
      try {
        fn();
      } catch (_) {
        // reporting never breaks anything
      }
    });
  }
  function settledYet() {
    return settled;
  }
  // run `fn` (a report) once the check has looked — now if it has (true),
  // else later (false), or never if it finds a needed file missing
  function whenSettled(fn) {
    if (settled) {
      fn();
      return true;
    }
    if (waiting.length < 5) waiting.push(fn);
    return false;
  }
  // the page's scripts that didn't arrive (owner, 2026-11-19: one phone's
  // sendfilter.js never did): a script's failed load is an "error" at the
  // script, which doesn't bubble — heard here only while it passes down
  // (capture). This file is the page's FIRST script: it hears every one
  // after it. HoodLoadCheck (loadcheck.js) acts on them; while any is
  // missing the crashes it sets off aren't reported (the app's handler)
  const failed = [];
  // …and those that CRASHED as they ran (TypeError…): a bug, not a missing
  // file — HoodLoadCheck never takes one for missing (owner, 2026-11-19)
  const crashed = [];
  // …and those THIS browser can't read: a syntax error not of the cut-off
  // kind — it's too old for our code (owner, 2026-11-19): "too old", never
  // "check your connection", never a reload. Its first words kept for the
  // report
  const unreadable = [];
  let unreadableFirst = "";
  function fileOf(src) {
    return String(src || "").split(/[?#]/)[0].split("/").pop();
  }
  function failedScripts() {
    return failed.slice();
  }
  function crashedScripts() {
    return crashed.slice();
  }
  function unreadableScripts() {
    return unreadable.slice();
  }
  function unreadableWords() {
    return unreadableFirst;
  }
  // a syntax error the browser met READING one of ours (not JSON, not a
  // selector the page refused — a DOMException also named SyntaxError)
  function cantRead(e, message) {
    const text = `${(e && e.name) || ""}: ${(e && e.message) || ""} ${message || ""}`;
    if (!/SyntaxError/.test(text) || /JSON/i.test(text)) return false;
    if (e && typeof e === "object" && (e.code === 12 || (typeof DOMException !== "undefined" && e instanceof DOMException))) return false;
    return true;
  }
  // one of the APP's script files, else null: our site, a .js (never the
  // page's own address, /ja → "ja"; fifth review), stamped with its version
  // (?vsn= — every script of the page is: LoadFailTest). Cloudflare adds
  // same-site scripts of its own (/cdn-cgi/…, on /privacy already): one
  // blocked is no file of the app missing (eighth review)
  function ours(src) {
    try {
      if (!src) return null;
      const url = new URL(src, location.href);
      // (by text: old Edge (16) — told "too old" — has no url.searchParams)
      if (url.origin !== location.origin || !/[?&]vsn=/.test(url.search)) return null;
      const file = fileOf(src);
      return /\.js$/.test(file) ? file : null;
    } catch (_) {
      return null;
    }
  }
  // a syntax error that means the file arrived CUT OFF: it ended mid-way
  // (Chrome "Unexpected end of input", Safari "…end of script", Firefox
  // "…got end of script"; Firefox's usual "missing } after function body"
  // — Firefox updates itself: far likelier a cut than an old one) or
  // mid-string (Firefox "unterminated string
  // literal"; Safari "Unexpected EOF"). Any other — an old browser that
  // can't read our code ("Unexpected token '?'"), a JSON one — is a crash:
  // reported, never "check your connection" (fifth review, 2026-11-19).
  // NOT Chrome's mid-string "Invalid or unexpected token": an old Chrome
  // (< 75) says the same for 60_000, which we ship — a cut there is
  // reported as a crash instead (sixth review)
  function cutOff(e, message) {
    const text = `${(e && e.name) || ""}: ${(e && e.message) || ""} ${message || ""}`;
    return (
      /SyntaxError/.test(text) &&
      /end of (input|script|file)|got end of script|unexpected eof|unterminated (string|template|comment|regular)|missing \} after function body/i.test(text) &&
      !/JSON/i.test(text)
    );
  }
  // a language's words (i18n-ja.js): missing, the app still works, in
  // English — what crashes then is no echo of it: still reported (the
  // same rule as HoodLoadCheck.languageFile; second review, 2026-11-19)
  function languageFile(file) {
    return /^i18n-[A-Za-z0-9-]+\.js$/.test(String(file));
  }
  // a file the app NEEDS didn't arrive — what crashes now is its echo (not
  // a language's words, nor the load check itself: the app runs without
  // them, and its reports go on — third review, 2026-11-19)
  function appFileMissing() {
    return echo || failed.some((f) => !languageFile(f) && f !== "loadcheck.js");
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("error", (ev) => deliver(ev.error || ev.message));
    window.addEventListener("unhandledrejection", (ev) => deliver(ev.reason));
    window.addEventListener(
      "error",
      (ev) => {
        // only OUR files, only while the page is read (its own scripts, in
        // order): another site's — Cloudflare's analytics, added after the
        // page and blocked by Brave and ad blockers — or one added later
        // isn't the app missing a file, and counted it muted every report
        // after (first review, 2026-11-19)
        if (document.readyState !== "loading") return;
        const el = ev.target;
        if (el && el !== window) {
          // a script that didn't load
          const file = el.tagName === "SCRIPT" ? ours(el.src) : null;
          if (file) failed.push(file);
          return;
        }
        // an error as one of ours ran — the RUNNING file's (the <script>
        // the page is on), not where it was thrown: a bug starting
        // ridepos.js may throw inside sendfilter.js (fifth review). Cut
        // off: not arrived whole; anything else, a bug in it
        // — and only while one RUNS: an error from a timer or an event as
        // the page is read is no file of ours crashing (by its address, one
        // stray error made "too old" over a working app; sixteenth review)
        const cur = document.currentScript;
        const file = cur ? ours(cur.src) : null;
        if (!file) return;
        if (cutOff(ev.error, ev.message)) {
          failed.push(file);
          // (both forms the app's handler may get: the error, or its words)
          cuts.add(keyOf(ev.error || ev.message));
          cuts.add(keyOf(ev.message));
        } else if (cantRead(ev.error, ev.message)) {
          unreadable.push(file);
          // (never sent as itself: an old browser's says so in one report;
          // a current one's means the file arrived cut off — HoodLoadCheck)
          cuts.add(keyOf(ev.error || ev.message));
          cuts.add(keyOf(ev.message));
          if (!unreadableFirst)
            unreadableFirst = String((ev.error && ev.error.message) || ev.message || "").replace(/^(Uncaught )?SyntaxError: /, "");
        } else crashed.push(file);
      },
      true
    );
    // the page read and no check settled it (loadcheck.js missing): send
    if (typeof document !== "undefined" && document.addEventListener)
      document.addEventListener("DOMContentLoaded", () => settle(false));
  }
  function attach(fn) {
    target = fn;
    flush();
  }

  return { create, scrub, places, isNetwork, attach, settle, settledYet, whenSettled, failedScripts, crashedScripts, unreadableScripts, unreadableWords, fileOf, languageFile, appFileMissing };
});
