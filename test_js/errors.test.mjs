// Error reports from phones (owner, 2026-11-10): what broke, never who.
// HoodErrors turns an error into a small report — kind, message (scrubbed
// of anything personal), where in the code, the app version — and sends it
// at most 5 a minute, 30 a session, each distinct one once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../priv/static/errors.js");

const setup = () => {
  const sent = [];
  const t = { now: 0 };
  const r = E.create({ send: (p) => sent.push(p), now: () => t.now, build: "b123", browser: "Chrome/Android" });
  return { sent, t, r };
};

const err = (message, stack, name = "TypeError") => {
  const e = new Error(message);
  e.name = name;
  if (stack !== undefined) e.stack = stack;
  return e;
};

test("a report: kind, scrubbed message, code places (file:line:col only), screen, version, browser", () => {
  const { sent, r } = setup();
  const stack = [
    "TypeError: x is undefined",
    "    at openChat (https://hoodride.app/app.js?vsn=abc123:1:65786)",
    "    at HTMLButtonElement.<anonymous> (https://hoodride.app/app.js?vsn=abc123:1:2941)",
    "    at https://hoodride.app/nearby.js:12:40",
    "    at fourth (https://hoodride.app/sync.js:9:9)",
  ].join("\n");
  r.report(err("x is undefined", stack), "chat");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    kind: "TypeError",
    message: "x is undefined",
    at: ["app.js:1:65786", "app.js:1:2941", "nearby.js:12:40"],
    where: "chat",
    build: "b123",
    browser: "Chrome/Android",
  });
});

