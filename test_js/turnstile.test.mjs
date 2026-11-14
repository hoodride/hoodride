// Node tests for priv/static/turnstile.js — Cloudflare Turnstile on sign-in
// (review 2026-11-14), against a fake Turnstile and a fake server.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../priv/static/turnstile.js");

// a Turnstile that answers as told: "pass", "error", "expire", or nothing
function fakeTurnstile(answer) {
  const seen = { renders: [], executed: 0, removed: 0 };
  return {
    seen,
    render(_container, opts) {
      seen.renders.push(opts);
      seen.opts = opts;
      return "w1";
    },
    execute() {
      seen.executed++;
      if (answer === "pass") seen.opts.callback("PASS-TOKEN");
      if (answer === "error") seen.opts["error-callback"]();
      if (answer === "expire") seen.opts["expired-callback"]();
    },
    remove() {
      seen.removed++;
    },
  };
}

const server = (reply) => {
  const posted = [];
  return { posted, post: async (body) => (posted.push(body), reply) };
};

test("no site key (Turnstile off): straight to the provider, no check", async () => {
  const s = server({ go: "/auth/google" });
  assert.deepEqual(await T.start("google", { siteKey: null, post: s.post }), { url: "/auth/google" });
  assert.deepEqual(await T.start("facebook", { siteKey: "", post: s.post }), { url: "/auth/facebook" });
  assert.equal(s.posted.length, 0);
});

test("on: the check runs on the tap, its pass is POSTed, and the server says where to go", async () => {
  const ts = fakeTurnstile("pass");
  const s = server({ go: "/auth/google" });
  const r = await T.start("google", { siteKey: "k", getTurnstile: async () => ts, lang: "es", post: s.post });
  assert.deepEqual(r, { url: "/auth/google" });
  assert.deepEqual(s.posted, [{ provider: "google", token: "PASS-TOKEN" }]);
  // Cloudflare's options as the server expects them
  const o = ts.seen.opts;
  assert.equal(o.sitekey, "k");
  assert.equal(o.action, "signin");
  assert.equal(o.execution, "execute");
  assert.equal(o.appearance, "interaction-only");
  assert.equal(o.language, "es");
  assert.equal(ts.seen.removed, 1, "the widget is cleared after use (a pass is single-use)");
});

test("the check fails or expires: nothing is sent, the person is told", async () => {
  for (const answer of ["error", "expire"]) {
    const s = server({ go: "/auth/google" });
    const r = await T.start("google", { siteKey: "k", getTurnstile: async () => fakeTurnstile(answer), post: s.post });
    assert.deepEqual(r, { error: "blocked" });
    assert.equal(s.posted.length, 0);
  }
});

test("Cloudflare's script can't load (a blocker): told, nothing sent", async () => {
  const s = server({ go: "/auth/google" });
  const r = await T.start("google", {
    siteKey: "k",
    getTurnstile: async () => {
      throw new Error("blocked");
    },
    post: s.post,
  });
  assert.deepEqual(r, { error: "blocked" });
});

test("the check never answers: given up after its wait", async () => {
  let fire;
  const r = T.start("google", {
    siteKey: "k",
    getTurnstile: async () => fakeTurnstile("silent"),
    post: async () => ({ go: "/auth/google" }),
    setTimer: (f) => (fire = f),
  });
  await new Promise((ok) => setImmediate(ok));
  fire();
  assert.deepEqual(await r, { error: "blocked" });
});

test("the server refuses the pass, or can't be reached: 'failed'", async () => {
  const refused = await T.start("google", {
    siteKey: "k",
    getTurnstile: async () => fakeTurnstile("pass"),
    post: async () => ({ error: "check_failed" }),
  });
  assert.deepEqual(refused, { error: "failed" });
  const down = await T.start("google", {
    siteKey: "k",
    getTurnstile: async () => fakeTurnstile("pass"),
    post: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.deepEqual(down, { error: "failed" });
});

test("Cloudflare's script: loaded once, from Cloudflare only, explicit rendering", async () => {
  assert.equal(T.SCRIPT, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  const already = { turnstile: { id: 1 } };
  assert.equal(await T.load({}, already), already.turnstile);
});
