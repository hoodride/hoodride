// The chat list — shared by the browser (HoodChatList) and
// test_js/chatlist.test.mjs. ARCHITECTURE.md "Chat list".
//
// Like chat apps do (Messenger, Instagram, WhatsApp): the conversation with
// the newest message on top, unread ones bold (app.js), and how long ago
// its last message came — "now", "2m", "1h" — redrawn as time passes.
// Relative, not a clock time: Hood Ride's chats are short-lived.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodChatList = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t, tn } = I18n;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // "now" | "5m" | "3h" | "2d" — a time slightly ahead (two clocks a hair
  // apart) reads "now"
  function ago(ms) {
    if (ms < MIN) return t("now");
    if (ms < HOUR) return t("{n}m", { n: Math.floor(ms / MIN) });
    if (ms < DAY) return t("{n}h", { n: Math.floor(ms / HOUR) });
    return t("{n}d", { n: Math.floor(ms / DAY) });
  }

  // the conversations, newest last message first (a copy). Server times are
  // whole seconds, so two last messages in the same second tie: the later
  // one has the higher server id (lastId; owner, 2026-11-07 — after a reload
  // the older chat could sit on top). Still tied: the given order
  function newestFirst(chats) {
    const id = (c) => (typeof c.lastId === "number" ? c.lastId : -1);
    return chats
      .map((c, i) => [c, i])
      .sort((x, y) => y[0].lastAt - x[0].lastAt || id(y[0]) - id(x[0]) || x[1] - y[1])
      .map(([c]) => c);
  }

  // how far the server's clock is ahead of this phone's (ms): the server's
  // time when the phone read `phoneNow`. Unknown: 0 (trust the phone).
  function skew(serverNowMs, phoneNow) {
    return typeof serverNowMs === "number" ? serverNowMs - phoneNow : 0;
  }

  // a server timestamp (seconds) on this phone's clock (ms)
  function localAt(serverSeconds, skewMs) {
    return serverSeconds * 1000 - skewMs;
  }

  // ── the message box's limit (2026-10-29). Counted as people see
  // characters (👨‍👩‍👧‍👦 is one — the browser's maxlength counted 11), and a
  // WARNING, never a cut: GOV.UK and the Scottish Government design systems
  // ("non-destructive… a warning instead of losing any of it"). The counter
  // shows from 80% (GOV.UK's threshold option). The server's own limits
  // (UserChannel) are looser on purpose: phones and server can run
  // different Unicode versions, which count some conjuncts differently.
  const MAX_CHARS = 500;
  const COUNT_FROM = 400;

  let splitter = null; // { Seg, s }: made once, not per keystroke

  // Seg: Intl.Segmenter, or null for browsers without it (before 2021;
  // tests pass null) — then code points: a glued emoji counts as its
  // pieces, stricter, never looser
  function count(text, Seg = typeof Intl !== "undefined" ? Intl.Segmenter : null) {
    if (!Seg) return [...text].length;
    if (!splitter || splitter.Seg !== Seg) splitter = { Seg, s: new Seg(undefined, { granularity: "grapheme" }) };
    return [...splitter.s.segment(text)].length;
  }

  // n characters → { show, over, text }
  function limit(n) {
    const over = n > MAX_CHARS;
    return {
      show: n >= COUNT_FROM,
      over,
      text: over
        ? tn("{count} character too many", "{count} characters too many", n - MAX_CHARS)
        : tn("{count} character left", "{count} characters left", MAX_CHARS - n),
    };
  }

  // an unread count on a badge: the number, "99+" past 99 (the common
  // badge cap: Material-style badges, Siemens iX)
  function unreadLabel(n) {
    return n > 99 ? "99+" : String(n);
  }

  // a chat's line in the list: what you typed and didn't send over its last
  // message — shown after "Draft", as WhatsApp (owner, 2026-11-07)
  function preview(chat) {
    const draft = (chat.draft || "").trim();
    if (draft) return { draft: true, text: draft };
    const last = chat.msgs[chat.msgs.length - 1];
    return { draft: false, text: last ? last.text : "" };
  }

  // a rebuild (a reconnect, reopening the app) starts the chats over from
  // the server: what it doesn't hold comes back from here — every draft,
  // and, while the chat window is open, the chats nothing was sent in yet
  // (✕ drops those anyway). held: [{id, server, msgs, draft}]
  function carried(held, panelOpen) {
    return held
      .filter((c) => (c.draft || "").trim() || (panelOpen && !c.server && !c.msgs.length))
      .map((c) => ({ id: c.id, draft: c.draft || "" }));
  }

  return { ago, newestFirst, skew, localAt, MAX_CHARS, COUNT_FROM, count, limit, unreadLabel, preview, carried };
});
