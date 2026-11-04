// The chat follows new messages only if you're at the bottom; scrolled up
// to reread, it stays put and offers "↓ New message" (owner, 2026-10-29;
// as iMessage, WhatsApp, Slack). Your own message always goes to the
// bottom — you just sent it.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../priv/static/chatscroll.js");

const box = (scrollTop, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight });

test("at the bottom: exactly there, or within the slack (a nudge isn't reading history)", () => {
  assert.equal(S.atBottom(box(600)), true, "exactly at the bottom");
  assert.equal(S.atBottom(box(600 - S.SLACK_PX)), true, "within the slack");
  assert.equal(S.atBottom(box(600 - S.SLACK_PX - 1)), false, "beyond it: reading");
  assert.equal(S.atBottom(box(0)), false, "at the top of a long chat");
  assert.equal(S.atBottom(box(0, 300, 400)), true, "everything fits: always at the bottom");
});

test("a new message: follow if you were at the bottom, else hold and offer the button", () => {
  assert.equal(S.onNew({ mine: false, wasAtBottom: true }), "follow");
  assert.equal(S.onNew({ mine: false, wasAtBottom: false }), "offer");
  assert.equal(S.onNew({ mine: true, wasAtBottom: false }), "follow", "your own: always shown");
  assert.equal(S.onNew({ mine: true, wasAtBottom: true }), "follow");
});

// ── "stuck to the bottom" is REMEMBERED, not measured when a message comes
// (owner's iPhone, 2026-10-29: tapping the text box opened the keyboard, the
// list moved — browser scroll anchoring and/or the area shrinking — and the
// next reply showed "↓ New message" though they never scrolled up). Rules as
// use-stick-to-bottom: only an UPWARD scroll that isn't the app's own and
// isn't caused by a resize unsticks; back near the bottom re-sticks; a resize
// (keyboard, rotation) keeps a stuck reader at the bottom.

const el = (scrollTop, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight });

test("it starts stuck", () => {
  assert.equal(S.createStick().stuck, true);
});

test("your upward scroll unsticks; scrolling back near the bottom re-sticks", () => {
  const s = S.createStick();
  s.ownScroll(600);
  s.onScroll(el(300));
  assert.equal(s.stuck, false, "you scrolled up to read");
  s.onScroll(el(450));
  assert.equal(s.stuck, false, "still reading");
  s.onScroll(el(600 - S.SLACK_PX));
  assert.equal(s.stuck, true, "back near the bottom");
});

test("the app's own scrolls never unstick (opening a chat, the button)", () => {
  const s = S.createStick();
  s.ownScroll(600);
  s.onScroll(el(600));
  s.ownScroll(0); // e.g. a redraw emptied the list first
  s.onScroll(el(0));
  assert.equal(s.stuck, true);
});

test("the keyboard: a scroll caused by a resize doesn't unstick, and the stuck reader is kept at the bottom", () => {
  const s = S.createStick();
  s.ownScroll(600);
  assert.equal(s.resizeStarted(), true, "stuck: keep at the bottom");
  s.onScroll(el(450, 1000, 250)); // the list moved during the keyboard slide
  assert.equal(s.stuck, true, "not your scroll");
  s.resizeDone();
  s.onScroll(el(200, 1000, 250));
  assert.equal(s.stuck, false, "after the resize, your own scroll up counts again");
  assert.equal(s.resizeStarted(), false, "unstuck: a resize leaves a reader where they are");
});

test("the list shrinks under you (keyboard): still stuck, so the next message follows", () => {
  const s = S.createStick();
  s.ownScroll(600);
  // same scrollTop, smaller box: MEASURED it's no longer at the bottom…
  assert.equal(S.atBottom(el(600, 1000, 250)), false);
  // …but nobody scrolled: the message follows
  assert.equal(S.onNew({ mine: false, wasAtBottom: s.stuck }), "follow");
});
