// Node tests for priv/static/boot.js — opening the app.
// It used to show the sign-in screen for ANY failure of /api/state: a
// deploy restart (Cloudflare's 502), a database hiccup (500), the rate
// limit (429), no signal. The session was fine; people just looked signed
// out. The rule (auth clients that get this right): only a real "signed
// out" answer means signed out — everything else, keep trying.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classify, retryAfterMs, create } = require("../priv/static/boot.js");

const ok = (body) => ({ status: 200, body });

test("200 with a user: signed in", () => {
  assert.equal(classify(ok({ user: { id: 1 } })), "in");
});

test("a real 'nobody signed in' answer, or 401/403: signed out", () => {
  assert.equal(classify(ok({ user: null })), "out");
  assert.equal(classify({ status: 401, body: null }), "out");
  assert.equal(classify({ status: 403, body: { error: "x" } }), "out");
});

test("every failure is 'try again' — NEVER signed out", () => {
  for (const r of [
    { status: 500, body: null },
    { status: 502, body: null }, // Cloudflare: the server is restarting
    { status: 503, body: null },
    { status: 429, body: { error: "rate_limited" } },
    { status: 200, body: null }, // not JSON
    { status: 200, body: {} }, // no "user" at all
    { status: 200, body: "<html>" },
    { status: 404, body: null },
    null, // no answer
  ])
    assert.equal(classify(r), "retry", JSON.stringify(r));
});

test("Retry-After in seconds is honoured; anything else is ignored", () => {
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs("0"), null);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assert.equal(retryAfterMs("-5"), null);
  assert.equal(retryAfterMs("100000"), 60000, "capped: a bad header can't park the app");
});

// a boot with a scripted server and fake timers
function harness(answers, { backoff = (n) => n * 1000 } = {}) {
  const h = { calls: 0, signedIn: null, signedOut: 0, waiting: [], timers: [] };
  h.boot = create({
    fetchState: async () => {
      const a = answers[Math.min(h.calls++, answers.length - 1)];
      if (a === "throw") throw new Error("offline");
      return a;
    },
    onSignedIn: (body) => (h.signedIn = body),
    onSignedOut: () => h.signedOut++,
    onWaiting: (attempt) => h.waiting.push(attempt),
    backoff,
    setTimer: (f, ms) => {
      const t = { f, ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => t && (t.cleared = true),
  });
  h.live = () => h.timers.filter((t) => !t.cleared);
  h.fire = async () => {
    const [t] = h.live();
    t.cleared = true;
    t.f();
    await settle();
  };
  return h;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("signed in on the first try: in, no retry", async () => {
  const h = harness([ok({ user: { id: 7 } })]);
  h.boot.start();
  await settle();
  assert.deepEqual(h.signedIn, { user: { id: 7 } });
  assert.equal(h.live().length, 0);
});

test("signed out: the sign-in screen, no retry", async () => {
  const h = harness([ok({ user: null })]);
  h.boot.start();
  await settle();
  assert.equal(h.signedOut, 1);
  assert.equal(h.live().length, 0);
});

test("a deploy: 502, 502, then in — never the sign-in screen", async () => {
  const h = harness([{ status: 502 }, "throw", ok({ user: { id: 7 } })]);
  h.boot.start();
  await settle();
  assert.deepEqual(h.waiting, [1]);
  assert.equal(h.live()[0].ms, 1000);
  await h.fire();
  assert.deepEqual(h.waiting, [1, 2]);
  assert.equal(h.live()[0].ms, 2000, "the wait grows");
  await h.fire();
  assert.equal(h.signedOut, 0);
  assert.deepEqual(h.signedIn, { user: { id: 7 } });
  assert.equal(h.live().length, 0);
});

test("the server's Retry-After beats the backoff", async () => {
  const h = harness([{ status: 429, retryAfter: "5" }, ok({ user: { id: 7 } })]);
  h.boot.start();
  await settle();
  assert.equal(h.live()[0].ms, 5000);
});

test("back online / app shown again: try at once, not after the wait", async () => {
  const h = harness(["throw", ok({ user: { id: 7 } })]);
  h.boot.start();
  await settle();
  assert.equal(h.live().length, 1);
  h.boot.poke();
  await settle();
  assert.equal(h.calls, 2);
  assert.deepEqual(h.signedIn, { user: { id: 7 } });
  assert.equal(h.live().length, 0, "the old timer is gone");
});

test("a poke while a check is already out doesn't start a second one", async () => {
  let release;
  const h = harness([]);
  h.boot = create({
    fetchState: () => (h.calls++, new Promise((r) => (release = r))),
    onSignedIn: (b) => (h.signedIn = b),
    onSignedOut: () => h.signedOut++,
    onWaiting: () => {},
    backoff: () => 1000,
    setTimer: (f, ms) => (h.timers.push({ f, ms }), h.timers.at(-1)),
    clearTimer: () => {},
  });
  h.boot.start();
  h.boot.poke();
  h.boot.poke();
  assert.equal(h.calls, 1);
  release(ok({ user: { id: 7 } }));
  await settle();
  assert.deepEqual(h.signedIn, { user: { id: 7 } });
});

test("once settled, nothing runs again (a late poke is ignored)", async () => {
  const h = harness([ok({ user: null })]);
  h.boot.start();
  await settle();
  h.boot.poke();
  await settle();
  assert.equal(h.calls, 1);
  assert.equal(h.signedOut, 1);
});

test("a failing onSignedIn isn't mistaken for a server failure", async () => {
  const h = harness([ok({ user: { id: 7 } })]);
  let threw = false;
  h.boot = create({
    fetchState: async () => (h.calls++, ok({ user: { id: 7 } })),
    onSignedIn: () => {
      throw new Error("map failed to start");
    },
    onSignedOut: () => h.signedOut++,
    onWaiting: () => {},
    backoff: () => 1000,
    setTimer: (f, ms) => (h.timers.push({ f, ms }), h.timers.at(-1)),
    clearTimer: () => {},
    onError: () => (threw = true),
  });
  h.boot.start();
  await settle();
  assert.equal(h.signedOut, 0);
  assert.equal(h.calls, 1, "not fetched again");
  assert.ok(threw);
});
