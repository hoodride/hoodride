// When a new message arrives, does the chat follow it? Only if you were at
// the bottom; scrolled up to reread, it stays put and app.js offers
// the ↓ button, with a count (owner, 2026-10-29 — as iMessage, WhatsApp, Slack). Your
// own message always follows: you just sent it. Shared by the browser
// (HoodChatScroll) and test_js/chatscroll.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodChatScroll = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // "at the bottom" within about one message's height: a small nudge of
  // the finger isn't reading history
  const SLACK_PX = 60;

  // el: {scrollTop, scrollHeight, clientHeight} (the messages box)
  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK_PX;
  }

  // → "follow" (scroll to it) | "offer" (hold; show the button)
  function onNew({ mine, wasAtBottom }) {
    return mine || wasAtBottom ? "follow" : "offer";
  }

  // "Stuck to the bottom", REMEMBERED rather than measured when a message
  // comes: the keyboard opening moved the list (browser scroll anchoring —
  // Safari 27 has it, Chrome/Firefox long have — and/or the area shrinking)
  // and a reader who never scrolled got the ↓ button (owner's iPhone,
  // 2026-10-29). Rules as use-stick-to-bottom: only an UPWARD scroll that
  // isn't the app's own and isn't caused by a resize unsticks; scrolling back
  // near the bottom re-sticks; a resize keeps a stuck reader at the bottom.
  function createStick() {
    let stuck = true;
    let lastTop = 0; // where the list was last (yours or the app's doing)
    let resizing = false;
    return {
      get stuck() {
        return stuck;
      },
      set stuck(v) {
        stuck = v;
      },
      // the app scrolled it here (top as the browser clamped it): the new
      // starting point, so the app's own move never reads as yours
      ownScroll(top) {
        lastTop = top;
      },
      // el: the messages box, on its scroll event
      onScroll(el) {
        const top = el.scrollTop;
        if (resizing) {
          lastTop = top;
          return;
        }
        if (top < lastTop) stuck = false;
        else if (atBottom(el)) stuck = true;
        lastTop = top;
      },
      // the box or the visible area changed size → true: keep at the bottom
      resizeStarted() {
        resizing = true;
        return stuck;
      },
      resizeDone() {
        resizing = false;
      },
    };
  }

  // ── opening a chat with unread messages (owner, 2026-11-05 — as Telegram,
  // Slack, Discord): more than fit on screen → open at the first of them,
  // a "New messages" line just above; a few → at the newest, as before

  // the first unread message's place: `unread` of THEIR messages are new
  // (yours are never unread) → its index in msgs, or -1
  function firstUnread(msgs, unread) {
    if (!(unread > 0)) return -1;
    let seen = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i].mine && ++seen === unread) return i;
    }
    return -1;
  }

  // a little room above the line, so it doesn't sit flush on the edge
  const LINE_GAP = 8;

  // lineTop: the "New messages" line's top within the list (null: none)
  // → a scrollTop that shows it near the top, or "bottom"
  function openAt({ lineTop, scrollHeight, clientHeight }) {
    if (lineTop == null) return "bottom";
    if (scrollHeight - lineTop <= clientHeight) return "bottom";
    return Math.max(0, lineTop - LINE_GAP);
  }

  // ── the ↓ button (owner, 2026-11-05): shown whenever you're scrolled up;
  // a badge counts the messages that came in below you (as Telegram and
  // WhatsApp), big counts shortened like the ‹ count
  function jump({ stuck, below }) {
    if (stuck) return { show: false, badge: null };
    return { show: true, badge: below > 0 ? (below > 99 ? "99+" : String(below)) : null };
  }

  return { SLACK_PX, LINE_GAP, atBottom, onNew, createStick, firstUnread, openAt, jump };
});
