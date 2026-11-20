// Node tests for priv/static/loadcheck.js (HoodLoadCheck) — a file of the
// app that didn't arrive (owner, 2026-11-19): reload, at most twice in 5
// minutes, then the message; no storage to count with: no reload at all.
// The page glue: test_browser/loadfail.mjs.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../priv/static/loadcheck.js");

// sessionStorage, as the check uses it
function storage(initial = null) {
  let v = initial;
  return {
    read: () => v,
    write: (x) => (v = x),
    remove: () => (v = null),
    get: () => v,
  };
}

test("everything arrived: ok, and the count cleared", () => {
  const s = storage(JSON.stringify({ n: 2, since: 0 }));
  assert.deepEqual(L.decide({ missing: [], store: s, now: 1000 }), { action: "ok", attempt: 0 });
  assert.equal(s.get(), null);
});

test("missing: reload, reload, then the message — never a third reload", () => {
  const s = storage();
  let now = 1_000_000;
  assert.deepEqual(L.decide({ missing: ["sendfilter.js"], store: s, now }), { action: "reload", attempt: 1 });
  now += 3000;
  assert.deepEqual(L.decide({ missing: ["sendfilter.js"], store: s, now }), { action: "reload", attempt: 2 });
  now += 3000;
  assert.equal(L.decide({ missing: ["sendfilter.js"], store: s, now }).action, "message");
  // a slow failing load (past any short timer) still doesn't reload again
  now += 60_000;
  assert.equal(L.decide({ missing: ["sendfilter.js"], store: s, now }).action, "message");
});

test("the count is per 5 minutes: after that, two reloads again", () => {
  const s = storage();
  const t0 = 1_000_000;
  L.decide({ missing: ["x.js"], store: s, now: t0 });
  L.decide({ missing: ["x.js"], store: s, now: t0 + 1 });
  assert.equal(L.decide({ missing: ["x.js"], store: s, now: t0 + L.WINDOW_MS - 1 }).action, "message");
  assert.deepEqual(L.decide({ missing: ["x.js"], store: s, now: t0 + L.WINDOW_MS }), { action: "reload", attempt: 1 });
});

test("a saved count from the future (a clock set back) or junk: started afresh", () => {
  for (const saved of [JSON.stringify({ n: 2, since: 5_000_000 }), "not json", JSON.stringify({ n: "2" }), "null"]) {
    const s = storage(saved);
    const d = L.decide({ missing: ["x.js"], store: s, now: 1_000_000 });
    // (junk that doesn't parse: no count to trust — no reload)
    if (saved === "not json") assert.equal(d.action, "message");
    else assert.deepEqual(d, { action: "reload", attempt: 1 }, saved);
  }
});

test("storage that can't keep the count: no reload — the message at once", () => {
  const throwing = { read: () => { throw new Error("no storage"); }, write: () => {}, remove: () => {} };
  assert.equal(L.decide({ missing: ["x.js"], store: throwing, now: 1 }).action, "message");
  const noWrite = { read: () => null, write: () => { throw new Error("quota"); }, remove: () => {} };
  assert.equal(L.decide({ missing: ["x.js"], store: noWrite, now: 1 }).action, "message");
  // a write that "works" but keeps nothing: would reload forever — no
  const forgetful = { read: () => null, write: () => {}, remove: () => {} };
  assert.equal(L.decide({ missing: ["x.js"], store: forgetful, now: 1 }).action, "message");
  // …and clearing that throws never breaks a page that works
  assert.equal(L.decide({ missing: [], store: throwing, now: 1 }).action, "ok");
});

test("which files: those heard failing, then any whose global is missing", () => {
  const all = new Set(L.MAKES.map(([, name]) => name));
  assert.deepEqual(L.missing({ has: (n) => all.has(n), failed: [] }), []);
  assert.deepEqual(L.missing({ has: (n) => all.has(n), failed: ["sendfilter.js"] }), ["sendfilter.js"]);
  // the reporter itself missing: found by its global
  assert.deepEqual(L.missing({ has: (n) => n !== "HoodErrors", failed: [] }), ["errors.js"]);
  // heard AND its global missing: once
  assert.deepEqual(L.missing({ has: (n) => n !== "maplibregl", failed: ["maplibre-gl.js"] }), ["maplibre-gl.js"]);
});

