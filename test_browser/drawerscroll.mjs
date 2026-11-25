// Settings with the phone sideways (owner's iPhone, 2026-11-23: "the your
// car, navigation app, language list seems to be scrollable together but
// it's so shrunk I can barely see them — would it be better if you could
// scroll through the entire drawer?"). Measured: 844×340, the list got 48 px
// of its own scroll area between the top (77) and the bottom (183), which
// never shrank. As a navigation drawer and iOS Settings do: the whole drawer
// scrolls as one, every row full size; the ✕ stays at the top. Upright,
// where it all fits: as it was — the sign-out part at the bottom.
import { journey, step, check, BASE } from "./cdp.mjs";

const frames = (p, n = 2) =>
  p.eval(`new Promise((ok) => { let i = ${n}; const f = () => (--i <= 0 ? ok(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const facing = (p, type) =>
  p.eval(`(Object.defineProperty(screen, "orientation", { value: Object.assign(new EventTarget(), { type: ${JSON.stringify(type)}, angle: 0 }), configurable: true }), true)`);
// where things are, the drawer's scroll, and whether anything inside it
// scrolls on its own
const look = (p) =>
  p.eval(`(() => {
    const d = document.getElementById("settings-sheet");
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; };
    const inner = [...d.querySelectorAll("*")].filter((e) => { const o = getComputedStyle(e).overflowY; return (o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight + 1; }).map((e) => e.id || e.className);
    const rows = [...d.querySelectorAll(".drawer-list > .drawer-row:not(.hidden)")].map((e) => Math.round(e.getBoundingClientRect().height));
    return {
      drawer: r(d), scrolls: d.scrollHeight > d.clientHeight + 1, scrollTop: Math.round(d.scrollTop), scrollMax: d.scrollHeight - d.clientHeight,
      inner, rows, close: r(document.getElementById("settings-close")), bottom: r(d.querySelector(".drawer-bottom")), me: r(d.querySelector(".drawer-me")),
      padTop: parseFloat(getComputedStyle(d, "::before").height) || 0,
      // (its top and bottom room: spacers, not padding — WebKit 316902)
      padBottom: parseFloat(getComputedStyle(d, "::after").height) || 0,
    };
  })()`);
async function openSettings(p) {
  await p.click("btn-account");
  await p.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "Settings open");
  // (its slide in done: in place, still)
  await p.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().left) < 1`, "slid in");
}

