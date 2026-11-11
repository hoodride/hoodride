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