test("nothing personal in a message: links, emails, numbers (ids, positions, phone numbers) — replaced", () => {
  const { sent, r } = setup();
  r.report(err("can't load https://hoodride.app/api/chat?with=6620271782574400 for bob@mail.com at 40.7154,-74.0086 (call 555-123-4567)"));
  const m = sent[0].message;
  assert.ok(!m.includes("hoodride.app/api"), m);
  assert.ok(!m.includes("6620271782574400"), m);
  assert.ok(!m.includes("bob@mail.com"), m);
  assert.ok(!m.includes("40.7154") && !m.includes("74.0086"), m);
  assert.ok(!m.includes("555-123-4567") && !m.includes("4567"), m);
  assert.match(m, /can't load <link> for <email> at <n>,-?<n> \(call <n>\)/);
});

test("any number of 2+ digits goes (small account ids are 1–3 digits); a single digit stays", () => {
  const { sent, r } = setup();
  r.report(err("HTTP 503 after 2 tries; reading '42'; id 1234 or 12345; 123 Main St"));
  assert.equal(sent[0].message, "HTTP <n> after 2 tries; reading '<n>'; id <n> or <n>; <n> Main St");
});

test("long messages cut to 200 characters; no stack: no places; a non-Error thrown: its text", () => {
  const { sent, r } = setup();
  r.report(err("a".repeat(500), ""));
  assert.equal(sent[0].message.length, 200);
  assert.deepEqual(sent[0].at, []);
  r.report("just a string thrown");
  assert.equal(sent[1].kind, "Error");
  assert.equal(sent[1].message, "just a string thrown");
  r.report(undefined);
  assert.equal(sent[2].message, "undefined");
});

test("the same error twice: sent once (a loop never floods)", () => {
  const { sent, r } = setup();
  for (let i = 0; i < 50; i++) r.report(err("same", "at f (https://h/app.js:1:2)"));
  assert.equal(sent.length, 1);
});

test("at most 5 a minute; more after a minute; at most 30 a session", () => {
  const { sent, t, r } = setup();
  for (let i = 0; i < 8; i++) r.report(err("e" + "x".repeat(i)));
  assert.equal(sent.length, 5, "5 in the first minute");
  t.now += 60001;
  for (let i = 0; i < 8; i++) r.report(err("f" + "x".repeat(i)));
  assert.equal(sent.length, 10, "5 more a minute later");
  for (let m = 0; m < 10; m++) {
    t.now += 60001;
    for (let i = 0; i < 5; i++) r.report(err(`g${m}-` + "x".repeat(i)));
  }
  assert.equal(sent.length, 30, "never more than 30 a session");
});

test("a send that throws never throws back (reporting must never break the app)", () => {
  const r = E.create({ send: () => { throw new Error("offline"); }, now: () => 0, build: "b", browser: "x" });
  assert.doesNotThrow(() => r.report(err("anything")));
});

test("where: only a short known word — anything else becomes 'other'", () => {
  const { sent, r } = setup();
  r.report(err("a1"), "map");
  r.report(err("a2"), "https://evil.example/?u=1");
  assert.equal(sent[0].where, "map");
  assert.equal(sent[1].where, "other");
});

test("decimals go too (a position's digits), a lone digit stays", () => {
  const { sent, r } = setup();
  r.report(err("zoom 13.5 at 40.7154, step 3"));
  assert.equal(sent[0].message, "zoom <n> at <n>, step 3");
});

test("a network failure is the network, not a bug: isNetwork knows each browser's words", () => {
  for (const m of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed", "The network connection was lost."])
    assert.equal(E.isNetwork(new TypeError(m)), true, m);
  const ajax = new Error("whatever");
  ajax.name = "AJAXError";
  assert.equal(E.isNetwork(ajax), true);
  assert.equal(E.isNetwork(new TypeError("x is undefined")), false);
  assert.equal(E.isNetwork(undefined), false);
  assert.equal(E.isNetwork("Failed to fetch"), true);
});

// ===== mutation kills (2026-11-10) =====
test("the minute's window resets at exactly 60 s; an error held back by the limit is sent later", () => {
  const { sent, t, r } = setup();
  for (let i = 0; i < 6; i++) r.report(err("w" + "x".repeat(i)));
  assert.equal(sent.length, 5);
  t.now += 60000;
  r.report(err("w" + "x".repeat(5))); // the 6th, held back before
  assert.equal(sent.length, 6, "a new minute at exactly 60 s — and the held-back one goes now");
});

test("the same message from another place, or as another kind: a different error — sent", () => {
  const { sent, r } = setup();
  r.report(err("m", "at f (https://h/a.js:1:2)"));
  r.report(err("m", "at f (https://h/b.js:1:2)"));
  r.report(err("m", "at f (https://h/a.js:1:2)", "RangeError"));
  assert.equal(sent.length, 3);
});

test("a kind that isn't one plain word becomes 'Error'", () => {
  const { sent, r } = setup();
  r.report(err("k", undefined, "a b"));
  assert.equal(sent[0].kind, "Error");
});

test("every screen word passes; links in any case are scrubbed", () => {
  const { sent, t, r } = setup();
  const words = ["map", "chat", "ride", "settings", "search", "start", "sync", "other"];
  // (a minute apart: the limit is 5 a minute)
  words.forEach((w, i) => {
    t.now += 60000;
    r.report(err("s" + "x".repeat(i)), w);
  });
  assert.deepEqual(sent.map((s) => s.where), words);
  assert.equal(E.scrub("see HTTPS://X.EXAMPLE/a"), "see <link>");
});

test("the browser's harmless ResizeObserver notice is not a bug: never reported", () => {
  assert.equal(E.isNetwork(new Error("ResizeObserver loop completed with undelivered notifications.")), true);
  assert.equal(E.isNetwork("ResizeObserver loop limit exceeded"), true);
});

// (owner, 2026-11-19: one phone's sendfilter.js never arrived) the page's
// scripts that failed to load, by file name — no address, no version
test("a script that failed to load: its file name alone", () => {
  assert.equal(E.fileOf("https://hoodride.app/sendfilter.js?vsn=ab1772e6a29d"), "sendfilter.js");
  assert.equal(E.fileOf("/ja/i18n-ja.js#x"), "i18n-ja.js");
  assert.equal(E.fileOf(""), "");
  assert.equal(E.fileOf(undefined), "");
  // in Node (no page): none heard, and a copy each time
  assert.deepEqual(E.failedScripts(), []);
  E.failedScripts().push("x.js");
  assert.deepEqual(E.failedScripts(), []);
});

// (first review, 2026-11-19) only OUR files, only while the page is read:
// Cloudflare's analytics script (added in production after the page) is
// blocked by Brave and ad blockers — counted, it muted every report after
function pageWithErrors() {
  const { readFileSync } = require("node:fs");
  const vm = require("node:vm");
  const listeners = [];
  const win = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: !!capture }),
  };
  const docListeners = [];
  const doc = { readyState: "loading", currentScript: null, addEventListener: (type, fn) => docListeners.push({ type, fn }) };
  const ctx = { window: win, document: doc, location: { href: "https://hoodride.app/ja", origin: "https://hoodride.app" }, URL };
  ctx.self = ctx;
  vm.runInNewContext(readFileSync(require.resolve("../priv/static/errors.js"), "utf8"), vm.createContext(ctx));
  const failLoad = (src) =>
    listeners.filter((l) => l.type === "error" && l.capture).forEach((l) => l.fn({ target: { tagName: "SCRIPT", src } }));
  // an error thrown as a script ran: thrown in `filename`, while the page
  // ran `running` (its <script>; default: the same file) — as the browser
  // tells it: the capture listeners, then the app's (deliver)
  const throwIn = (filename, error, running = filename) => {
    doc.currentScript = running ? { src: running } : null;
    const ev = { target: win, filename, error, message: `Uncaught ${error.name}: ${error.message}` };
    listeners.filter((l) => l.type === "error" && l.capture).forEach((l) => l.fn(ev));
    listeners.filter((l) => l.type === "error" && !l.capture).forEach((l) => l.fn(ev));
    doc.currentScript = null;
  };
  // the page fully read (DOMContentLoaded)
  const pageRead = () => {
    doc.readyState = "interactive";
    docListeners.filter((l) => l.type === "DOMContentLoaded").forEach((l) => l.fn({}));
  };
  // an error event exactly as the browser gives it, to the app's listener
  const fire = (ev) => listeners.filter((l) => l.type === "error" && !l.capture).forEach((l) => l.fn({ target: win, ...ev }));
  return { E: ctx.HoodErrors, doc, failLoad, throwIn, pageRead, fire };
}

