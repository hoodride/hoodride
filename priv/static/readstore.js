// Which messages you've read, remembered on this device per account, so
// messages that came while you were disconnected or the app was closed show
// as unread (owner, 2026-10-30). Shared by the browser (HoodReadStore) and
// test_js/readstore.test.mjs.
//
// The server keeps messages but not what you've read; this device keeps a
// bookmark per chat: the other person's id → [time, id] of the newest of
// THEIR messages you've seen. The time is the server's (Unix seconds), never
// this phone's clock; the server's message id settles two in the same
// second. No names, no text. Like the map area (viewstore.js) it's cleared
// on every sign-out — the privacy page says "Signing out removes them" —
// and storage can be blocked: then nothing is remembered, nothing breaks.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodReadStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PREFIX = "hoodride_read_";

  function key(userId) {
    return `${PREFIX}${userId}`;
  }

  const isMark = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

  // only {digits: [number, number]}: anything else is dropped
  function clean(note) {
    const out = {};
    if (!note || typeof note !== "object" || Array.isArray(note)) return out;
    for (const [k, v] of Object.entries(note)) if (/^\d+$/.test(k) && isMark(v)) out[k] = [v[0], v[1]];
    return out;
  }

  // a message {ts, id} after the bookmark [ts, id]?
  function newer(m, mark) {
    return m.ts > mark[0] || (m.ts === mark[0] && m.id > mark[1]);
  }

  function newest(theirs) {
    let best = null;
    for (const m of theirs) if (!best || newer(m, best)) best = [m.ts, m.id];
    return best;
  }

  // The rebuild: the note (null: none yet — the first run), the chats the
  // server has ({peerId, theirs: [{ts, id}]}), and the one on screen (read).
  // → {unread: {peerId: n}, note} — the note keeps only chats that exist.
  // A chat without a bookmark (new while you were away) is all unread and
  // gets one only when opened; on the first run everything there is read.
  function reconcile(note, convs, viewing) {
    const unread = {};
    const out = {};
    for (const { peerId, theirs } of convs) {
      const mark = note ? note[peerId] : null;
      const top = newest(theirs);
      if (!note || peerId === viewing) {
        unread[peerId] = 0;
        if (top || mark) out[peerId] = top && (!mark || newer({ ts: top[0], id: top[1] }, mark)) ? top : mark;
      } else if (mark) {
        unread[peerId] = theirs.filter((m) => newer(m, mark)).length;
        out[peerId] = mark;
      } else {
        unread[peerId] = theirs.length;
      }
    }
    return { unread, note: out };
  }

  // the chat was seen: its bookmark moves to the newest of theirs, never
  // back. A new note; the old one is untouched.
  function seen(note, peerId, theirs) {
    const top = newest(theirs);
    const mark = note[peerId];
    if (!top || (mark && !newer({ ts: top[0], id: top[1] }, mark))) return { ...note };
    return { ...note, [peerId]: top };
  }

  // the note, or null (none yet, unreadable, or storage blocked)
  function read(storage, userId) {
    if (!storage || userId == null) return null;
    try {
      const raw = storage.getItem(key(userId));
      if (raw == null) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      return clean(v);
    } catch (_) {
      return null;
    }
  }

  function save(storage, userId, note) {
    if (!storage || userId == null) return;
    try {
      storage.setItem(key(userId), JSON.stringify(clean(note)));
    } catch (_) {}
  }

  function forget(storage, userId) {
    if (!storage || userId == null) return;
    try {
      storage.removeItem(key(userId));
    } catch (_) {}
  }

  // every account's on this device
  function forgetAll(storage) {
    if (!storage) return;
    try {
      const mine = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(PREFIX)) mine.push(k);
      }
      mine.forEach((k) => storage.removeItem(k));
    } catch (_) {}
  }

  return { key, newer, reconcile, seen, read, save, forget, forgetAll };
});