test("the report: which files, and what was done — nothing else", () => {
  const r = L.report(["sendfilter.js"], { action: "reload", attempt: 1 });
  assert.deepEqual(r, { kind: "LoadError", message: "file missing: sendfilter.js (reloading, try 1)", at: [], where: "start" });
  assert.equal(L.report(["a.js", "b.js"], { action: "message", attempt: 2 }).message, "file missing: a.js b.js (gave up)");
});

// (second review, 2026-11-19) a language's words (i18n-ja.js) missing: the
// app still works, in English — tried again like any file, then let run:
// never the "couldn't load" screen over a working app
test("only a language's words missing: reload, reload, then on in English — no message", () => {
  const s = storage();
  let now = 1_000_000;
  assert.deepEqual(L.decide({ missing: ["i18n-ja.js"], store: s, now }), { action: "reload", attempt: 1 });
  assert.deepEqual(L.decide({ missing: ["i18n-ja.js"], store: s, now: (now += 1000) }), { action: "reload", attempt: 2 });
  assert.equal(L.decide({ missing: ["i18n-ja.js"], store: s, now: (now += 1000) }).action, "run");
  // no storage to count with: straight on in English
  const throwing = { read: () => { throw new Error("no storage"); }, write: () => {}, remove: () => {} };
  assert.equal(L.decide({ missing: ["i18n-ja.js"], store: throwing, now }).action, "run");
});

test("a language's words AND an app file missing: the message (the app can't run)", () => {
  const s = storage(JSON.stringify({ n: 2, since: 1_000_000 }));
  assert.equal(L.decide({ missing: ["i18n-ja.js", "sendfilter.js"], store: s, now: 1_000_500 }).action, "message");
});

test("the report says it went on in English", () => {
  assert.equal(L.report(["i18n-ja.js"], { action: "run", attempt: 2 }).message, "file missing: i18n-ja.js (gave up: runs without it)");
});

test("a language's words file: i18n-<lang>.js, never i18n.js itself (the app needs that one)", () => {
  for (const f of ["i18n-ja.js", "i18n-pt-BR.js", "i18n-en-XA.js"]) assert.equal(L.languageFile(f), true, f);
  for (const f of ["i18n.js", "sendfilter.js", "app.js", "xi18n-ja.js"]) assert.equal(L.languageFile(f), false, f);
  // …the same rule as the reporter's (app.js keeps reporting when only one is missing)
  const E = require("../priv/static/errors.js");
  for (const f of ["i18n-ja.js", "i18n-pt-BR.js", "i18n.js", "sendfilter.js", "xi18n-ja.js"]) assert.equal(E.languageFile(f), L.languageFile(f), f);
});

// (third review, 2026-11-19) the files the app runs WITHOUT: its words
// (English), the reporter (no reports — app.js asks typeof HoodErrors), the
// check itself — tried again like any, never the message over a working app
test("optional: a language's words, the reporter, the check itself — nothing else", () => {
  for (const f of ["i18n-ja.js", "errors.js", "loadcheck.js"]) assert.equal(L.optional(f), true, f);
  for (const f of ["i18n.js", "sendfilter.js", "app.js", "maplibre-gl.js"]) assert.equal(L.optional(f), false, f);
});

test("only the reporter missing for good: two reloads, then on — no message", () => {
  const s = storage(JSON.stringify({ n: 2, since: 1_000_000 }));
  assert.equal(L.decide({ missing: ["errors.js"], store: s, now: 1_000_500 }).action, "run");
});