// (fifth review, 2026-11-19) only an END-OF-FILE syntax error is a file
// cut off: an old browser's "Unexpected token '?'" (it can't read our
// code) or a JSON one is a crash — reported, never "check your connection"
test("which syntax errors mean 'cut off', which 'this browser can't read our code', which a bug", () => {
  // cut: it arrived cut off · old: the browser can't read our code (too
  // old for it — owner, 2026-11-19) · bug: a crash, reported
  for (const [msg, kind] of [
    ["Unexpected end of input", "cut"],
    ["Unexpected end of script", "cut"],
    ["expected expression, got end of script", "cut"],
    ["unterminated string literal", "cut"],
    ["Unexpected EOF", "cut"],
    // (Firefox's usual words for a file cut off mid-function: Firefox
    // updates itself — far likelier a cut than an old one)
    ["missing } after function body", "cut"],
    // an old Chrome says it for 60_000, which we ship (sixth review)
    ["Invalid or unexpected token", "old"],
    ["Unexpected token '.'", "old"],
    ["Unexpected token '?'", "old"],
    ["Unexpected end of JSON input", "bug"],
    ["JSON.parse: unexpected end of data at line 1 column 1 of the JSON data", "bug"],
  ]) {
    const { E, throwIn } = pageWithErrors();
    throwIn("https://hoodride.app/sendfilter.js?vsn=1", new SyntaxError(msg));
    const got = [[...E.failedScripts()], [...E.unreadableScripts()], [...E.crashedScripts()]];
    const want = { cut: [["sendfilter.js"], [], []], old: [[], ["sendfilter.js"], []], bug: [[], [], ["sendfilter.js"]] }[kind];
    assert.deepEqual(got, want, msg);
  }
});

