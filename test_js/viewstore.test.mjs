// The map area last used, remembered on this device per account, so the
// map opens where you were (the privacy page promised it; owner,
// 2026-10-29). Cleared on sign-out — any sign-out: the privacy page says
// "Signing out removes them".
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const V = require("../priv/static/viewstore.js");

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

test("saved, then read back — per account", () => {
  const s = memory();
  V.save(s, 7, { lng: -73.98765432, lat: 40.75123456, zoom: 15.25 });
  const v = V.read(s, 7);
  assert.deepEqual(v, { lng: -73.9877, lat: 40.7512, zoom: 15.25 }, "about 10 m is plenty");
  assert.equal(V.read(s, 8), null, "someone else on this phone doesn't get it");
});

test("anything malformed or out of range is ignored — the map never breaks on it", () => {
  const s = memory();
  for (const bad of [
    "nope",
    "{}",
    JSON.stringify({ lng: 200, lat: 40, zoom: 14 }),
    JSON.stringify({ lng: -74, lat: 95, zoom: 14 }),
    JSON.stringify({ lng: -74, lat: 40, zoom: 99 }),
    JSON.stringify({ lng: "x", lat: 40, zoom: 14 }),
  ]) {
    s.setItem(V.key(7), bad);
    assert.equal(V.read(s, 7), null, bad);
  }
  V.save(s, 7, { lng: NaN, lat: 40, zoom: 14 });
  assert.equal(V.read(s, 7), null, "a bad save writes nothing usable");
});

test("signing out forgets it; forgetAll forgets every account's on this phone", () => {
  const s = memory();
  V.save(s, 7, { lng: -74, lat: 40.7, zoom: 14 });
  V.save(s, 8, { lng: -73, lat: 40.6, zoom: 13 });
  s.setItem("hoodride_mode_7", "driver"); // not ours: left alone
  V.forget(s, 7);
  assert.equal(V.read(s, 7), null);
  assert.ok(V.read(s, 8));
  V.forgetAll(s);
  assert.equal(V.read(s, 8), null);
  assert.equal(s.getItem("hoodride_mode_7"), "driver");
});

test("storage blocked (private mode): nothing remembered, nothing breaks", () => {
  const broken = {
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
  assert.equal(V.read(broken, 7), null);
  V.save(broken, 7, { lng: -74, lat: 40.7, zoom: 14 });
  V.forget(broken, 7);
  V.forgetAll(broken);
  assert.equal(V.read(null, 7), null);
  assert.equal(V.read(memory(), null), null);
});

test("where the map opens: the remembered area, else the placeholder at zoom 14", () => {
  const fallback = { lat: 40.7128, lng: -74.006 };
  assert.deepEqual(V.startView({ lng: -73.9, lat: 40.8, zoom: 16 }, fallback), {
    center: [-73.9, 40.8],
    zoom: 16,
  });
  assert.deepEqual(V.startView(null, fallback), { center: [-74.006, 40.7128], zoom: 14 });
});
