// How server data merges into what the app holds — pure rules, no DOM or
// map, so test_js/browse.test.mjs runs them in Node (app.js only wires
// them up: the "Humble Object" split, as in sync.js and viewport.js).
//
// A FULL SNAPSHOT REPLACES ITS CELL; a live update only patches. The app
// removes a marker only on a *_left event, so anything that left while we
// couldn't hear it (a reconnect, a role switch) stayed forever as a ghost.
// The snapshot for a cell is the whole truth for that cell: whatever we
// hold there that it doesn't list is gone.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodBrowse = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t } = I18n;
  // entries: Map id → {type: "driver" | "hand" | "ridepeer", cell}
  // snaps:   [{cell, drivers?: [{id}], hands?: [{id}]}] — a layer the
  //          snapshot doesn't carry counts as empty (a one-sided snapshot
  //          after a role change clears the other layer too)
  // → the ids to remove. The ride partner is never touched: it isn't a
  //   map marker and no snapshot speaks for it.
  function staleInSnapshot(entries, snaps) {
    const listed = new Map(); // cell → Set of ids the snapshot lists
    for (const s of snaps) {
      const ids = new Set();
      (s.drivers || []).forEach((d) => ids.add(d.id));
      (s.hands || []).forEach((h) => ids.add(h.id));
      listed.set(s.cell, ids);
    }
    const stale = [];
    entries.forEach((e, id) => {
      if (e.type === "ridepeer") return;
      const ids = listed.get(e.cell);
      if (ids && !ids.has(id)) stale.push(id);
    });
    return stale;
  }

  // An empty chat the app may drop: one opened from a card and never sent
  // (it exists only here). A chat the server holds — a ride's, which
  // exists from ride start even if nobody types — stays, so a silent ride's
  // partner is still in the inbox afterwards.
  // chat: {msgs, server}; isRidePeer: the chat is with the current ride's partner
  function chatPrunable(chat, isRidePeer) {
    // something typed and not sent (a draft) keeps it too, as WhatsApp's
    // "Draft" (owner, 2026-11-07)
    return !chat.msgs.length && !chat.server && !isRidePeer && !(chat.draft || "").trim();
  }

  // The server deleted a conversation (one of the two was gone past grace):
  // drop it, close it if it's on screen, and say plainly why — only if this
  // app still had it (after a reload it's simply not there).
  function chatClosedActions({ hasChat, isOpen, name }) {
    if (!hasChat) return { remove: false, close: false, banner: null };
    return {
      remove: true,
      close: !!isOpen,
      banner: t("Chat with {name} ended — they've been away a while", { name }),
    };
  }

  // PILES. Fuzzed markers in one block sit on EXACTLY the same point, so
  // they'd stack with only the top one tappable — and zooming never
  // separates identical points. One marker per (type, spot) instead; a tap
  // on a pile opens a list (research: lists beat tiny fanned-out pins on
  // phones, and bare numbered bubbles confuse people). The ride partner is
  // its own marker, never piled.
  // entries: Map id → {type, spot} → [{key, type, spot, ids}] in entry order
  function groupMarkers(entries) {
    const groups = new Map();
    entries.forEach((e, id) => {
      if (e.type === "ridepeer") return;
      const key = `${e.type}:${e.spot}`;
      if (!groups.has(key)) groups.set(key, { key, type: e.type, spot: e.spot, ids: [] });
      groups.get(key).ids.push(id);
    });
    return [...groups.values()];
  }

  // a visible pile, not an abstract number: up to three icons, then +N
  function pileLook(n) {
    return { icons: Math.min(n, 3), more: Math.max(0, n - 3) };
  }

  // names arrive only by `reveal` (or a message/request); ask only once
  function needsReveal(peer) {
    return !peer.name || peer.name === "…";
  }

  // the server speaks a different wire protocol than this (cached) app:
  // offer a reload. A server that doesn't say (older) never nags.
  function versionMismatch(serverV, appV) {
    return serverV !== undefined && serverV !== null && serverV !== appV;
  }

  // The demo, zoomed out (owner, 2026-11-02): its pretend people counted
  // per hexagon at the ladder's res, in the server's shape — {cell, drivers,
  // hands} — so the real hexagon layer draws them by the real rules (who
  // sees which side: app.js renderAggLayer). Only the watched (on-screen)
  // hexagons, never an empty one.
  // people: [{kind: "driver" | "hand", pos: {lat, lng} | null}]
  function demoCounts(h3, people, res, watched) {
    const byCell = new Map();
    for (const p of people) {
      if (!p.pos) continue;
      const cell = h3.latLngToCell(p.pos.lat, p.pos.lng, res);
      if (!watched.has(cell)) continue;
      const c = byCell.get(cell) || { cell, drivers: 0, hands: 0 };
      if (p.kind === "driver") c.drivers++;
      else if (p.kind === "hand") c.hands++;
      byCell.set(cell, c);
    }
    return [...byCell.values()].filter((c) => c.drivers + c.hands > 0);
  }

  return {
    staleInSnapshot,
    chatPrunable,
    chatClosedActions,
    demoCounts,
    groupMarkers,
    pileLook,
    needsReveal,
    versionMismatch,
  };
});