test("a browser that can't read our code: the file, and the browser's own words", () => {
  const { E, throwIn } = pageWithErrors();
  throwIn("https://hoodride.app/app.js?vsn=1", new SyntaxError("Unexpected token '?'"));
  throwIn("https://hoodride.app/nearby.js?vsn=1", new SyntaxError("Unexpected token '.'"));
  assert.deepEqual([...E.unreadableScripts()], ["app.js", "nearby.js"]);
  assert.equal(E.unreadableWords(), "Unexpected token '?'");
  // a selector the page refuses (a DOMException also named SyntaxError): a bug
  const dom = Object.assign(new Error("'#x[' is not a valid selector"), { name: "SyntaxError", code: 12 });
  throwIn("https://hoodride.app/car.js?vsn=1", dom);
  assert.deepEqual([...E.crashedScripts()], ["car.js"]);
});

test("an error is the RUNNING file's (not where it was thrown); none of ours running: none's", () => {
  const { E, throwIn } = pageWithErrors();
  // ridepos.js starting, the throw inside sendfilter.js: ridepos.js crashed
  throwIn("https://hoodride.app/sendfilter.js?vsn=1", new TypeError("x"), "https://hoodride.app/ridepos.js?vsn=2");
  assert.deepEqual([...E.crashedScripts()], ["ridepos.js"]);
  // filed against the page itself (/ja — an extension's code): no file
  throwIn("https://hoodride.app/ja", new SyntaxError("Unexpected end of input"), null);
  assert.deepEqual([...E.failedScripts()], []);
});

// (fifth review) the crashes a file that arrived EMPTY sets off: the
// reporter can't tell them from bugs until the check (the page's last
// script) has run — so the errors of the page's start wait for it:
// settle(true) (a needed file missing) drops them, settle(false) sends
// them; the page read without a check (its file missing): sent then
test("start-up errors wait for the check: dropped as an echo, or sent", () => {
  for (const [how, sent] of [
    ["echo", 0],
    ["fine", 2],
    ["no check", 2],
  ]) {
    const { E, throwIn, pageRead } = pageWithErrors();
    const got = [];
    E.attach((e) => got.push(e));
    throwIn("https://hoodride.app/ridepos.js", new TypeError("a"));
    throwIn("https://hoodride.app/app.js", new TypeError("b"));
    assert.equal(got.length, 0, `${how}: held`);
    if (how === "echo") E.settle(true);
    if (how === "fine") E.settle(false);
    pageRead();
    assert.equal(got.length, sent, how);
    assert.equal(E.appFileMissing(), how === "echo", `${how}: later reports muted?`);
    // after: straight through (or muted by the app, asking appFileMissing)
    throwIn("https://hoodride.app/app.js", new TypeError("c"));
    assert.equal(got.length, sent + 1, `${how}: after the start, straight on`);
  }
});

// (owner, 2026-11-19: a file arriving empty or cut off) a file of ours cut
// off mid-way fails to PARSE — a syntax error from it while the page is
// read: it didn't arrive whole (ours can't ship one: the deploy build
// parses every file). A crash (TypeError…) is a bug: noted apart, so the
// check never takes it for a missing file
test("a syntax error from one of our files as the page is read: it didn't arrive whole", () => {
  const { E, throwIn } = pageWithErrors();
  throwIn("https://hoodride.app/sendfilter.js?vsn=1", new SyntaxError("Unexpected end of input"));
  assert.deepEqual([...E.failedScripts()], ["sendfilter.js"]);
  assert.deepEqual([...E.crashedScripts()], []);
  assert.equal(E.appFileMissing(), true);
});

test("a crash in one of our files as the page is read: a bug, noted — not missing", () => {
  const { E, throwIn } = pageWithErrors();
  throwIn("https://hoodride.app/ridepos.js?vsn=1", new TypeError("Cannot read properties of undefined"));
  assert.deepEqual([...E.failedScripts()], []);
  assert.deepEqual([...E.crashedScripts()], ["ridepos.js"]);
  assert.equal(E.appFileMissing(), false);
});