test("the reporter missing: every other file checked by the name it makes (it can't hear them)", () => {
  const every = new Set(L.MAKES.map(([, name]) => name));
  // all there but the reporter
  assert.deepEqual(L.missing({ has: (n) => n !== "HoodErrors" && every.has(n), failed: [] }), ["errors.js"]);
  // …and sendfilter.js gone too: found
  assert.deepEqual(L.missing({ has: (n) => n !== "HoodErrors" && n !== "HoodSendFilter" && every.has(n), failed: [] }), ["errors.js", "sendfilter.js"]);
});

// (owner, 2026-11-19) a file that arrived EMPTY: no load error, no error at
// all — only its name missing. The reporter there: a name missing counts,
// unless that file crashed as it ran (a bug: reported, never "check your
// connection")
test("the reporter there: what it heard, and any name missing — but a file that crashed", () => {
  const every = new Set(L.MAKES.map(([, name]) => name));
  const without = (...gone) => (n) => every.has(n) && !gone.includes(n);
  // empty sendfilter.js: nothing heard, its name missing
  assert.deepEqual(L.missing({ has: without("HoodSendFilter"), failed: [], crashed: [] }), ["sendfilter.js"]);
  // it crashed as it ran (our bug): not missing
  assert.deepEqual(L.missing({ has: without("HoodSendFilter"), failed: [], crashed: ["sendfilter.js"] }), []);
  // heard failing AND its name missing: once; the files crashing after it: not missing
  assert.deepEqual(
    L.missing({ has: without("HoodSendFilter", "HoodRidePos"), failed: ["sendfilter.js"], crashed: ["ridepos.js"] }),
    ["sendfilter.js"]
  );
  // all there: none
  assert.deepEqual(L.missing({ has: without(), failed: [], crashed: [] }), []);
});

test("in the demo no report is sent (it talks to no server)", () => {
  assert.equal(L.demo("?demo=1"), true);
  assert.equal(L.demo("?x=1&demo"), true);
  assert.equal(L.demo(""), false);
  assert.equal(L.demo("?demonstration=1"), false);
});

test("the names list covers every script of the page (but the words and the check itself)", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../priv/static/index.html", import.meta.url), "utf8");
  const files = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((f) => f !== "loadcheck.js");
  assert.deepEqual(L.MAKES.map(([f]) => f).sort(), files.sort());
  // each name is the one its file makes (a shared file: root.<Name> = factory)
  for (const [file, name] of L.MAKES) {
    const src = readFileSync(new URL(`../priv/static/${file}`, import.meta.url), "utf8");
    const own = src.match(/root\.(Hood[A-Za-z0-9]+) = factory\(/);
    if (own) assert.equal(name, own[1], file);
    else assert.ok(src.includes(name), `${file}: never mentions ${name}`);
  }
});

// (seventh/eighth review) before a reload: the missing files fetched
// afresh — each read to its END (a reload mid-download cut it off, the
// broken copy kept), only those missing, never longer than REFRESH_MS
test("fetched afresh: only the missing files, each to its end, within the limit", async () => {
  const asked = [];
  let finishBody;
  let done = false;
  const p = L.refreshFrom({
    srcs: ["https://hoodride.app/errors.js?vsn=1", "https://hoodride.app/sendfilter.js?vsn=2", ""],
    miss: ["sendfilter.js"],
    get: async (src) => {
      asked.push(src);
      return { arrayBuffer: () => new Promise((r) => (finishBody = r)) };
    },
    wait: () => new Promise(() => {}),
  }).then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ["https://hoodride.app/sendfilter.js?vsn=2"]);
  assert.equal(done, false, "not before the body has all come");
  finishBody(new ArrayBuffer(1));
  await p;
  assert.equal(done, true);
  // a body that never ends: the limit ends the wait
  let limit;
  const q = L.refreshFrom({
    srcs: ["https://hoodride.app/sendfilter.js?vsn=2"],
    miss: ["sendfilter.js"],
    get: async () => ({ arrayBuffer: () => new Promise(() => {}) }),
    wait: (ms) => new Promise((r) => (limit = () => r(ms))),
  });
  await new Promise((r) => setImmediate(r));
  limit();
  await q;
  // a failed fetch: never fails the reload
  await L.refreshFrom({ srcs: ["/sendfilter.js?vsn=2"], miss: ["sendfilter.js"], get: () => Promise.reject(new Error("x")), wait: () => new Promise(() => {}) });
});

