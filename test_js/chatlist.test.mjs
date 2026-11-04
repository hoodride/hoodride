// Node tests for priv/static/chatlist.js — the chat list (ARCHITECTURE.md
// "Chat list"): newest conversation first, unread ones bold, and how long
// ago the last message came ("now", "2m", "1h"), like Messenger/Instagram.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../priv/static/chatlist.js");

test("how long ago: now, minutes, hours, days", () => {
  assert.equal(L.ago(0), "now");
  assert.equal(L.ago(59_999), "now");
  assert.equal(L.ago(60_000), "1m");
  assert.equal(L.ago(59 * 60_000 + 59_999), "59m");
  assert.equal(L.ago(3_600_000), "1h");
  assert.equal(L.ago(23 * 3_600_000 + 3_599_999), "23h");
  assert.equal(L.ago(24 * 3_600_000), "1d");
});

test("a time a little in the future (two clocks a hair apart): now, never '-1m'", () => {
  assert.equal(L.ago(-5_000), "now");
});

test("newest first; the original order breaks ties", () => {
  const a = { name: "a", lastAt: 100 };
  const b = { name: "b", lastAt: 300 };
  const c = { name: "c", lastAt: 200 };
  const d = { name: "d", lastAt: 300 };
  assert.deepEqual(L.newestFirst([a, b, c, d]).map((x) => x.name), ["b", "d", "c", "a"]);
});

test("newest first doesn't touch the list it was given", () => {
  const list = [{ lastAt: 1 }, { lastAt: 2 }];
  L.newestFirst(list);
  assert.deepEqual(list.map((x) => x.lastAt), [1, 2]);
});

test("a server time on this phone's clock: the phone's clock may be off", () => {
  // the server said it was 1,000,000 ms when this phone read 400,000 (the
  // phone is 600 s slow): a message the server stamped at 990 s happened
  // 10 s before that — on this phone, at 390,000
  const skew = L.skew(1_000_000, 400_000);
  assert.equal(L.localAt(990, skew), 390_000);
  assert.equal(L.skew(undefined, 400_000), 0, "no server time: trust the phone");
});

// ── the message box's 500 (2026-10-29): counted as people see characters,
// and a warning instead of cutting text (GOV.UK / Scottish Government
// design systems: "non-destructive… a warning instead of losing any of
// it"). The browser's maxlength counted hidden pieces: 👨‍👩‍👧‍👦 was 11.

test("count: what people see as one character is one", () => {
  assert.equal(L.count("hello"), 5);
  assert.equal(L.count("👨‍👩‍👧‍👦"), 1);
  assert.equal(L.count("👩🏻‍❤️‍💋‍👨🏼"), 1);
  assert.equal(L.count("🇺🇸🇲🇽"), 2);
  assert.equal(L.count("שלום"), 4);
  assert.equal(L.count("é"), 1, "e + combining accent");
  assert.equal(L.count(""), 0);
});

test("count without Intl.Segmenter (old browsers): never fewer than what people see", () => {
  // code points: a glued emoji counts as its pieces — stricter, never looser
  assert.equal(L.count("hello", null), 5);
  assert.equal(L.count("😀", null), 1, "not 2 like maxlength");
  assert.ok(L.count("👨‍👩‍👧‍👦", null) >= L.count("👨‍👩‍👧‍👦"));
});

test("the counter: hidden until 400, then what's left, then how many too many", () => {
  assert.equal(L.MAX_CHARS, 500);
  assert.equal(L.COUNT_FROM, 400);
  assert.deepEqual(L.limit(0), { show: false, over: false, text: "500 characters left" });
  assert.equal(L.limit(399).show, false);
  assert.deepEqual(L.limit(400), { show: true, over: false, text: "100 characters left" });
  assert.deepEqual(L.limit(499), { show: true, over: false, text: "1 character left" });
  assert.deepEqual(L.limit(500), { show: true, over: false, text: "0 characters left" });
  assert.deepEqual(L.limit(501), { show: true, over: true, text: "1 character too many" });
  assert.deepEqual(L.limit(520), { show: true, over: true, text: "20 characters too many" });
});

test("500 of the heaviest emoji are exactly at the limit, not over", () => {
  assert.equal(L.limit(L.count("👩🏻‍❤️‍💋‍👨🏼".repeat(500))).over, false);
  assert.equal(L.limit(L.count("👨‍👩‍👧‍👦".repeat(501))).over, true);
});
