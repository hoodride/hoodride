// A reconnect is a reload: the server is the truth, the app a mirror. On
// every rejoin the app rebuilds its mirror from GET /api/state (app.js
// softReload). These are the pure rules around it — what the user was in
// the middle of, what of it the server no longer has, and how to say so —
// so test_js/rehydrate.test.mjs can run them in Node.
//
// Why it matters: a server restart wipes live state (by design: nothing is
// remembered). Before, a reconnect re-synced the map but nothing else, so a
// rider kept seeing "Looking for a ride…" while no driver could see them,
// and a request waited forever for an answer that could never come.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodRehydrate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // view: {mode, handRaised, online, ride: {status} | null}
  function summarize(view) {
    const status = view.ride && view.ride.status;
    return {
      ride: status === "connected" || status === "arrived",
      request: status === "requested",
      hand: !!view.handRaised,
      shift: view.mode === "driver" && !!view.online,
    };
  }

  // what the user HAD that the rebuilt mirror doesn't (most important
  // first). Something new from the server is not a loss: the reload simply
  // shows it.
  const ORDER = ["ride", "request", "hand", "shift"];

  function lost(before, after) {
    return ORDER.filter((k) => before[k] && !after[k] && !(k === "request" && after.ride));
  }

  const MESSAGES = {
    // (not "message them": after a restart the chat is gone too)
    ride: "Connection reset — your ride ended unexpectedly, please set it up again",
    request: "Connection reset — your ride request was lost, please ask again",
    hand: "Connection reset — tap ✋ again if you still need a ride",
    shift: "Connection reset — tap GO ONLINE to drive again",
  };

  // one banner, for the most important loss (they're exclusive in practice)
  function lostBanner(lostKinds) {
    const k = ORDER.find((x) => lostKinds.includes(x));
    return k ? MESSAGES[k] : null;
  }

  // A refused ride-channel join: is the ride over? Only when the server says
  // so ("gone": it ended or the server restarted; "not_yours"). A join can
  // also be refused by the join budget ("rate_limited") — Phoenix's client
  // retries that by itself, and ending the ride then would lose a live one.
  function rideJoinLost(e) {
    const reason = e && e.reason;
    return reason === "gone" || reason === "not_yours";
  }

  // THE SNAPSHOT RULE. The mirror is rebuilt from one /api/state answer, so
  // that answer must not be older than anything the app already applied.
  // Live news that lands while it's being fetched may be newer than the
  // snapshot (a "ride_started" right then was applied, then wiped by the
  // older answer: the app forgot a live ride). So: count the live news, and
  // a snapshot something overtook is taken again — until one comes back
  // with nothing in between. No timeout to tune: the server's own message
  // limits bound how often news comes, and a fetch takes milliseconds.
  // (Same rule as the server's ride join: listen first, then snapshot.)
  async function freshState({ fetchState, liveCount }) {
    for (;;) {
      const before = liveCount();
      const st = await fetchState();
      if (liveCount() === before) return st;
    }
  }

  // live news that /api/state also covers: your own channel (chats,
  // requests, a ride starting) and your ride (its end, arrival, the pin).
  // NOT the partner's position stream (not in /api/state, ~every 1.5 s: it
  // would never let a snapshot through), replies to our own pushes, or the
  // map.
  function countsAsLive({ topic, event }) {
    if (event === "phx_reply" || event === "peer_pos") return false;
    return topic.startsWith("user:") || topic.startsWith("ride:");
  }

  return { summarize, lost, lostBanner, rideJoinLost, freshState, countsAsLive };
});
