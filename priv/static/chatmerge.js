// Light reload (owner, 2026-11-08) — shared by the browser (HoodChatMerge)
// and test_js/chatmerge.test.mjs. A reload brings each chat as a summary;
// a chat's messages come when it's opened (GET /api/chat). While they load,
// what arrives is held in the chat (live messages, and this app's own notes
// like "📩 requested a ride", which the server never has). When the answer
// comes, the two are put together here.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodChatMerge = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // reply: the server's messages, oldest first. held: what arrived while
  // loading, in arrival order — messages with their server id, and notes
  // (id null) with `after`: the newest id known when they came (null: none).
  //
  // 1. The server's messages.
  // 2. Then each held message newer than the answer's newest. One not
  //    newer is in the answer already, or the server trimmed it (ids are
  //    stored in order, and only the partner can send while a chat loads —
  //    Send waits): either way, not added again.
  // 3. Then each note right after the message it came after — after any
  //    note already placed there, so they keep their order. One with
  //    nothing before it, or after a message that's gone: at the end.
  //
  // The same objects come back (a bubble is found by its message); the two
  // lists given are left as they were.
  function merge(reply, held) {
    const newest = reply.reduce((n, m) => Math.max(n, m.id), -Infinity);
    const result = reply.slice();
    held.forEach((m) => {
      if (m.id != null && m.id > newest) result.push(m);
    });
    held.forEach((n) => {
      if (n.id != null) return;
      let i = n.after == null ? -1 : result.findIndex((m) => m.id === n.after);
      if (i < 0) return result.push(n);
      while (i + 1 < result.length && result[i + 1].id == null && result[i + 1].after === n.after) i++;
      result.splice(i + 1, 0, n);
    });
    return result;
  }

  return { merge };
});