// (ninth review) the whole file run as the page runs it — its check at
// once, as the page's last script: a missing file fetched afresh to its
// END before the reload (a setting read before it was set made the reload
// go at once, the download cut off)
test("in a page: the reload waits for the fresh copy's last byte", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const events = [];
  let finishBody;
  const store = new Map();
  const win = {
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: () => {},
  };
  const ctx = {
    window: win,
    document: {
      scripts: [{ src: "https://hoodride.app/errors.js?vsn=1" }, { src: "https://hoodride.app/sendfilter.js?vsn=2" }],
      querySelector: () => null,
      getElementById: () => null,
    },
    location: { search: "", reload: () => events.push("reload") },
    navigator: { userAgent: "x" },
    // the reporter heard sendfilter.js fail; everything else there
    HoodErrors: { failedScripts: () => ["sendfilter.js"], crashedScripts: () => [], settle: () => {} },
    fetch: (src, opts) => {
      if (String(src).includes("/api/")) return Promise.resolve({});
      events.push(`fetch ${src} ${opts && opts.cache}`);
      return Promise.resolve({ arrayBuffer: () => new Promise((r) => (finishBody = () => (events.push("body done"), r(new ArrayBuffer(1))))) });
    },
    setTimeout: () => 0,
    Promise,
    JSON,
    URLSearchParams,
  };
  ctx.self = ctx;
  // every name a page script makes is there (only sendfilter.js heard failing)
  const L0 = require("../priv/static/loadcheck.js");
  for (const [, name] of L0.MAKES) if (!(name in ctx)) ctx[name] = {};
  vm.runInNewContext(readFileSync(new URL("../priv/static/loadcheck.js", import.meta.url), "utf8"), vm.createContext(ctx));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["fetch https://hoodride.app/sendfilter.js?vsn=2 reload"], "fetched afresh — and no reload yet");
  finishBody();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.slice(1), ["body done", "reload"]);
});

// (owner, 2026-11-19) a browser too old for our code — it can't read a
// file of ours: never "check your connection", never a reload — "too old"
test("what this browser couldn't read is never missing by its name too", () => {
  const every = new Set(L.MAKES.map(([, n]) => n));
  assert.deepEqual(L.missing({ has: (n) => every.has(n) && n !== "HoodSendFilter", failed: [], crashed: [], unreadable: ["sendfilter.js"] }), []);
});

test("its report: what it couldn't read, the browser's words, the browser", () => {
  assert.deepEqual(L.oldReport(["app.js", "nearby.js"], "Unexpected token '?'"), {
    kind: "OldBrowser",
    message: "can't read: app.js nearby.js (Unexpected token '?')",
    at: [],
    where: "start",
  });
});

