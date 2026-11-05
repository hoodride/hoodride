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

// ----- gaps a mutation sweep found (Stryker, owner 2026-11-05) -----

test("the exact edges are valid; one step past them isn't", () => {
  const s = memory();
  for (const edge of [
    { lng: 180, lat: 0, zoom: 14 },
    { lng: -180, lat: 0, zoom: 14 },
    { lng: 0, lat: 90, zoom: 14 },
    { lng: 0, lat: -90, zoom: 14 },
    { lng: 0, lat: 0, zoom: 0 },
    { lng: 0, lat: 0, zoom: 22 },
  ]) {
    s.setItem(V.key(7), JSON.stringify(edge));
    assert.deepEqual(V.read(s, 7), edge, JSON.stringify(edge));
  }
  for (const past of [
    { lng: 180.0001, lat: 0, zoom: 14 },
    { lng: 0, lat: -90.0001, zoom: 14 },
    { lng: 0, lat: 0, zoom: -0.0001 },
    { lng: 0, lat: 0, zoom: 22.0001 },
  ]) {
    s.setItem(V.key(7), JSON.stringify(past));
    assert.equal(V.read(s, 7), null, JSON.stringify(past));
  }
});

test("partly broken: each of the three must be a number — one missing or bad is enough to ignore it", () => {
  const s = memory();
  for (const bad of [
    { lat: 40, zoom: 14 },
    { lng: -74, zoom: 14 },
    { lng: -74, lat: 40 },
    { lng: -74, lat: null, zoom: 14 },
    { lng: -74, lat: 40, zoom: "14" },
    null,
  ]) {
    s.setItem(V.key(7), JSON.stringify(bad));
    assert.equal(V.read(s, 7), null, JSON.stringify(bad));
    V.save(s, 8, bad);
    assert.equal(s.getItem(V.key(8)), null, `not saved: ${JSON.stringify(bad)}`);
  }
});

test("no account (signed out): nothing saved, read or forgotten — even with storage working", () => {
  const s = memory();
  V.save(s, 7, { lng: -74, lat: 40.7, zoom: 14 });
  V.save(s, null, { lng: 1, lat: 1, zoom: 1 });
  V.save(s, undefined, { lng: 1, lat: 1, zoom: 1 });
  assert.equal(s.length, 1, "only account 7's");
  assert.equal(V.read(s, undefined), null);
  V.forget(s, null);
  assert.ok(V.read(s, 7), "someone else's left alone");
  V.save(null, 7, { lng: 2, lat: 2, zoom: 2 });
  assert.equal(V.read(s, 7).lng, -74, "no storage: nothing written anywhere");
});
