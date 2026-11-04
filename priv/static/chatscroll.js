// When a new message arrives, does the chat follow it? Only if you were at
// the bottom; scrolled up to reread, it stays put and app.js offers
// "↓ New message" (owner, 2026-10-29 — as iMessage, WhatsApp, Slack). Your
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
  // and a reader who never scrolled got "↓ New message" (owner's iPhone,
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

  return { SLACK_PX, atBottom, onNew, createStick };
});