test("the browser named from its own description (no sendfilter.js needed)", () => {
  for (const [ua, name] of [
    ["Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/10.1 Chrome/71.0.3578.99 Mobile Safari/537.36", "SamsungInternet/10"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36", "Chrome/79"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36 Edg/79.0.309.71", "Edge/79"],
    ["Mozilla/5.0 (Windows NT 10.0; rv:68.0) Gecko/20100101 Firefox/68.0", "Firefox/68"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 13_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.5 Mobile/15E148 Safari/604.1", "Safari/13"],
    ["something else", "other"],
  ])
    assert.equal(L.browserName(ua), name, ua);
});

// (eleventh review) "too old" only for a browser that IS older than our
// build target (config :esbuild — chrome/edge 80, firefox 78, safari 13.1,
// ios 13.4): a current one can't-read a file only if it arrived cut off
// (Chrome's words for half the cuts look like an old browser's)
test("older than our build target? from the browser's own description", () => {
  for (const [ua, old] of [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36", true],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.87 Safari/537.36", false],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", false],
    // Samsung Internet: its Chrome engine's version
    ["Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/10.1 Chrome/71.0.3578.99 Mobile Safari/537.36", true],
    // the old Edge (EdgeHTML): always
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.18363", true],
    // Firefox: 78 (car.js's /\p{C}/u — twelfth review), not 72
    ["Mozilla/5.0 (Windows NT 10.0; rv:72.0) Gecko/20100101 Firefox/72.0", true],
    ["Mozilla/5.0 (Windows NT 10.0; rv:77.0) Gecko/20100101 Firefox/77.0", true],
    ["Mozilla/5.0 (Windows NT 10.0; rv:78.0) Gecko/20100101 Firefox/78.0", false],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.4 Safari/605.1.15", true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1 Safari/605.1.15", false],
    // iPhone: its iOS, whatever the browser (all WebKit)
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 13_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.5 Mobile/15E148 Safari/604.1", true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 13_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/81.0.4044.62 Mobile/15E148 Safari/604.1", false],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1", false],
    // unknown: not told "too old" — a file cut off is likelier
    ["something else", false],
  ])
    assert.equal(L.olderThanUs(ua), old, ua);
});


// (fourteenth review) "too old" on old Edge — whose element lists have
// forEach but can't be iterated (for…of): the screen must still show
test("in an old Edge page: the 'too old' screen shows (its lists can't be iterated)", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const part = (name) => ({ name, hidden: name === "old" });
  const text = part("text");
  const retry = part("retry");
  const oldLine = part("old");
  // an old Edge NodeList: indexes, length, forEach — no Symbol.iterator
  const list = (...items) => {
    const l = { length: items.length, forEach: (fn) => items.forEach(fn) };
    items.forEach((x, i) => (l[i] = x));
    return l;
  };
  const box = { hidden: true, querySelectorAll: () => list(text, retry), querySelector: () => oldLine };
  const sent = [];
  const ctx = {
    window: { sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, addEventListener: () => {} },
    document: { scripts: list(), querySelector: () => null, getElementById: (id) => (id === "load-fail" ? box : null) },
    location: { search: "", reload: () => sent.push("reload") },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36 Edge/16.16299" },
    HoodErrors: { failedScripts: () => [], crashedScripts: () => [], unreadableScripts: () => ["app.js"], unreadableWords: () => "Expected identifier", settle: () => {} },
    fetch: (url, o) => (sent.push(JSON.parse(o.body).kind), Promise.resolve({})),
    setTimeout: () => 0,
    Promise,
    JSON,
    Object,
    Array,
  };
  ctx.self = ctx;
  vm.runInNewContext(readFileSync(new URL("../priv/static/loadcheck.js", import.meta.url), "utf8"), vm.createContext(ctx));
  assert.deepEqual([box.hidden, text.hidden, retry.hidden, oldLine.hidden], [false, true, true, false]);
  assert.deepEqual(sent, ["OldBrowser"]);

  // …and when its parse errors came as crashes (no "SyntaxError" in them):
  // the same screen, no reload
  Object.assign(text, { hidden: false });
  Object.assign(retry, { hidden: false });
  Object.assign(oldLine, { hidden: true });
  box.hidden = true;
  sent.length = 0;
  ctx.HoodErrors = { failedScripts: () => [], crashedScripts: () => ["app.js"], unreadableScripts: () => [], unreadableWords: () => "", settle: () => {} };
  vm.runInNewContext(readFileSync(new URL("../priv/static/loadcheck.js", import.meta.url), "utf8"), vm.createContext(ctx));
  assert.deepEqual([box.hidden, text.hidden, retry.hidden, oldLine.hidden], [false, true, true, false]);
  assert.deepEqual(sent, ["OldBrowser"]);

  // …and with no reporter at all (errors.js itself unread): the same
  Object.assign(text, { hidden: false });
  Object.assign(retry, { hidden: false });
  Object.assign(oldLine, { hidden: true });
  box.hidden = true;
  sent.length = 0;
  delete ctx.HoodErrors;
  vm.runInNewContext(readFileSync(new URL("../priv/static/loadcheck.js", import.meta.url), "utf8"), vm.createContext(ctx));
  assert.deepEqual([box.hidden, text.hidden, retry.hidden, oldLine.hidden], [false, true, true, false]);
  assert.deepEqual(sent, ["OldBrowser"]);
});

