// Node tests for priv/static/readstore.js — which messages you've read,
// remembered on this device per account, so messages that came while you
// were disconnected or the app was closed show as unread (owner,
// 2026-10-30). Only a bookmark per chat — the other person's id, the
// server's time (Unix seconds) and the message id of the newest of THEIR
// messages you've seen — never names or text.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../priv/static/readstore.js");

function memory() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const msg = (ts, id) => ({ ts, id });

// ---- the rule ----

test("newer: a later time, or the same second with a later id", () => {
  assert.equal(R.newer(msg(101, 1), [100, 9]), true);
  assert.equal(R.newer(msg(100, 10), [100, 9]), true, "same second, later message");
  assert.equal(R.newer(msg(100, 9), [100, 9]), false, "the bookmark itself is read");
  assert.equal(R.newer(msg(100, 8), [100, 9]), false);
  assert.equal(R.newer(msg(99, 50), [100, 9]), false);
});

test("their messages after the bookmark are unread; up to it, read", () => {
  const note = { 7: [100, 2] };
  const r = R.reconcile(note, [{ peerId: 7, theirs: [msg(90, 1), msg(100, 2), msg(130, 3), msg(140, 4)] }], null);
  assert.deepEqual(r.unread, { 7: 2 });
  assert.deepEqual(r.note, { 7: [100, 2] }, "unread stays unread until the chat is opened");
});

test("two messages in the same second: only the one after the bookmark is unread", () => {
  const r = R.reconcile({ 7: [100, 5] }, [{ peerId: 7, theirs: [msg(100, 5), msg(100, 6)] }], null);
  assert.deepEqual(r.unread, { 7: 1 });
});

test("a chat with no bookmark (someone new messaged you meanwhile): all of theirs unread", () => {
  const r = R.reconcile({ 7: [100, 2] }, [{ peerId: 8, theirs: [msg(120, 3), msg(125, 4)] }], null);
  assert.deepEqual(r.unread, { 8: 2 });
  assert.deepEqual(r.note, {}, "no bookmark until it's opened");
});

test("first run (no note at all yet): everything already there is read, bookmarked", () => {
  const r = R.reconcile(null, [
    { peerId: 7, theirs: [msg(90, 1), msg(95, 2)] },
    { peerId: 8, theirs: [] },
  ], null);
  assert.deepEqual(r.unread, { 7: 0, 8: 0 });
  assert.deepEqual(r.note, { 7: [95, 2] }, "a chat with nothing of theirs needs no bookmark");
});

test("the chat on screen is read: no unread, bookmark at its newest", () => {
  const r = R.reconcile({ 7: [100, 2] }, [{ peerId: 7, theirs: [msg(100, 2), msg(130, 3)] }], 7);
  assert.deepEqual(r.unread, { 7: 0 });
  assert.deepEqual(r.note, { 7: [130, 3] });
});

test("bookmarks for chats that no longer exist are dropped", () => {
  const r = R.reconcile({ 7: [100, 2], 9: [50, 1] }, [{ peerId: 7, theirs: [msg(100, 2)] }], null);
  assert.deepEqual(r.note, { 7: [100, 2] });
});

test("seen: the bookmark moves to the newest of theirs, never back; nothing of theirs: unchanged", () => {
  assert.deepEqual(R.seen({}, 7, [msg(90, 1), msg(130, 3), msg(100, 2)]), { 7: [130, 3] });
  assert.deepEqual(R.seen({ 7: [200, 9] }, 7, [msg(130, 3)]), { 7: [200, 9] }, "never backwards");
  assert.deepEqual(R.seen({ 8: [1, 1] }, 7, []), { 8: [1, 1] });
  const before = { 7: [100, 2] };
  R.seen(before, 7, [msg(130, 3)]);
  assert.deepEqual(before, { 7: [100, 2] }, "a new note, the old one untouched");
});

// ---- on the device ----

test("saved and read back per account; another account's is separate", () => {
  const s = memory();
  R.save(s, 1, { 7: [100, 2] });
  R.save(s, 2, { 8: [5, 1] });
  assert.deepEqual(R.read(s, 1), { 7: [100, 2] });
  assert.deepEqual(R.read(s, 2), { 8: [5, 1] });
  assert.equal(R.read(s, 3), null, "nothing yet: null (the first run)");
});

test("only ids and numbers are kept — nothing else survives a save", () => {
  const s = memory();
  R.save(s, 1, { 7: [100, 2], 8: ["x", 1], 9: [1], bad: [1, 2], 10: [3, 4, "text"] });
  assert.deepEqual(R.read(s, 1), { 7: [100, 2] });
  assert.equal([...s.m.values()].join("").includes("text"), false);
});