test("errors from another site, or after the page was read: neither", () => {
  const { E, doc, throwIn } = pageWithErrors();
  throwIn("https://static.cloudflareinsights.com/beacon.min.js", new SyntaxError("x"));
  throwIn("", new SyntaxError("x"));
  doc.readyState = "interactive";
  throwIn("https://hoodride.app/app.js", new SyntaxError("x"));
  throwIn("https://hoodride.app/app.js", new TypeError("x"));
  assert.deepEqual([...E.failedScripts()], []);
  assert.deepEqual([...E.crashedScripts()], []);
});

test("a script of ours that fails while the page is read: counted", () => {
  const { E, failLoad } = pageWithErrors();
  failLoad("https://hoodride.app/sendfilter.js?vsn=1");
  assert.deepEqual([...E.failedScripts()], ["sendfilter.js"]);
});

test("another site's script failing (Cloudflare's analytics, blocked): not counted", () => {
  const { E, failLoad } = pageWithErrors();
  failLoad("https://static.cloudflareinsights.com/beacon.min.js");
  failLoad("chrome-extension://abc/inject.js");
  assert.deepEqual([...E.failedScripts()], []);
});

test("one of ours failing after the page was read (added later): not counted", () => {
  const { E, doc, failLoad } = pageWithErrors();
  doc.readyState = "interactive";
  failLoad("https://hoodride.app/late.js");
  doc.readyState = "complete";
  failLoad("https://hoodride.app/later.js");
  assert.deepEqual([...E.failedScripts()], []);
});

// (third review) the load check's own file, or a language's words, failing:
// the app runs — its reports go on; a file it needs: muted (the echo)
test("muted only while a file the app NEEDS is missing", () => {
  for (const [files, muted] of [
    [["loadcheck.js"], false],
    [["i18n-ja.js"], false],
    [["i18n-ja.js", "loadcheck.js"], false],
    [["sendfilter.js"], true],
    [["loadcheck.js", "app.js"], true],
  ]) {
    const { E, failLoad } = pageWithErrors();
    for (const f of files) failLoad(`https://hoodride.app/${f}?vsn=1`);
    assert.equal(E.appFileMissing(), muted, files.join(" "));
  }
});

// (sixth review) the held start-up errors: 5 at most — the same error
// thrown again (every frame, an interval) never pushes a different one out
test("held start-up errors: a repeat doesn't take another's place", () => {
  const { E, throwIn } = pageWithErrors();
  const got = [];
  E.attach((e) => got.push(e));
  for (let i = 0; i < 8; i++) throwIn("https://hoodride.app/app.js", new TypeError("again"));
  throwIn("https://hoodride.app/app.js", new TypeError("the other one"));
  E.settle(false);
  assert.deepEqual(got.map((e) => e.message), ["again", "the other one"]);
});

// (seventh review) a file that arrived cut off: its own syntax error is
// the cut, never a crash report — an optional file too (i18n-ja.js: the
// app runs on, and its reports go on — but not that one)
test("a cut-off file's own syntax error is never sent, even when the app runs on", () => {
  const { E, throwIn } = pageWithErrors();
  const got = [];
  E.attach((e) => got.push(e));
  throwIn("https://hoodride.app/i18n-ja.js?vsn=1", new SyntaxError("Unexpected end of input"));
  throwIn("https://hoodride.app/app.js", new TypeError("a real one"));
  E.settle(false);
  assert.deepEqual(got.map((e) => e.message), ["a real one"]);
});

// (seventh review) the app's own reports (reportError, not an uncaught
// error) during the start: they wait for the check too
test("reports made directly during the start wait for the check: dropped as an echo, or sent", () => {
  for (const [drop, sent] of [[true, 0], [false, 1]]) {
    const { E } = pageWithErrors();
    const got = [];
    assert.equal(E.whenSettled(() => got.push("x")), false, "held: not yet");
    assert.equal(got.length, 0);
    E.settle(drop);
    assert.equal(got.length, sent, `drop=${drop}`);
    // after: straight away
    assert.equal(E.whenSettled(() => got.push("y")), true);
    assert.equal(got.length, sent + 1);
  }
});

