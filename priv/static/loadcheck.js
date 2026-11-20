// Did every file of the app arrive? (owner, 2026-11-19: on one phone
// sendfilter.js never did — ridepos.js and app.js crashed on it, and the
// app sat broken with no word.) The page's LAST script: by now every other
// one has run, or failed to arrive.
//
// The standard fix (Vite's docs: reload when a file fails to load; the
// write-ups that hit its traps): reload the page — not the one file: the
// files after it have already run without it — at most RELOADS times in
// WINDOW_MS, counted in sessionStorage (a timer alone loops forever when a
// failing load takes longer than it); storage that can't keep the count:
// no reload at all (it couldn't stop). Still missing: the page's own
// message (#load-fail, in the reader's language — put there by the server,
// PageController.with_load_fail) with "Try again", and a try by itself when
// the phone comes back online (web.dev's offline page). The count is
// cleared once everything arrived.
//
// Which files: HoodErrors.failedScripts() (errors.js, the page's first
// script, hears every script after it that fails to load); errors.js
// itself, and anything when it's missing, by the globals they make.
// Shared by the browser (HoodLoadCheck) and test_js/loadcheck.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodLoadCheck = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const KEY = "hoodride-load-retry";
  const RELOADS = 2;
  const WINDOW_MS = 5 * 60 * 1000;

  // every script of the page (but this one, and a language's words) and
  // what it makes when it ran — asked only when the reporter (errors.js)
  // is missing: then it heard nothing (third review, 2026-11-19). The same
  // list as index.html's (loadcheck.test.mjs). app.js: one of its own
  // functions (a declared function is the page's)
  const MAKES = [
    ["errors.js", "HoodErrors"],
    ["maplibre-gl.js", "maplibregl"],
    ["phoenix.min.js", "Phoenix"],
    ["h3-js.umd.js", "h3"],
    ["i18n.js", "HoodI18n"],
    ["viewport.js", "HoodViewport"],
    ["sync.js", "HoodSync"],
    ["sendfilter.js", "HoodSendFilter"],
    ["locator.js", "HoodLocator"],
    ["browse.js", "HoodBrowse"],
    ["rehydrate.js", "HoodRehydrate"],
    ["update.js", "HoodUpdate"],
    ["session.js", "HoodSession"],
    ["ridepos.js", "HoodRidePos"],
    ["reveal_queue.js", "HoodRevealQueue"],
    ["mapframe.js", "HoodMapFrame"],
    ["msgcopy.js", "HoodMsgCopy"],
    ["boot.js", "HoodBoot"],
    ["avatarretry.js", "HoodAvatarRetry"],
    ["distance.js", "HoodDistance"],
    ["modestore.js", "HoodModeStore"],
    ["viewstore.js", "HoodViewStore"],
    ["readstore.js", "HoodReadStore"],
    ["car.js", "HoodCar"],
    ["icons.js", "HoodIcons"],
    ["avatar.js", "HoodAvatar"],
    ["chatlist.js", "HoodChatList"],
    ["chatmerge.js", "HoodChatMerge"],
    ["chatscroll.js", "HoodChatScroll"],
    ["navlink.js", "HoodNavLink"],
    ["googlerefresh.js", "HoodGoogleRefresh"],
    ["langswitch.js", "HoodLang"],
    ["nearby.js", "HoodNearby"],
    ["turnstile.js", "HoodTurnstile"],
    ["bowser.js", "bowser"],
    ["device.js", "HoodDevice"],
    // (its LAST line sets it: cut between two statements, app.js still reads)
    ["app.js", "HoodAppRan"],
  ];

  // the files that didn't arrive (has(name) → is it there?): those the
  // reporter heard fail (or arrive cut off), and those whose name is missing
  // — one that arrived EMPTY says nothing else (owner, 2026-11-19) — but
  // never one that CRASHED as it ran: a bug, reported, not "check your
  // connection" — nor one this browser couldn't READ (too old for it:
  // "too old"). The reporter missing, it heard nothing: every file whose
  // name is missing
  function missing({ has, failed, crashed, unreadable }) {
    if (!has("HoodErrors")) return MAKES.filter(([, name]) => !has(name)).map(([file]) => file);
    const out = [...(failed || [])];
    const not = [...(crashed || []), ...(unreadable || [])];
    for (const [file, name] of MAKES) if (!has(name) && !out.includes(file) && !not.includes(file)) out.push(file);
    // app.js unfinished after a crash, and nothing else it needs missing:
    // not arrived (else its crash is the other one's echo)
    if (crashedUnfinishedApp(crashed, has) && !out.includes("app.js") && !out.some((f) => !optional(f))) out.push("app.js");
    return out;
  }

  // app.js that didn't reach its last line, even after a crash: cut off
  // mid-word, what arrived throws ("fun is not defined") — not arrived
  // (seventeenth review). Its report is still sent (run → settle): a real
  // bug at its top level shows in the log, and fails the journeys first
  function crashedUnfinishedApp(crashed, has) {
    // (app.js the ONLY one that crashed: after another's crash — a bug
    // there — its own is that one's echo; Lee's journey)
    // (only the files the app NEEDS: a language's words crashing beside it
    // can't have made it crash — eighteenth review)
    const c = (crashed || []).filter((f) => !optional(f));
    return c.length === 1 && c[0] === "app.js" && !has("HoodAppRan");
  }

  // the demo talks to no server: no report from it (app.js: the same)
  // (by text: old Edge (16) — told "too old" — has no URLSearchParams;
  // twelfth review)
  function demo(search) {
    return /[?&]demo(?:[=&]|$)/.test(String(search || ""));
  }

  // a language's words (i18n-ja.js: it only hands HoodI18n its words).
  // Never i18n.js itself: the app needs that one. (errors.js: the same rule)
  function languageFile(file) {
    return /^i18n-[A-Za-z0-9-]+\.js$/.test(String(file));
  }

  // the files the app runs WITHOUT: a language's words (in English — second
  // review), the reporter (no reports: app.js asks first), this check
  // (third review, 2026-11-19)
  function optional(file) {
    return languageFile(file) || file === "errors.js" || file === "loadcheck.js";
  }

  // {action: "ok" | "reload" | "message" | "run", attempt} — store: {read,
  // write, remove} (sessionStorage; any of them may throw). Only files the
  // app runs without missing, past the reloads: "run" — on without them,
  // never the message over a working app. ("too old" is never decided
  // here: run() → oldFiles, before)
  function decide({ missing: miss, store, now }) {
    const d = decideAny({ missing: miss, store, now });
    return d.action === "message" && miss.every(optional) ? { action: "run", attempt: d.attempt } : d;
  }

  function decideAny({ missing: miss, store, now }) {
    if (miss.length === 0) {
      try {
        store.remove();
      } catch (_) {
        // nothing kept: nothing to clear
      }
      return { action: "ok", attempt: 0 };
    }
    let count;
    try {
      const saved = JSON.parse(store.read() || "null");
      const fresh = saved && typeof saved.n === "number" && typeof saved.since === "number" && now - saved.since < WINDOW_MS && now >= saved.since;
      count = fresh ? saved : { n: 0, since: now };
    } catch (_) {
      // can't read the count: can't stop a reload — none
      return { action: "message", attempt: 0 };
    }
    if (count.n >= RELOADS) return { action: "message", attempt: count.n };
    const next = JSON.stringify({ n: count.n + 1, since: count.since });
    try {
      store.write(next);
      // (written, and kept: a write that "works" but keeps nothing would
      // reload forever)
      if (store.read() !== next) return { action: "message", attempt: count.n };
    } catch (_) {
      return { action: "message", attempt: count.n };
    }
    return { action: "reload", attempt: count.n + 1 };
  }

  // the one report: which files, and what's done about it
  function report(miss, { action, attempt }) {
    return {
      kind: "LoadError",
      message: `file missing: ${miss.join(" ")} (${action === "reload" ? `reloading, try ${attempt}` : action === "run" ? "gave up: runs without it" : "gave up"})`,
      at: [],
      where: "start",
    };
  }

  // the report for a browser too old for our code: which files it couldn't
  // read, and its own words for why
  // a browser OLDER than us with any file the app needs broken —
  // unreadable, crashed (old Edge's parse errors may not say
  // "SyntaxError"), or missing: it can't run the app, whatever its words —
  // "too old" (fifteenth review). → those files, or null
  function oldFiles({ ua, unreadable, crashed, missing: miss }) {
    if (!olderThanUs(ua)) return null;
    // (what it couldn't read is the cause — the crashes after it are its
    // echo, not named; nothing unread: whatever broke)
    const needed = (list) => list.filter((f, i) => !optional(f) && list.indexOf(f) === i);
    const cause = needed(unreadable);
    const files = cause.length ? cause : needed([...crashed, ...miss]);
    return files.length ? files : null;
  }

  function oldReport(files, words) {
    return { kind: "OldBrowser", message: `can't read: ${files.join(" ")}${words ? ` (${words})` : ""}`, at: [], where: "start" };
  }

  // which browser, from its own description — sendfilter.js (which names it
  // for the app) may be what it couldn't read. A name and its main version:
  // what's too old
  function browserName(ua) {
    const s = String(ua || "");
    const m =
      /SamsungBrowser\/(\d+)/.exec(s) ? ["SamsungInternet", /SamsungBrowser\/(\d+)/.exec(s)[1]]
      : /Edg(?:e|A|iOS)?\/(\d+)/.exec(s) ? ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/.exec(s)[1]]
      : /(?:Firefox|FxiOS)\/(\d+)/.exec(s) ? ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/.exec(s)[1]]
      : /(?:Chrome|CriOS)\/(\d+)/.exec(s) ? ["Chrome", /(?:Chrome|CriOS)\/(\d+)/.exec(s)[1]]
      : /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//.exec(s) ? ["Safari", /Version\/(\d+)/.exec(s)[1]]
      : null;
    return m ? `${m[0]}/${m[1]}` : "other";
  }

  // is this browser OLDER than our build's target (config :esbuild:
  // chrome/edge 80, firefox 78, safari 13.1, ios 13.4)? From its own
  // description; the engine counts (Samsung Internet: its Chrome; any
  // iPhone browser: its iOS). Unknown: no (eleventh review, 2026-11-19)
  function olderThanUs(ua) {
    const s = String(ua || "");
    const num = (re) => {
      const m = re.exec(s);
      return m ? [Number(m[1]), Number(m[2] || 0)] : null;
    };
    const below = (v, major, minor) => v[0] < major || (v[0] === major && v[1] < minor);
    // the old Edge (EdgeHTML), all of it
    if (/Edge\/\d+/.test(s)) return true;
    const ios = num(/(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/);
    if (ios) return below(ios, 13, 4);
    const firefox = num(/Firefox\/(\d+)\.?(\d+)?/);
    // (78: car.js's /\p{C}/u — esbuild only rewrites it for older; twelfth review)
    if (firefox) return below(firefox, 78, 0);
    const chrome = num(/Chrome\/(\d+)\.?(\d+)?/);
    if (chrome) return below(chrome, 80, 0);
    const safari = num(/Version\/(\d+)\.?(\d+)?[^ ]* Safari\//);
    if (safari) return below(safari, 13, 1);
    return false;
  }

  function run() {
    const heard = typeof HoodErrors !== "undefined" && HoodErrors.failedScripts;
    const has = (name) => typeof self[name] !== "undefined";
    const crashed = heard && HoodErrors.crashedScripts ? HoodErrors.crashedScripts() : [];
    const heardFailed = heard ? HoodErrors.failedScripts() : [];
    const unreadable = heard && HoodErrors.unreadableScripts ? HoodErrors.unreadableScripts() : [];
    // "too old" — decided HERE alone (oldFiles: older than us AND a needed
    // file broken; sixteenth review: a second place let a language's words
    // alone show it over a working app). A browser too old for our code: its
    // crashes are that — one report says so instead
    const old = oldFiles({ ua: navigator.userAgent, unreadable, crashed, missing: missing({ has, failed: heardFailed, crashed, unreadable }) });
    if (old) {
      if (heard && HoodErrors.settle) HoodErrors.settle(true);
      return tooOld(old);
    }
    // not too old: what it couldn't read arrived cut off — missing
    const failed = heardFailed.concat(unreadable.filter((f) => !heardFailed.includes(f)));
    const miss = missing({ has, failed, crashed, unreadable: [] });
    // the reporter's start-up errors: a file the app needs missing — they
    // are its echo, dropped; else sent (HoodErrors.settle; fifth review).
    // Kept when what's missing also CRASHED (app.js unfinished): it may be
    // a real bug — its report must reach the log
    if (heard && HoodErrors.settle) HoodErrors.settle(miss.some((f) => !optional(f) && !crashed.includes(f)));
    const store = {
      read: () => window.sessionStorage.getItem(KEY),
      write: (v) => window.sessionStorage.setItem(KEY, v),
      remove: () => window.sessionStorage.removeItem(KEY),
    };
    const d = decide({ missing: miss, store, now: Date.now() });
    if (d.action === "ok") return;
    if (!demo(location.search)) send(report(miss, d));
    if (d.action === "reload") return refresh(miss).then(() => location.reload());
    if (d.action === "run") return;
    const el = document.getElementById("load-fail");
    if (!el) return;
    el.hidden = false;
    // back online: try again by itself (once — a page that fails again
    // shows this again, its count used up: no loop). It and "Try again"
    // fetch the missing files afresh first, as the reloads do: a broken
    // copy kept by the browser would come back (eighth review). (Try again
    // stays a plain link: with no script it reloads all the same)
    const again = () => refresh(miss).then(() => location.reload());
    window.addEventListener("online", again, { once: true });
    const link = document.getElementById("load-fail-retry");
    if (link)
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        again();
      });
  }

  // too old for our code: says so, with no "Try again" (nothing to retry
  // — a newer browser is the way); the server put its words in the reader's
  // language (PageController.with_load_fail). One report, naming it
  function tooOld(files) {
    // (the reporter may be what it couldn't read: no words then)
    const words = typeof HoodErrors !== "undefined" && HoodErrors.unreadableWords ? HoodErrors.unreadableWords() : "";
    if (!demo(location.search)) send(oldReport(files, words), browserName(navigator.userAgent));
    const el = document.getElementById("load-fail");
    if (!el) return;
    // (forEach, not for…of: old Edge's element lists can't be iterated —
    // the very browser to be told; fourteenth review)
    Array.prototype.forEach.call(el.querySelectorAll(".load-fail-text, #load-fail-retry"), (part) => {
      part.hidden = true;
    });
    const old = el.querySelector(".load-fail-old");
    if (old) old.hidden = false;
    el.hidden = false;
  }

  // the missing files fetched afresh — past the browser's cache — before
  // the reload: one that came broken as a full answer is kept a year (our
  // files are versioned, immutable), and a plain reload took it from the
  // cache again (seventh review, 2026-11-19). Their own addresses, as the
  // page asks for them; at most REFRESH_MS, never failing. Each read to its
  // END: a reload while one still downloads cut it off, and the copy kept
  // was the broken one (eighth review)
  const REFRESH_MS = 5000;
  function refresh(miss) {
    try {
      return refreshFrom({
        // (not [...document.scripts]: old Edge can't iterate it)
        srcs: Array.prototype.map.call(document.scripts, (s) => s.src),
        miss,
        get: (src) => fetch(src, { cache: "reload" }),
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
    } catch (_) {
      return Promise.resolve();
    }
  }

  // (the page's script addresses `srcs`, `get(src)` → a response, `wait`)
  function refreshFrom({ srcs, miss, get, wait }) {
    const fetches = srcs
      .filter((src) => src && miss.includes(String(src).split(/[?#]/)[0].split("/").pop()))
      .map((src) =>
        Promise.resolve()
          .then(() => get(src))
          .then((r) => r.arrayBuffer())
          .catch(() => {})
      );
    return Promise.race([Promise.all(fetches), wait(REFRESH_MS)]).catch(() => {});
  }

  // straight to the server (errors.js may be the missing file); keepalive:
  // it still goes as the page reloads. Never fails anything
  function send(r, named) {
    try {
      const meta = document.querySelector('meta[name="hoodride-build"]');
      // the browser, as app.js names it, when sendfilter.js is here to tell
      // (an old one that can't read our code is no network problem)
      let browser = named || "?";
      if (!named) {
        try {
          const br = HoodSendFilter.browserOf(navigator.userAgent, !!navigator.brave);
          browser = `${String(br.app || "Browser").replace(/\s+/g, "")}/${br.platform || "other"}`;
        } catch (_) {
          // no sendfilter.js (perhaps the missing one): unknown
        }
      }
      const body = JSON.stringify(Object.assign({}, r, { build: meta ? meta.content : "?", browser }));
      fetch("/api/client-error", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch (_) {
      // reporting never breaks anything
    }
  }

  // in the page: check now (this file is the page's last) — HERE, at the
  // end, every setting above already set: run before REFRESH_MS was, the
  // reload didn't wait for the fresh copy (ninth review, 2026-11-19)
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      run();
    } catch (_) {
      // the check never breaks a page that works
    }
  }

  return { missing, decide, report, oldReport, oldFiles, browserName, olderThanUs, languageFile, optional, demo, refreshFrom, REFRESH_MS, KEY, RELOADS, WINDOW_MS, MAKES };
});