test("forget (sign-out, deletion) removes this account's; forgetAll every account's", () => {
  const s = memory();
  R.save(s, 1, { 7: [100, 2] });
  R.save(s, 2, { 8: [5, 1] });
  s.setItem("other_app_key", "kept");
  R.forget(s, 1);
  assert.equal(R.read(s, 1), null);
  assert.deepEqual(R.read(s, 2), { 8: [5, 1] });
  R.forgetAll(s);
  assert.equal(R.read(s, 2), null);
  assert.equal(s.getItem("other_app_key"), "kept");
});

test("malformed or blocked storage: nothing remembered, nothing breaks", () => {
  const s = memory();
  s.setItem(R.key(1), "{not json");
  assert.equal(R.read(s, 1), null);
  s.setItem(R.key(1), JSON.stringify([1, 2]));
  assert.equal(R.read(s, 1), null);
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
    key() {
      throw new Error("blocked");
    },
    get length() {
      throw new Error("blocked");
    },
  };
  assert.equal(R.read(blocked, 1), null);
  assert.doesNotThrow(() => R.save(blocked, 1, { 7: [1, 1] }));
  assert.doesNotThrow(() => R.forget(blocked, 1));
  assert.doesNotThrow(() => R.forgetAll(blocked));
  assert.equal(R.read(null, 1), null);
  assert.doesNotThrow(() => R.save(null, 1, {}));
});

// ----- gaps a mutation sweep found (Stryker, owner 2026-11-05) -----

test("a bookmark is exactly [number, number] under an all-digits id — every other shape is dropped", () => {
  const s = memory();
  R.save(s, 1, {
    7: [100, 2],
    "12a": [1, 2], // not all digits
    a12: [1, 2],
    "": [1, 2],
    8: [1, 2, 3], // three numbers
    9: [NaN, 1], // not a finite number
    10: [1, Infinity],
    11: "[1,2]", // text, not a list
    12: { 0: 1, 1: 2 }, // list-like, not a list
  });
  assert.deepEqual(R.read(s, 1), { 7: [100, 2] });
});

test("a saved note that isn't an object (a list, a number, null): not a note — the first run's rule", () => {
  const s = memory();
  for (const raw of ["[]", "[[1,2]]", "5", "null", '"text"', "true"]) {
    s.setItem(R.key(1), raw);
    assert.equal(R.read(s, 1), null, raw);
  }
  R.save(s, 1, [[1, 2]]);
  assert.deepEqual(R.read(s, 1), {}, "a list saved: nothing of it kept");
});

test("signed out (no account) or no storage: nothing read, saved or forgotten — even with storage working", () => {
  const s = memory();
  R.save(s, 1, { 7: [100, 2] });
  R.save(s, null, { 8: [1, 1] });
  R.save(s, undefined, { 8: [1, 1] });
  assert.equal(s.length, 1);
  assert.equal(R.read(s, null), null);
  R.forget(s, undefined);
  assert.deepEqual(R.read(s, 1), { 7: [100, 2] }, "someone else's left alone");
  R.save(null, 1, { 9: [9, 9] });
  R.forgetAll(null);
  assert.deepEqual(R.read(s, 1), { 7: [100, 2] });
});

test("the chat on screen: its bookmark is the newer of the old one and its newest — never back", () => {
  const note = { 7: [100, 5] };
  // the old bookmark is newer than anything left in the chat: kept
  assert.deepEqual(R.reconcile(note, [{ peerId: "7", theirs: [msg(90, 1)] }], "7").note, { 7: [100, 5] });
  // a newer message: the bookmark moves to it
  assert.deepEqual(R.reconcile(note, [{ peerId: "7", theirs: [msg(100, 6)] }], "7").note, { 7: [100, 6] });
  // nothing of theirs, a bookmark: kept; nothing of theirs and no bookmark: none
  assert.deepEqual(R.reconcile(note, [{ peerId: "7", theirs: [] }], "7").note, { 7: [100, 5] });
  assert.deepEqual(R.reconcile({}, [{ peerId: "8", theirs: [] }], "8").note, {});
});

test("seen with nothing newer: the same note back, a copy (never the old object itself)", () => {
  const note = { 7: [100, 5] };
  const same = R.seen(note, "7", [msg(100, 5)]);
  assert.deepEqual(same, note);
  assert.notEqual(same, note, "a new object: the caller may change it");
  const none = R.seen(note, "7", []);
  assert.deepEqual(none, note);
  assert.notEqual(none, note);
});

test("forgetAll removes every account's even when it's the last key (none skipped)", () => {
  const s = memory();
  s.setItem("other_first", "x");
  R.save(s, 1, { 7: [1, 1] });
  R.save(s, 2, { 7: [1, 1] });
  R.forgetAll(s);
  assert.equal(R.read(s, 1), null);
  assert.equal(R.read(s, 2), null);
  assert.equal(s.length, 1);
});
