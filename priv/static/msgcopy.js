// Tap a chat message → "Copy" under it. Shared by the browser (HoodMsgCopy)
// and test_js/msgcopy.test.mjs.
//
// Person-to-person chat apps copy from a per-message menu (Google Messages'
// floating menu, the Sendbird UI kits) rather than a button on every bubble:
// pickup chats are many short messages and copying is rare. A TAP opens
// ours, so it's as easy to find as a button; the copy runs on a real tap
// (Safari lets a page write the clipboard only inside a user gesture — a
// timer-driven long-press copy is refused); and press-and-hold stays the
// phone's own text selection, for copying part of a message.
//
// One chip at a time. The browser pieces are passed in: the clipboard (null
// on plain http), the older execCommand copy as the fallback, render(open)
// to draw or remove the chip, hasSelection() (a mouse drag-select ends in a
// click — that must not pop the chip), and the timers.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodMsgCopy = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // how long "Copied ✓" stays before the chip goes
  const COPIED_MS = 1200;

  function create({ clipboard, legacyCopy, render, hasSelection, setTimer, clearTimer }) {
    let open = null; // {key, text, label: "copy" | "copied" | "failed"}
    let timer = null;

    function stopTimer() {
      if (timer) clearTimer(timer);
      timer = null;
    }

    // returns the message it closed (Escape puts focus back there), or null
    function close() {
      stopTimer();
      if (!open) return null;
      const was = open.key;
      open = null;
      render(null);
      return was;
    }

    // key: whatever identifies the bubble (the app passes its element)
    function tap(key, text) {
      if (hasSelection()) return;
      if (open && open.key === key) return close();
      stopTimer();
      open = { key, text, label: "copy" };
      render(open);
    }

    async function write(text) {
      try {
        if (!clipboard) throw new Error("no clipboard");
        await clipboard.writeText(text);
        return true;
      } catch {
        try {
          return !!legacyCopy(text);
        } catch {
          return false;
        }
      }
    }

    function copy() {
      const target = open;
      if (!target) return Promise.resolve();
      return write(target.text).then((ok) => {
        // the chip moved or closed meanwhile: say nothing on the new one
        if (open !== target) return;
        target.label = ok ? "copied" : "failed";
        render(target);
        stopTimer();
        timer = setTimer(close, COPIED_MS);
      });
    }

    return { tap, copy, close };
  }

  // WHERE THE CHIP FLOATS. Over the chat, never in its flow: inserting it
  // pushed every later message down and back (chat apps float theirs —
  // WhatsApp beside the message, iMessage above it). In the chat's own
  // coordinates (it scrolls with its message), in this order:
  //   beside — the bubble's empty side (bubbles are ≤ 75% wide): theirs on
  //            the left → right of it; mine on the right → left of it
  //   above  — a message too wide for that, aligned to its own side
  //   below  — no room above (the chat's start would cut it off)
  // bubble: {left, top, width, height}; chip: {width, height}; width: the chat's
  const GAP = 8; // between the chip and its message
  const EDGE = 8; // kept clear at the chat's sides

  function place(bubble, chip, width, side) {
    const top = bubble.top + (bubble.height - chip.height) / 2;
    if (side === "them") {
      const left = bubble.left + bubble.width + GAP;
      if (left + chip.width <= width - EDGE) return { where: "beside", left, top };
    } else {
      const left = bubble.left - GAP - chip.width;
      if (left >= EDGE) return { where: "beside", left, top };
    }
    const left =
      side === "them"
        ? Math.min(Math.max(bubble.left, EDGE), width - EDGE - chip.width)
        : Math.max(Math.min(bubble.left + bubble.width - chip.width, width - EDGE - chip.width), EDGE);
    const above = bubble.top - GAP - chip.height;
    if (above >= 0) return { where: "above", left, top: above };
    return { where: "below", left, top: bubble.top + bubble.height + GAP };
  }

  return { create, place, COPIED_MS, GAP, EDGE };
});
