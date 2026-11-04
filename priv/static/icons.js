// The app's icons are pictures, not emoji (owner, 2026-11-01): every phone
// draws an emoji its own way, and an older one may draw a box (🧭 needs
// Android 9). The app's text keeps the emoji as a marker — "✋ Need a ride"
// — and the page shows the picture in its place (app.js setIconText). The
// car is the owner's picture; the others are Microsoft's Fluent Emoji,
// Color style (MIT — fluent-emoji.LICENSE.txt).
// Shared by the browser (HoodIcons) and test_js/icons.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodIcons = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const ICONS = {
    "\u{1F697}": "car.png",
    "✋": "hand.svg",
    "\u{1F4CD}": "pin.svg",
    "\u{1F9ED}": "compass.svg",
    "\u{1F4AC}": "chat.svg",
    // your rider in a ride, at their real spot — not the ✋ of someone nearby
    "\u{1F64B}": "person.svg",
  };

  // an icon, its colour form (U+FE0F) if any, and the space after it (the
  // picture's own margin keeps the gap)
  const ICON = /(\u{1F697}|✋|\u{1F4CD}|\u{1F9ED}|\u{1F4AC}|\u{1F64B})️? ?/gu;

  // "tap 🧭 to navigate" → ["tap ", {emoji: "🧭", src: "compass.svg"}, "to navigate"]
  function parts(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(ICON)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push({ emoji: m[1], src: ICONS[m[1]] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  return { ICONS, parts };
});
