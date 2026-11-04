// Node tests for priv/static/reveal_queue.js — the pile list's names.
// Before it, every row asked for its own name; the rows over the rate
// budget all retried together on a flat 2 s timer, most were refused
// again, and a crowded pile filled in two names at a time (a tapped ⏳ row
// opened at once: its own fresh ask fitted). Standard practice: only the
// rows on screen, one request for the lookups of one moment (DataLoader),
// and on "not yet" wait exactly the server's retry time — one queue, one timer.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MAX, create } = require("../priv/static/reveal_queue.js");

// a queue with a fake server, a fake "this tick" and fake timers
function harness({ wanted = () => true } = {}) {
  const h = { sent: [], replies: [], deferred: [], timers: [], users: [], gone: [], changes: 0 };
  h.q = create({
    send: (ids, reply) => {
      h.sent.push(ids);
      h.replies.push(reply);
    },
    wanted: (id) => wanted(id),
    onUser: (u) => h.users.push(u.id),
    onGone: (id) => h.gone.push(id),
    onChange: () => h.changes++,
    defer: (f) => h.deferred.push(f),
    setTimer: (f, ms) => h.timers.push({ f, ms }),
  });
  h.tick = () => h.deferred.splice(0).forEach((f) => f());
  h.answer = (a) => h.replies.shift()(a);
  h.fire = () => h.timers.shift().f();
  return h;
}
const user = (id) => ({ id, name: `n${id}`, photo: null });

test("the rows asked for in one moment go in ONE request", () => {
  const h = harness();
  [1, 2, 3].forEach(h.q.want);
  assert.equal(h.sent.length, 0, "nothing before the moment ends");
  h.tick();
  assert.deepEqual(h.sent, [[1, 2, 3]]);
});

test("at most MAX ids per request; the rest go after the answer", () => {
  const h = harness();
  const ids = Array.from({ length: MAX + 5 }, (_, i) => i + 1);
  ids.forEach(h.q.want);
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].length, MAX);
  h.answer({ users: h.sent[0].map(user), unavailable: [], later: [] });
  h.tick();
  assert.deepEqual(h.sent[1], ids.slice(MAX));
});

test("'not yet': ONE retry after exactly the server's wait, those rows first", () => {
  const h = harness();
  [1, 2, 3, 4].forEach(h.q.want);
  h.tick();
  h.q.want(5); // asked while the request is on its way: behind 3 and 4
  h.answer({ users: [user(1), user(2)], unavailable: [], later: [3, 4], retry_ms: 917 });
  h.q.want(6);
  h.tick();
  assert.equal(h.sent.length, 1, "nothing is sent while the server's wait runs");
  assert.deepEqual(
    h.timers.map((t) => t.ms),
    [917],
    "one timer for the whole list, the server's exact wait"
  );
  h.fire();
  h.tick();
  assert.deepEqual(h.sent[1], [3, 4, 5, 6]);
  assert.deepEqual(h.users, [1, 2]);
});

test("a row scrolled away before its turn is not asked for", () => {
  const visible = new Set([1, 2, 3]);
  const h = harness({ wanted: (id) => visible.has(id) });
  [1, 2, 3].forEach(h.q.want);
  visible.delete(2);
  h.q.drop(3);
  h.tick();
  assert.deepEqual(h.sent, [[1]]);
});

test("unavailable: told once, never asked again by itself", () => {
  const h = harness();
  h.q.want(7);
  h.tick();
  h.answer({ users: [], unavailable: [7], later: [] });
  h.tick();
  assert.deepEqual(h.gone, [7]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.length, 0);
});

test("one request at a time; a row already asked for isn't asked twice", () => {
  const h = harness();
  h.q.want(1);
  h.tick();
  h.q.want(1); // the list re-rendered while the answer is on its way
  h.q.want(2);
  h.tick();
  assert.deepEqual(h.sent, [[1]], "the second waits for the first answer");
  h.answer({ users: [user(1)], unavailable: [], later: [] });
  h.tick();
  assert.deepEqual(h.sent, [[1], [2]]);
});

test("no answer: no retry loop — the next look at the list asks again", () => {
  const h = harness();
  h.q.want(1);
  h.tick();
  h.answer(null);
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.length, 0);
  // a redraw re-observes the rows (= asks again): offline, ask → fail →
  // redraw → ask… would loop
  assert.equal(h.changes, 0, "no redraw after no answer");
  h.q.want(1);
  h.tick();
  assert.deepEqual(h.sent, [[1], [1]]);
});

test("every answer lets the list redraw", () => {
  const h = harness();
  h.q.want(1);
  h.tick();
  h.answer({ users: [user(1)], unavailable: [], later: [] });
  assert.equal(h.changes, 1);
});
