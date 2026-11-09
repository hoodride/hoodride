// Node tests for priv/static/chatmerge.js — light reload (owner, 2026-11-08):
// a chat the reload brought as a summary loads its messages when it's
// opened; what arrived while it loaded is put together with the server's
// answer. Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../priv/static/chatmerge.js");

// a message from the server, and a local note (no id) that came after `after`
const msg = (id, text = `m${id}`) => ({ id, text });
const note = (text, after) => ({ id: null, text, after });
const texts = (list) => list.map((m) => m.text);

test("the server's messages, as they come", () => {
  assert.deepEqual(texts(M.merge([msg(1), msg(2), msg(3)], [])), ["m1", "m2", "m3"]);
});

test("a message that came live while loading AND is in the answer: once", () => {
  const live = msg(3);
  assert.deepEqual(texts(M.merge([msg(1), msg(2), msg(3)], [live])), ["m1", "m2", "m3"]);
});

test("a message that came live after the answer was made: added after it", () => {
  assert.deepEqual(texts(M.merge([msg(1), msg(2)], [msg(3)])), ["m1", "m2", "m3"]);
});

test("a held message older than the answer's newest and not in it was trimmed by the server: dropped", () => {
  // (the server keeps the newest 50; ids only go up)
  assert.deepEqual(texts(M.merge([msg(5), msg(6)], [msg(2)])), ["m5", "m6"]);
});

test("an empty answer (a ride's chat, nothing said yet): everything held is kept", () => {
  assert.deepEqual(texts(M.merge([], [msg(7), msg(8)])), ["m7", "m8"]);
});

test("a ride note goes right after the message it came after", () => {
  const r = M.merge([msg(1), msg(2), msg(3)], [note("📩 requested", 2)]);
  assert.deepEqual(texts(r), ["m1", "m2", "📩 requested", "m3"]);
});

test("two notes after the same message: in the order they came", () => {
  const r = M.merge([msg(1), msg(2)], [note("a", 1), note("b", 1)]);
  assert.deepEqual(texts(r), ["m1", "a", "b", "m2"]);
});

test("a note after a message that also came live while loading: it finds it", () => {
  const r = M.merge([msg(1)], [msg(2), note("after two", 2), msg(3)]);
  assert.deepEqual(texts(r), ["m1", "m2", "after two", "m3"]);
});

test("a note with nothing before it, or after a message that's gone: at the end, in order", () => {
  const r = M.merge([msg(5), msg(6)], [note("first", null), note("lost anchor", 2), note("last", null)]);
  assert.deepEqual(texts(r), ["m5", "m6", "first", "lost anchor", "last"]);
});

test("nothing is changed in place: the answer's and the held lists stay as they were", () => {
  const reply = [msg(1), msg(2)];
  const held = [msg(3), note("n", 1)];
  M.merge(reply, held);
  assert.deepEqual(texts(reply), ["m1", "m2"]);
  assert.deepEqual(texts(held), ["m3", "n"]);
});

test("the same message objects come back (a bubble can be found by its message)", () => {
  const live = msg(3);
  const n = note("n", 2);
  const r = M.merge([msg(1), msg(2)], [live, n]);
  assert.ok(r.includes(live) && r.includes(n));
});
