// Node tests for priv/static/icons.js — the app's icons are pictures, not
// emoji (owner, 2026-11-01): every phone draws an emoji its own way, and an
// older one may draw a box. App text keeps the emoji as a marker; the page
// shows the picture in its place (app.js setIconText).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../priv/static/icons.js");

const hand = { emoji: "✋", src: "hand.svg" };
const pin = { emoji: "\u{1F4CD}", src: "pin.svg" };
const compass = { emoji: "\u{1F9ED}", src: "compass.svg" };
const chat = { emoji: "\u{1F4AC}", src: "chat.svg" };
const car = { emoji: "\u{1F697}", src: "car.png" };
const person = { emoji: "\u{1F64B}", src: "person.svg" };

test("an icon at the start: the picture, then the words (its space taken by the picture's margin)", () => {
  assert.deepEqual(I.parts("✋ Need a ride"), [hand, "Need a ride"]);
  assert.deepEqual(I.parts("\u{1F4CD} Meet here"), [pin, "Meet here"]);
  assert.deepEqual(I.parts("\u{1F4AC} Chat (2)"), [chat, "Chat (2)"]);
  assert.deepEqual(I.parts("\u{1F697} Drive"), [car, "Drive"]);
  // your rider in a ride (their real spot) — not the ✋ of someone nearby
  assert.deepEqual(I.parts("\u{1F64B}"), [person]);
});

test("an icon inside a sentence", () => {
  assert.deepEqual(I.parts("Picking up Rita · tap \u{1F9ED} to navigate"), ["Picking up Rita · tap ", compass, "to navigate"]);
  assert.deepEqual(I.parts("Connection reset — tap ✋ again"), ["Connection reset — tap ", hand, "again"]);
});

test("the emoji's colour form (with U+FE0F) is the same icon", () => {
  assert.deepEqual(I.parts("✋️ Need a ride"), [hand, "Need a ride"]);
});

test("text with no icon, other emoji, and an empty line are left as they are", () => {
  assert.deepEqual(I.parts("GO ONLINE"), ["GO ONLINE"]);
  assert.deepEqual(I.parts("⏳ Waiting for the driver…"), ["⏳ Waiting for the driver…"]);
  assert.deepEqual(I.parts(""), []);
});

test("every icon's picture is in the app", () => {
  for (const src of Object.values(I.ICONS)) assert.ok(existsSync(new URL(`../priv/static/${src}`, import.meta.url)), src);
});