// (fifteenth review) a browser older than us with ANY needed file broken —
// unreadable, crashed (old Edge's parse errors may not say "SyntaxError"),
// or missing: "too old" — it can't run the app whatever its words
test("older than us and something needed broken, whatever the words: 'too old'", () => {
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36 Edge/16.16299";
  const now = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  assert.deepEqual(L.oldFiles({ ua: edge, unreadable: [], crashed: ["app.js", "car.js"], missing: ["sendfilter.js", "i18n-ja.js"] }), ["app.js", "car.js", "sendfilter.js"]);
  assert.deepEqual(L.oldFiles({ ua: edge, unreadable: ["app.js"], crashed: [], missing: [] }), ["app.js"]);
  // what it couldn't read is the cause: the crashes after it aren't named
  assert.deepEqual(L.oldFiles({ ua: edge, unreadable: ["sendfilter.js"], crashed: ["ridepos.js", "app.js"], missing: [] }), ["sendfilter.js"]);
  // only optional ones, or nothing: no
  assert.equal(L.oldFiles({ ua: edge, unreadable: [], crashed: [], missing: ["i18n-ja.js", "loadcheck.js"] }), null);
  assert.equal(L.oldFiles({ ua: edge, unreadable: [], crashed: [], missing: [] }), null);
  // a current browser: never (a crash is a bug; missing is the network)
  assert.equal(L.oldFiles({ ua: now, unreadable: [], crashed: ["app.js"], missing: ["sendfilter.js"] }), null);
});

// (sixteenth review) "too old" decided in ONE place (oldFiles): a browser
// that SAYS it's old (an in-app browser's hard-coded version) whose only
// unread file is a language's words — the app runs: reloaded like a cut,
// never "too old" over it
test("in a page: an old-looking browser with only its words unread — reloaded, never 'too old'", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const events = [];
  const store = new Map();
  const box = { hidden: true, querySelectorAll: () => [], querySelector: () => null };
  const ctx = {
    window: { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, addEventListener: () => {} },
    document: { scripts: [{ src: "https://hoodride.app/i18n-ja.js?vsn=1" }], querySelector: () => null, getElementById: (id) => (id === "load-fail" ? box : null) },
    location: { search: "", reload: () => events.push("reload") },
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.136 Mobile Safari/537.36" },
    HoodErrors: { failedScripts: () => [], crashedScripts: () => [], unreadableScripts: () => ["i18n-ja.js"], unreadableWords: () => "Invalid or unexpected token", settle: (drop) => events.push(`settle ${drop}`) },
    fetch: (src, o) => {
      if (String(src).includes("/api/")) return events.push(JSON.parse(o.body).kind), Promise.resolve({});
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
    },
    setTimeout: () => 0,
    Promise,
    JSON,
    Object,
    Array,
  };
  ctx.self = ctx;
  for (const [, name] of L.MAKES) if (!(name in ctx)) ctx[name] = {};
  vm.runInNewContext(readFileSync(new URL("../priv/static/loadcheck.js", import.meta.url), "utf8"), vm.createContext(ctx));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(box.hidden, true, "no screen over the app");
  assert.ok(!events.includes("OldBrowser"), JSON.stringify(events));
  assert.deepEqual(events, ["settle false", "LoadError", "reload"]);
});

