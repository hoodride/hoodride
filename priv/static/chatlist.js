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
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // "now" | "5m" | "3h" | "2d" — a time slightly ahead (two clocks a hair
  // apart) reads "now"
  function ago(ms) {
    if (ms < MIN) return "now";
    if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
    if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
    return `${Math.floor(ms / DAY)}d`;
  }

  // the conversations, newest last message first (a copy; ties keep their
  // order)
  function newestFirst(chats) {
    return chats
      .map((c, i) => [c, i])
      .sort((x, y) => y[0].lastAt - x[0].lastAt || x[1] - y[1])
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

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  // n characters → { show, over, text }
  function limit(n) {
    const over = n > MAX_CHARS;
    return {
      show: n >= COUNT_FROM,
      over,
      text: over ? `${plural(n - MAX_CHARS, "character")} too many` : `${plural(MAX_CHARS - n, "character")} left`,
    };
  }

  return { ago, newestFirst, skew, localAt, MAX_CHARS, COUNT_FROM, count, limit };
});
