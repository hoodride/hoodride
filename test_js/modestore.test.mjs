// Node tests for priv/static/modestore.js — the last mode (driver/rider) a
// person picked, remembered on this device per account, so a reload or a
// sign-in comes back as what they were. What the server knows (an online
// shift, a ride, waiting requests) still wins in app.js's hydrate; going
// online is never restored from here.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../priv/static/modestore.js");

function memory() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    size: () => m.size,
  };
}

test("picked driver: read back as driver; picked rider: rider", () => {
  const s = memory();
  M.save(s, 7, "driver");
  assert.equal(M.read(s, 7), "driver");
  M.save(s, 7, "rider");
  assert.equal(M.read(s, 7), "rider");
});

test("per account: someone else on this phone doesn't inherit it", () => {
  const s = memory();
  M.save(s, 7, "driver");
  assert.equal(M.read(s, 8), null);
});

test("nothing saved, or junk saved: null (the app's default, rider)", () => {
  const s = memory();
  assert.equal(M.read(s, 7), null);
  s.setItem(M.key(7), "admin");
  assert.equal(M.read(s, 7), null);
});

test("forget: a deleted account leaves nothing behind", () => {
  const s = memory();
  M.save(s, 7, "driver");
  M.forget(s, 7);
  assert.equal(M.read(s, 7), null);
  assert.equal(s.size(), 0);
});

test("only driver or rider is ever stored", () => {
  const s = memory();
  M.save(s, 7, "online");
  assert.equal(s.size(), 0);
});

test("storage that throws (private mode, blocked): nothing breaks", () => {
  const bad = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(M.read(bad, 7), null);
  assert.doesNotThrow(() => M.save(bad, 7, "driver"));
  assert.doesNotThrow(() => M.forget(bad, 7));
  assert.equal(M.read(null, 7), null);
  const stray = memory();
  stray.setItem(M.key(null), "driver");
  assert.equal(M.read(stray, null), null, "no account: nothing, whatever is stored");
  M.save(stray, undefined, "rider");
  assert.equal(stray.getItem(M.key(undefined)), null, "and nothing saved for no account");
});
