// Node tests for priv/static/msgcopy.js — tap a chat message, "Copy".
// Person-to-person chat apps copy from a per-message menu rather than a
// button on every bubble (clutter, mis-taps); a TAP opens ours, so it's as
// findable as a button, the copy runs on a real tap (Safari allows the
// clipboard only inside a user gesture), and press-and-hold stays the
// phone's own text selection for partial copies.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { create, COPIED_MS } = require("../priv/static/msgcopy.js");

// a chat with fake clipboard, fake timers, a fake selection; `shown` is
// what the chip looks like now (null = no chip)
function harness({ clipboard = "ok", legacy = true } = {}) {
  const h = { shown: null, copied: [], legacyCopied: [], timers: [], selection: false };
  h.c = create({
    clipboard:
      clipboard === "none"
        ? null
        : {
            writeText: (t) => {
              if (clipboard === "ok") {
                h.copied.push(t);
                return Promise.resolve();
              }
              return Promise.reject(new Error("denied"));
            },
          },
    legacyCopy: (t) => {
      h.legacyCopied.push(t);
      return legacy;
    },
    render: (open) => (h.shown = open && { key: open.key, label: open.label }),
    hasSelection: () => h.selection,
    setTimer: (f, ms) => {
      const t = { f, ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => t && (t.cleared = true),
  });
  h.fire = () => h.timers.filter((t) => !t.cleared).forEach((t) => ((t.cleared = true), t.f()));
  return h;
}

const settle = () => new Promise((r) => setImmediate(r));

test("a tap shows Copy under that message", () => {
  const h = harness();
  h.c.tap("m1", "Gate code 4412");
  assert.deepEqual(h.shown, { key: "m1", label: "copy" });
});

test("tapping the same message again closes it", () => {
  const h = harness();
  h.c.tap("m1", "hi");
  h.c.tap("m1", "hi");
  assert.equal(h.shown, null);
});

test("tapping another message moves it there — one chip at a time", () => {
  const h = harness();
  h.c.tap("m1", "hi");
  h.c.tap("m2", "there");
  assert.deepEqual(h.shown, { key: "m2", label: "copy" });
});

test("close (scroll, an outside tap, a re-render) removes it", () => {
  const h = harness();
  h.c.tap("m1", "hi");
  h.c.close();
  assert.equal(h.shown, null);
  h.c.close(); // closing nothing is fine
  assert.equal(h.shown, null);
});

test("a tap while the person is selecting text shows nothing", () => {
  const h = harness();
  h.selection = true;
  h.c.tap("m1", "hi");
  assert.equal(h.shown, null);
});

test("Copy writes EXACTLY the message, then says Copied, then closes", async () => {
  for (const text of ["Blue Honda 🚗 by the gate", "line one\nline two", "x".repeat(2000), "<b>not html</b> & ${code}", "  spaced  "]) {
    const h = harness();
    h.c.tap("m1", text);
    h.c.copy();
    await settle();
    assert.deepEqual(h.copied, [text]);
    assert.deepEqual(h.shown, { key: "m1", label: "copied" });
    const t = h.timers.find((t) => !t.cleared);
    assert.equal(t.ms, COPIED_MS);
    h.fire();
    assert.equal(h.shown, null);
  }
});

test("Copy with no chip open does nothing", async () => {
  const h = harness();
  h.c.copy();
  await settle();
  assert.deepEqual(h.copied, []);
  assert.deepEqual(h.legacyCopied, []);
});

test("the clipboard refuses → the older copy is used", async () => {
  const h = harness({ clipboard: "denied" });
  h.c.tap("m1", "Apt 5B");
  h.c.copy();
  await settle();
  assert.deepEqual(h.legacyCopied, ["Apt 5B"]);
  assert.deepEqual(h.shown, { key: "m1", label: "copied" });
});

test("no clipboard at all (plain http) → the older copy is used", async () => {
  const h = harness({ clipboard: "none" });
  h.c.tap("m1", "Apt 5B");
  h.c.copy();
  await settle();
  assert.deepEqual(h.legacyCopied, ["Apt 5B"]);
  assert.deepEqual(h.shown, { key: "m1", label: "copied" });
});

test("both refuse → it says it couldn't copy", async () => {
  const h = harness({ clipboard: "denied", legacy: false });
  h.c.tap("m1", "Apt 5B");
  h.c.copy();
  await settle();
  assert.deepEqual(h.shown, { key: "m1", label: "failed" });
  h.fire();
  assert.equal(h.shown, null);
});

test("a copy that finishes after the chip moved never relabels the new one", async () => {
  const h = harness();
  h.c.tap("m1", "first");
  h.c.copy(); // the clipboard answers later
  h.c.tap("m2", "second");
  await settle();
  assert.deepEqual(h.copied, ["first"]);
  assert.deepEqual(h.shown, { key: "m2", label: "copy" });
  assert.equal(h.timers.filter((t) => !t.cleared).length, 0, "no stray close timer");
});

test("a 'Copied' timer from before never closes a chip opened since", async () => {
  const h = harness();
  h.c.tap("m1", "first");
  h.c.copy();
  await settle();
  h.c.tap("m2", "second"); // the old timer must not close this one
  h.fire();
  assert.deepEqual(h.shown, { key: "m2", label: "copy" });
});

// ===== where the chip floats (place): over the chat, never in its flow =====
const { place, GAP, EDGE } = require("../priv/static/msgcopy.js");
const chip = { width: 60, height: 28 };
const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

test("close says which message it closed (for Escape to return focus), or null", () => {
  const h = harness();
  assert.equal(h.c.close(), null);
  h.c.tap("m1", "hi");
  assert.equal(h.c.close(), "m1");
  assert.equal(h.c.close(), null);
});

test("their short message: the chip floats BESIDE it, on its empty right side", () => {
  const bubble = { left: 14, top: 200, width: 120, height: 40 };
  const p = place(bubble, chip, 390, "them");
  assert.equal(p.where, "beside");
  assert.equal(p.left, 14 + 120 + GAP);
  assert.equal(p.top, 200 + (40 - 28) / 2);
});

test("my short message: beside it, on its empty LEFT side", () => {
  const bubble = { left: 256, top: 200, width: 120, height: 40 };
  const p = place(bubble, chip, 390, "me");
  assert.equal(p.where, "beside");
  assert.equal(p.left, 256 - GAP - 60);
});

test("a message too wide for the chip beside it: ABOVE it, on its own side", () => {
  // 320 of 390: right of it would end at 402, past the chat's 382
  const them = place({ left: 14, top: 200, width: 320, height: 60 }, chip, 390, "them");
  assert.deepEqual(them, { where: "above", left: 14, top: 200 - GAP - 28 });
  const me = place({ left: 56, top: 200, width: 320, height: 60 }, chip, 390, "me");
  assert.deepEqual(me, { where: "above", left: 56 + 320 - 60, top: 200 - GAP - 28 });
});

test("a wide message at the very top of the chat: BELOW it (above would be cut off)", () => {
  const p = place({ left: 14, top: 12, width: 320, height: 60 }, chip, 390, "them");
  assert.deepEqual(p, { where: "below", left: 14, top: 12 + 60 + GAP });
});

test("wherever it goes, it never covers its message and never leaves the chat's sides", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) {
    const width = 320 + Math.floor(rnd() * 900);
    const side = rnd() < 0.5 ? "me" : "them";
    const w = 40 + Math.floor(rnd() * (width * 0.75 - 40));
    const bubble = { left: side === "them" ? 14 : width - 14 - w, top: Math.floor(rnd() * 900), width: w, height: 30 + Math.floor(rnd() * 120) };
    const c = { width: 50 + Math.floor(rnd() * 60), height: 28 };
    const p = place(bubble, c, width, side);
    const rect = { left: p.left, top: p.top, width: c.width, height: c.height };
    assert.ok(!overlaps(rect, bubble), `covers its message: ${JSON.stringify({ bubble, c, p, width })}`);
    assert.ok(p.left >= EDGE && p.left + c.width <= width - EDGE, `leaves the chat: ${JSON.stringify({ bubble, c, p, width })}`);
    assert.ok(p.top >= 0, `above the chat's start: ${JSON.stringify({ bubble, p })}`);
  }
});
