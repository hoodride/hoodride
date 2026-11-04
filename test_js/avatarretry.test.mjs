// Node tests for priv/static/avatarretry.js — a profile photo that fails
// to load. Components that retry images use a few retries with growing
// delays, then a placeholder (Remotion's <Img>: 2 retries from 1 s;
// react-graceful-image: from 2 s, doubling), and must never loop on their
// own fallback. Ours: 🙂 at once, then up to 2 retries (~2 s, ~4 s,
// randomised so a list of failures doesn't retry in step), only while the
// image is still on screen and still showing our 🙂.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { retryDelay, retryUrl, ours, MAX_RETRIES } = require("../priv/static/avatarretry.js");

test("two retries at most, then none", () => {
  assert.equal(MAX_RETRIES, 2);
  assert.notEqual(retryDelay(0, () => 0.5), null);
  assert.notEqual(retryDelay(1, () => 0.5), null);
  assert.equal(retryDelay(2, () => 0.5), null);
  assert.equal(retryDelay(9, () => 0.5), null);
});

test("the waits grow (~2 s, then ~4 s) and are randomised within bounds", () => {
  assert.equal(retryDelay(0, () => 0.5), 2000);
  assert.equal(retryDelay(1, () => 0.5), 4000);
  // random in [0.5, 1.5) of the base: never in lockstep, never zero
  assert.equal(retryDelay(0, () => 0), 1000);
  assert.ok(retryDelay(0, () => 0.999999) <= 3000); // (rounded)
  assert.ok(retryDelay(1, () => 0) >= 2000);
});

test("only our own photos are retried", () => {
  assert.ok(ours("https://hood.example/avatars/aaaaaaaaaaaaaaaaaaaaaa.jpg"));
  assert.ok(ours("http://localhost:4000/avatars/x.png?r=1"));
  assert.ok(!ours("data:image/svg+xml,🙂"), "never the 🙂 itself (no loop)");
  assert.ok(!ours("https://lh3.googleusercontent.com/a/x"));
  assert.ok(!ours(""));
  assert.ok(!ours(null));
});

test("a retry asks for a fresh copy (a failed answer is never reused)", () => {
  assert.equal(retryUrl("https://h/avatars/a.jpg", 1), "https://h/avatars/a.jpg?r=1");
  assert.equal(retryUrl("https://h/avatars/a.jpg?r=1", 2), "https://h/avatars/a.jpg?r=2");
});