// (seventh review) app.js's own reports go through that wait: reportError,
// past its other checks, asks settledYet first — the glue Node can't load
test("app.js: a report made during the start waits for the check", () => {
  const { readFileSync } = require("node:fs");
  const app = readFileSync(require.resolve("../priv/static/app.js"), "utf8");
  const body = app.slice(app.indexOf("function reportError("), app.indexOf("if (!errorReports)"));
  assert.match(body, /if \(!HoodErrors\.settledYet\(\)\) return void HoodErrors\.whenSettled\(\(\) => reportError\(e, where\)\);/);
});

// (eighth review) only the app's OWN files — each stamped with its version
// (?vsn=): Cloudflare adds same-site scripts of its own (/cdn-cgi/…,
// already on /privacy); one blocked is no file of the app missing
test("a same-site script that isn't one of the app's (no version stamp): never counted", () => {
  const { E, failLoad, throwIn } = pageWithErrors();
  failLoad("https://hoodride.app/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js");
  throwIn("https://hoodride.app/cdn-cgi/x/rocket-loader.min.js", new TypeError("x"));
  throwIn("https://hoodride.app/cdn-cgi/x/y.js", new SyntaxError("Unexpected end of input"));
  assert.deepEqual([[...E.failedScripts()], [...E.crashedScripts()], E.appFileMissing()], [[], [], false]);
  failLoad("https://hoodride.app/sendfilter.js?vsn=ab12");
  assert.deepEqual([...E.failedScripts()], ["sendfilter.js"]);
});

// (eleventh review) a file it couldn't read: its syntax error never sent as
// itself — the check says "too old" in one report, or takes it for a cut
test("a can't-read syntax error is never sent as itself", () => {
  const { E, throwIn } = pageWithErrors();
  const got = [];
  E.attach((e) => got.push(e));
  throwIn("https://hoodride.app/i18n-ja.js?vsn=1", new SyntaxError("Invalid or unexpected token"));
  throwIn("https://hoodride.app/app.js?vsn=1", new TypeError("a real one"));
  E.settle(false);
  assert.deepEqual(got.map((e) => e.message), ["a real one"]);
});

// (sixteenth review) an error from a timer or an event while the page is
// read — no script of ours RUNNING — is no file of ours crashing or
// unread: never counted by its address (it made "too old" over a working app)
test("an error while none of our scripts runs: never counted, whatever its address", () => {
  const { E, throwIn } = pageWithErrors();
  throwIn("https://hoodride.app/maplibre-gl.js?vsn=1", new TypeError("from a timer"), null);
  throwIn("https://hoodride.app/app.js?vsn=1", new SyntaxError("Unexpected token '?'"), null);
  assert.deepEqual([[...E.failedScripts()], [...E.unreadableScripts()], [...E.crashedScripts()]], [[], [], []]);
});

// (owner, 2026-11-20: 12 "Error: Script error." from Brave on an iPhone in a
// day) another site's script failing — Brave's own, Cloudflare's analytics
// — reaches the page MUTED (the HTML standard: a cross-origin script's
// error says only "Script error.", no file, no line, no error). Never ours
// (every file of ours is this site's: its errors carry their file), nothing
// to act on: not sent — as Sentry's own default filter does
test("another site's muted 'Script error.' (no file, no line, no error): never sent", () => {
  const { E, fire, pageRead } = pageWithErrors();
  const got = [];
  E.attach((e) => got.push(e));
  E.settle(false);
  pageRead();
  fire({ message: "Script error.", filename: "", lineno: 0, colno: 0, error: null });
  fire({ message: "Script error", filename: "", lineno: 0, colno: 0, error: null });
  fire({ message: "Script error." });
  assert.equal(got.length, 0, "muted: none sent");
  // anything with something to go on: sent, as always
  fire({ message: "Script error.", filename: "https://hoodride.app/app.js?vsn=1", lineno: 3, colno: 9, error: null });
  fire({ message: "Uncaught TypeError: x is undefined", filename: "", lineno: 0, colno: 0, error: null });
  const thrown = new TypeError("Script error.");
  fire({ message: "Uncaught TypeError: Script error.", filename: "", lineno: 0, colno: 0, error: thrown });
  assert.deepEqual(got, ["Script error.", "Uncaught TypeError: x is undefined", thrown]);
});
