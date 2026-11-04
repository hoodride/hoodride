// Node tests for priv/static/browse.js — how a map snapshot merges into the
// markers the app already holds. A full snapshot REPLACES its cell; a live
// update only patches. (Before: snapshots only added, so a car that left
// while the app was disconnected stayed on the map as a ghost.)
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = require("../priv/static/browse.js");

// the app's marker store: id → {type, cell}
const entries = (rows) => new Map(rows.map(([id, type, cell]) => [id, { type, cell }]));

test("THE GHOST REPRO: a car that left while disconnected is removed by the next snapshot", () => {
  // Maria (7) was in cell A; she left while we were offline (her
  // driver_left was lost). The reconnect snapshot for A doesn't list her.
  const held = entries([[7, "driver", "A"]]);
  const stale = B.staleInSnapshot(held, [{ cell: "A", drivers: [], hands: [] }]);
  assert.deepEqual(stale, [7]);
});

test("everything still listed stays; other cells are untouched", () => {
  const held = entries([
    [1, "driver", "A"],
    [2, "hand", "A"],
    [3, "driver", "B"], // B isn't in this snapshot: not ours to judge
  ]);
  const stale = B.staleInSnapshot(held, [{ cell: "A", drivers: [{ id: 1 }], hands: [{ id: 2 }] }]);
  assert.deepEqual(stale, []);
});

test("a one-sided snapshot (the role changed) also clears the other layer in that cell", () => {
  // we were a rider (cars), now an online driver: the snapshot has no
  // drivers key at all, so the old cars in A must go
  const held = entries([
    [1, "driver", "A"],
    [2, "hand", "A"],
  ]);
  const stale = B.staleInSnapshot(held, [{ cell: "A", hands: [{ id: 2 }] }]);
  assert.deepEqual(stale, [1]);
});

test("the ride partner's marker is never removed by a snapshot", () => {
  const held = entries([[9, "ridepeer", "A"]]);
  assert.deepEqual(B.staleInSnapshot(held, [{ cell: "A", drivers: [], hands: [] }]), []);
});

test("several snapshot cells at once, each judged on its own list", () => {
  const held = entries([
    [1, "driver", "A"],
    [2, "driver", "B"],
    [3, "hand", "B"],
  ]);
  const stale = B.staleInSnapshot(held, [
    { cell: "A", drivers: [{ id: 1 }] },
    { cell: "B", drivers: [], hands: [{ id: 3 }] },
  ]);
  assert.deepEqual(stale, [2]);
});

// ---- chats: which empty chats the app may drop ----

test("a local-only empty chat (opened from a card, never sent) is dropped", () => {
  assert.equal(B.chatPrunable({ msgs: [], server: false }, false), true);
});

test("a server-backed empty chat (a silent ride) is KEPT after the ride ends", () => {
  assert.equal(B.chatPrunable({ msgs: [], server: true }, false), false);
});

test("a chat with messages, or with the current ride partner, is kept", () => {
  assert.equal(B.chatPrunable({ msgs: [{ text: "hi" }], server: false }, false), false);
  assert.equal(B.chatPrunable({ msgs: [], server: false }, true), false);
});

// ---- chat_closed: the server deleted a conversation ----

test("chat_closed for a chat I have: remove it, and say why", () => {
  const a = B.chatClosedActions({ hasChat: true, isOpen: false, name: "Maria" });
  assert.equal(a.remove, true);
  assert.equal(a.close, false);
  assert.equal(a.banner, "Chat with Maria ended — they've been away a while");
});

test("chat_closed for the chat on screen: also close the panel", () => {
  const a = B.chatClosedActions({ hasChat: true, isOpen: true, name: "Maria" });
  assert.deepEqual([a.remove, a.close], [true, true]);
  assert.match(a.banner, /Maria/);
});

test("chat_closed for a chat I don't have (a reload already dropped it): nothing at all", () => {
  assert.deepEqual(B.chatClosedActions({ hasChat: false, isOpen: false, name: "Maria" }), {
    remove: false,
    close: false,
    banner: null,
  });
});

// ---- the demo, zoomed out: its pretend people counted per hexagon ----
// (owner, 2026-11-02: the demo showed every car at every zoom; the real app
// turns them into counted hexagons, then "Zoom in to see who's around")
const h3 = require("../priv/static/h3-js.umd.js");
const HOME = { lat: 40.7154, lng: -74.0086 };
const near = (dLat, dLng) => ({ lat: HOME.lat + dLat, lng: HOME.lng + dLng });

test("demo counts: cars and hands per hexagon, in the server's {cell, drivers, hands} shape", () => {
  const res = 7;
  const here = h3.latLngToCell(HOME.lat, HOME.lng, res);
  const people = [
    { kind: "driver", pos: near(0, 0) },
    { kind: "driver", pos: near(0.0004, 0.0004) },
    { kind: "hand", pos: near(-0.0003, 0.0002) },
  ];
  const counts = B.demoCounts(h3, people, res, new Set([here]));
  assert.deepEqual(counts, [{ cell: here, drivers: 2, hands: 1 }]);
});

test("demo counts: two hexagons apart, each counted on its own", () => {
  const res = 7;
  const a = { kind: "driver", pos: near(0, 0) };
  const b = { kind: "driver", pos: near(0.2, 0.2) }; // ~25 km away: another hexagon
  const ca = h3.latLngToCell(a.pos.lat, a.pos.lng, res);
  const cb = h3.latLngToCell(b.pos.lat, b.pos.lng, res);
  assert.notEqual(ca, cb);
  const counts = B.demoCounts(h3, [a, b], res, new Set([ca, cb]));
  assert.deepEqual(
    counts.sort((x, y) => (x.cell < y.cell ? -1 : 1)),
    [{ cell: ca, drivers: 1, hands: 0 }, { cell: cb, drivers: 1, hands: 0 }].sort((x, y) => (x.cell < y.cell ? -1 : 1))
  );
});

test("demo counts: only the hexagons being watched (the screen's), never an empty one", () => {
  const res = 5;
  const here = h3.latLngToCell(HOME.lat, HOME.lng, res);
  const people = [{ kind: "driver", pos: near(0, 0) }];
  assert.deepEqual(B.demoCounts(h3, people, res, new Set()), [], "off screen: not drawn");
  assert.deepEqual(B.demoCounts(h3, [], res, new Set([here])), [], "nobody: no hexagon (never a 0)");
});

test("demo counts: someone without a position isn't counted", () => {
  const res = 7;
  const here = h3.latLngToCell(HOME.lat, HOME.lng, res);
  const counts = B.demoCounts(h3, [{ kind: "driver", pos: null }, { kind: "driver", pos: near(0, 0) }], res, new Set([here]));
  assert.deepEqual(counts, [{ cell: here, drivers: 1, hands: 0 }]);
});