await journey("drawerscroll: Settings sideways scrolls as one — every row full size; upright as it was", async (browser) => {
  const rita = await browser.person("BT-DrawerRita");

  step("upright: everything fits — nothing scrolls, the sign-out part at the bottom; ✕ where it is (its place: the reference)");
  await rita.phone(390, 844);
  await facing(rita, "portrait-primary");
  await rita.open();
  await openSettings(rita);
  const up = await look(rita);
  check(!up.scrolls && up.inner.length === 0, "nothing scrolls", up);
  check(Math.abs(up.bottom.bottom - (up.drawer.bottom - up.padBottom)) <= 1, "the sign-out part at the drawer's bottom", up);
  const closeAt = { top: up.close.top - up.drawer.top, end: up.drawer.right - up.close.right };
  check(closeAt.top === 12 && closeAt.end === 10, "✕ 12 px from the top, 10 from the side", closeAt);
  // (review, 2026-11-23) the ✕ takes no room: what's under it starts where
  // it always did — the drawer's padding (its ✕ pulled it all up 4 px)
  check(up.me.top - up.drawer.top === up.padTop, "you, at the drawer's padding — the ✕ takes no room", { me: up.me, padTop: up.padTop });
  // (its 12 px count from under the notch: .card-close's 8 px used to win
  // and put it in an iPhone's status bar)
  await rita.eval(`(closeSettings(), true)`);
  await rita.safeArea({ top: 47 });
  await frames(rita, 3);
  await openSettings(rita);
  const notched = await look(rita);
  check(notched.close.top - notched.drawer.top === 12 + 47, "with a notch: 12 px under it", notched.close);
  await rita.safeArea({ top: 0 });
  await frames(rita, 3);
  const rowH = up.rows[0];
  check(up.rows.length >= 2 && up.rows.every((h) => h === rowH), "(the rows, one height)", up.rows);
  await rita.eval(`(closeSettings(), true)`);

  for (const [w, h] of [[844, 390], [844, 340]]) {
    step(`sideways ${w}×${h}: the list doesn't scroll by itself, every row full size; the drawer scrolls as one`);
    await rita.phone(w, h);
    await facing(rita, "landscape-primary");
    await frames(rita, 3);
    await openSettings(rita);
    const side = await look(rita);
    check(side.inner.length === 0, "nothing inside scrolls on its own", side.inner);
    check(side.rows.every((x) => x === rowH), `every row full size (${rowH} px)`, side.rows);
    check(side.scrolls, "the drawer itself scrolls", side);

    step(`…scrolled to its end: the sign-out part in view, ✕ still at the top`);
    await rita.eval(`(() => { const d = document.getElementById("settings-sheet"); d.scrollTop = d.scrollHeight; return true; })()`);
    await frames(rita, 2);
    const end = await look(rita);
    check(end.scrollTop > 0 && end.bottom.bottom <= end.drawer.bottom, "the sign-out part on screen", end);
    // (WebKit 316902 — Safari 26.4 and later 26.x, iOS and macOS; fixed in WebKit's code
    // but not yet in every Safari: a scrolling flex column's padding left
    // out of its scroll, the last 16 px out of reach. Chrome hasn't the
    // bug: this guards that the room is a spacer — every engine counts
    // those — the whole bottom room under it at the end)
    check(end.drawer.bottom - end.bottom.bottom >= end.padBottom - 1 && end.padBottom >= 16, "…with its whole bottom room under it", end);
    check(Math.abs(end.close.top - end.drawer.top - closeAt.top) <= 1 && Math.abs(end.drawer.right - end.close.right - closeAt.end) <= 1, "✕ still in its place at the top", { closeAt, end });
    await rita.eval(`(closeSettings(), true)`);

    // (review, 2026-11-23) it kept its scroll: opened again, halfway down
    // (Chrome's focus on the name happens to scroll it back up; Firefox
    // scrolls only as little as it must — the photo cut. Played here as a
    // focus that doesn't scroll at all: the app's own reset is what's tested)
    step(`…opened again (a focus that doesn't scroll): at its top`);
    await rita.eval(`(() => { const f = HTMLElement.prototype.focus; window.__focus = f; HTMLElement.prototype.focus = function () { return f.call(this, { preventScroll: true }); }; return true; })()`);
    await openSettings(rita);
    const again = await look(rita);
    await rita.eval(`(HTMLElement.prototype.focus = window.__focus, true)`);
    check(again.scrollTop === 0, "at its top", again.scrollTop);
    await rita.eval(`(closeSettings(), true)`);
  }
  // (review, 2026-11-23) sideways, scrolled down to "Delete account": the
  // confirm opened at ITS bottom (focus on Cancel, the last thing) — the
  // question and its warning above the screen
  step("sideways, scrolled down to 'Delete account': the confirm opens at its top — the question in view");
  await openSettings(rita);
  await rita.eval(`(() => { const d = document.getElementById("settings-sheet"); d.scrollTop = d.scrollHeight; document.getElementById("btn-delete").click(); return true; })()`);
  await frames(rita, 3);
  const confirm = await rita.eval(`(() => { const d = document.getElementById("settings-sheet"); const q = d.querySelector(".drawer-confirm h2").getBoundingClientRect(); const b = d.getBoundingClientRect(); return { scrollTop: Math.round(d.scrollTop), q: Math.round(q.top), top: Math.round(b.top), confirming: d.classList.contains("confirming") }; })()`);
  check(confirm.confirming && confirm.scrollTop === 0 && confirm.q >= confirm.top, "the question on screen, at the top", confirm);
  await rita.eval(`(document.getElementById("delete-cancel").click(), closeSettings(), true)`);
  check(rita.errors.length === 0, "no page errors", rita.errors);

  // (review, 2026-11-23) right to left the drawer is on the right: the
  // notch's room was on its left (mid-screen), its text under a notch on
  // the right
  step("right to left (Arabic), sideways, a notch on the right: the drawer's content clear of it");
  const amal = await browser.person("BT-DrawerAmal");
  await amal.phone(844, 390);
  await facing(amal, "landscape-primary");
  await amal.goto(`${BASE}/privacy`);
  await amal.eval(`(document.cookie = "hoodride_lang=ar; path=/", true)`);
  await amal.open();
  check((await amal.eval(`document.documentElement.dir`)) === "rtl", "(right to left)");
  await amal.safeArea({ left: 47, right: 47 });
  await frames(amal, 3);
  await amal.click("btn-account");
  await amal.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "Settings open");
  await amal.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().right - innerWidth) < 1`, "slid in");
  const rtl = await amal.eval(`(() => { const d = document.getElementById("settings-sheet").getBoundingClientRect(); const rows = [...document.querySelectorAll("#settings-sheet .drawer-row:not(.hidden)")].map((e) => Math.round(e.getBoundingClientRect().right)); const me = Math.round(document.querySelector("#settings-sheet .drawer-me").getBoundingClientRect().right); return { W: innerWidth, rows, me, drawerLeft: Math.round(d.left) }; })()`);
  check(rtl.rows.every((r) => r <= rtl.W - 47) && rtl.me <= rtl.W - 47, "rows and your name clear of the notch on the right", rtl);
  check(amal.errors.length === 0, "no page errors", amal.errors);
});
