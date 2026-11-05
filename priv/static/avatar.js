// The photo of someone without one, or whose photo won't load (owner,
// 2026-11-01): their first initial, white on a colour of their own — the
// same name always the same colour, as Google does — or a grey silhouette
// when the name has no letter to show (an emoji, a number, nothing).
// Any alphabet's letters count: É, Д, م, 沐, 민. Never a 🙂.
// Shared by the browser (HoodAvatar) and test_js/avatar.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodAvatar = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // muted, none the app's yellow; white letters reach 4.5:1 on each
  // (WCAG AA — test_js/avatar.test.mjs checks): blue, teal, purple, red,
  // brown, slate
  const COLORS = ["#3d6bb3", "#2b7a6f", "#7b4fa8", "#b0463f", "#8a5a3c", "#4f5d75"];
  const SILHOUETTE = "#666666";

  // the first letter with its accent marks (a letter in any script), as a
  // capital — or null
  function initial(name) {
    const m = String(name ?? "")
      .trim()
      .match(/^\p{L}\p{M}*/u);
    return m ? m[0].toLocaleUpperCase() : null;
  }

  function color(name) {
    let h = 0;
    for (const ch of String(name ?? "").trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function svg(name) {
    const letter = initial(name);
    if (!letter)
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${SILHOUETTE}"/>` +
        `<circle cx="48" cy="38" r="17" fill="#bdbdbd"/><path d="M16 96c0-20 14-33 32-33s32 13 32 33z" fill="#bdbdbd"/></svg>`
      );
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${color(name)}"/>` +
      // the letter's middle on the circle's middle (48): its baseline half a
      // capital's height (~0.7 em in these fonts) below — DiceBear's and D3's
      // way. "central" centered the font's whole box (room for g, p, y) and
      // sat a capital ~5% low; browsers also differ on it (owner, 2026-11-04)
      `<text x="48" y="48" dy="0.35em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="46" font-weight="600" fill="#ffffff">${esc(letter)}</text></svg>`
    );
  }

  const url = (name) => "data:image/svg+xml," + encodeURIComponent(svg(name));

  return { COLORS, SILHOUETTE, initial, color, svg, url };
});