// (seventeenth review) app.js is NOT one wrapped function: cut between two
// of its statements, what arrived still reads — and its functions exist
// (hoisted). Checked by a marker set by its LAST line; and app.js not
// finished counts as not arrived even when it threw on the way (a cut
// mid-word: "fun is not defined") — its report still sent
test("app.js: checked by its last line; unfinished, it's missing even if it threw", () => {
  assert.deepEqual(L.MAKES.find(([f]) => f === "app.js"), ["app.js", "HoodAppRan"]);
  const every = new Set(L.MAKES.map(([, n]) => n));
  const without = (...gone) => (n) => every.has(n) && !gone.includes(n);
  // cut after a statement: no error, its last line never ran
  assert.deepEqual(L.missing({ has: without("HoodAppRan"), failed: [], crashed: [], unreadable: [] }), ["app.js"]);
  // cut mid-word: it threw — still missing
  assert.deepEqual(L.missing({ has: without("HoodAppRan"), failed: [], crashed: ["app.js"], unreadable: [] }), ["app.js"]);
  // …but crashed because ANOTHER needed file is missing: that one's echo
  assert.deepEqual(L.missing({ has: without("HoodAppRan", "HoodSendFilter"), failed: ["sendfilter.js"], crashed: ["app.js"], unreadable: [] }), ["sendfilter.js"]);
  // …or crashed because another file CRASHED first (a bug there): its echo
  assert.deepEqual(L.missing({ has: without("HoodAppRan", "HoodSendFilter", "HoodRidePos"), failed: [], crashed: ["sendfilter.js", "ridepos.js", "app.js"], unreadable: [] }), []);
  // another file that crashed: a bug, never missing
  assert.deepEqual(L.missing({ has: without("HoodCar"), failed: [], crashed: ["car.js"], unreadable: [] }), []);
});

test("in a page: app.js unfinished after a crash — reloaded, its crash report kept (not dropped as echo)", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const events = [];
  const store = new Map();
  const ctx = {
    window: { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, addEventListener: () => {} },
    document: { scripts: [{ src: "https://hoodride.app/app.js?vsn=1" }], querySelector: () => null, getElementById: () => null },
    location: { search: "", reload: () => events.push("reload") },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    HoodErrors: { failedScripts: () => [], crashedScripts: () => ["app.js"], unreadableScripts: () => [], unreadableWords: () => "", settle: (drop) => events.push(`settle ${drop}`) },
    fetch: (src, o) => {
      if (String(src).includes("/api/")) return events.push(JSON.parse(o.body).message), Promise.resolve({});
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
    },
    setTimeout: () => 0,
    Promise,
    JSON,
    Object,
    Array,
  };
  ctx.self = ctx;
  for (const [, name] of L.MAKES) if (name !== "HoodAppRan" && !(name in ctx)) ctx[name] = {};
  vm.runInNewContext(readFileSync(new URL("../priv/static/loadcheck.js", import.meta.url), "utf8"), vm.createContext(ctx));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["settle false", "file missing: app.js (reloading, try 1)", "reload"]);
});

// (eighteenth review) app.js's LAST statement is the marker, and nothing
// just before it can throw past it (Firefox, cookies blocked: reading
// navigator.serviceWorker throws — the marker never set, "check your
// connection" over a working page)
test("app.js ends with its marker; its offline-worker line can't stop it", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../priv/static/app.js", import.meta.url), "utf8");
  assert.ok(app.endsWith("\nself.HoodAppRan = true;\n"), "app.js's last line: the marker");
  const tail = app.slice(app.lastIndexOf('"serviceWorker" in navigator') - 200);
  assert.match(tail, /try \{\s*if \("serviceWorker" in navigator\)/);
});

test("app.js the only NEEDED file that crashed counts (a language's words crashing beside it don't hide it)", () => {
  const every = new Set(L.MAKES.map(([, n]) => n));
  const has = (n) => every.has(n) && n !== "HoodAppRan";
  assert.deepEqual(L.missing({ has, failed: [], crashed: ["i18n-ja.js", "app.js"], unreadable: [] }), ["app.js"]);
});
