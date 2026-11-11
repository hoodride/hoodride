// Node tests for priv/static/update.js — after a deploy, an app that stayed
// open keeps running the OLD code (a single-page app never navigates, so
// the browser never looks for a new version by itself). The server says
// which build it runs (a fingerprint of the app files, computed at boot —
// nobody bumps it); the app compares it with the build it loaded. Best
// practice (Chrome's Workbox guide, LiveView's static tracking, common
// SPA practice): never yank a page someone is using — reload silently only
// while the app is hidden and nothing is in progress, otherwise offer
// "Update available — tap to reload".
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const U = require("../priv/static/update.js");

const idle = { mode: "rider", online: false, handRaised: false, ride: null, draft: "", form: false };
const v = (over) => ({ ...idle, ...over });

test("the same build, or nothing to compare: nothing to do", () => {
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: "a1", hidden: true, busy: false }), "none");
  // an older server that doesn't say its build
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: undefined, hidden: true, busy: false }), "none");
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: null, hidden: true, busy: false }), "none");
  // a page that doesn't know its own build can't tell old from new
  assert.equal(U.decide({ loadedBuild: null, serverBuild: "b2", hidden: true, busy: false }), "none");
});

test("a new build while the app is hidden and idle: reload silently", () => {
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: "b2", hidden: true, busy: false }), "reload");
});

test("a new build while the app is on screen: offer it, never yank the page", () => {
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: "b2", hidden: false, busy: false }), "offer");
});

test("a new build while something is in progress: offer it, even when hidden", () => {
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: "b2", hidden: true, busy: true }), "offer");
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: "b2", hidden: false, busy: true }), "offer");
});

test("busy: a ride, a request, a raised hand, a shift, or a half-typed message", () => {
  assert.equal(U.isBusy(v({ ride: { status: "connected" } })), true);
  assert.equal(U.isBusy(v({ ride: { status: "arrived" } })), true);
  assert.equal(U.isBusy(v({ ride: { status: "requested" } })), true);
  assert.equal(U.isBusy(v({ handRaised: true })), true);
  assert.equal(U.isBusy(v({ mode: "driver", online: true })), true);
  assert.equal(U.isBusy(v({ draft: "on my way" })), true);
});

// a form open — the car form, half filled in: a reload wiped what was typed
// (U2, owner 2026-11-11; test_browser/carformupdate.mjs)
test("busy: a form open (the car form)", () => {
  assert.equal(U.isBusy(v({ form: true })), true);
  assert.equal(U.decide({ loadedBuild: "a1", serverBuild: "b2", hidden: true, busy: U.isBusy(v({ form: true })) }), "offer");
  // closed: not busy for it
  assert.equal(U.isBusy(v({ form: false })), false);
});

test("not busy: just looking at the map, as a rider or an off-duty driver", () => {
  assert.equal(U.isBusy(v({})), false);
  assert.equal(U.isBusy(v({ mode: "driver", online: false })), false);
  // whitespace isn't a message
  assert.equal(U.isBusy(v({ draft: "   " })), false);
});
