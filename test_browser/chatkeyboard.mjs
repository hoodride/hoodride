// The chat over the keyboard (owner, 2026-11-17: on an iPhone the chat was
// squished with the keyboard up; 2026-11-21: "I just want it to push up,
// the same size it had before"). Typing with the keyboard up, the chat
// keeps its height and sits right on top of the keyboard — shorter only if
// there isn't room above it; not typing, back where it was. Chrome can't
// open a phone's keyboard here, so the page is handed what phones report
// with it up — three ways (the sources disagree on iPhones): only the
// visible area shrinks (Chrome on Android, iPhones per most guides); the
// visible area AND window.innerHeight shrink (iPhones per others — the
// first fix read innerHeight, saw no keyboard there, and never ran); the
// whole page shrinks (browsers that resize the page itself).
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

const W = 390, H = 844, KB = 336; // an iPhone 14's screen and keyboard
const rect = (p) =>
  p.eval(`(() => { const r = document.getElementById("chat").getBoundingClientRect(); const m = document.getElementById("chat-messages").getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom), msgs: Math.round(m.height), kb: document.getElementById("chat").classList.contains("kb") }; })()`);
// the keyboard "up": a visual viewport `h` tall, its top `top` px down the
// page; `inner`: what window.innerHeight says then (an iPhone may say `h`)
const keyboard = (p, h, top = 0, inner = null) =>
  p.eval(`(() => {
    // (visualViewport and innerHeight are the window's own: kept once, put back as they were)
    if (!window.__vvDesc) window.__vvDesc = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const fake = Object.assign(new EventTarget(), { width: ${W}, height: ${h}, offsetTop: ${top}, offsetLeft: 0, pageTop: ${top}, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    if (!window.__innerDesc) window.__innerDesc = Object.getOwnPropertyDescriptor(window, "innerHeight");
    ${inner === null ? `Object.defineProperty(window, "innerHeight", window.__innerDesc);` : `Object.defineProperty(window, "innerHeight", { value: ${inner}, configurable: true });`}
    fitChatToKeyboard();
    return true;
  })()`);
// the phone's own visual viewport and innerHeight again
// a phone's touch screen (on-screen keyboards are a phone's or a tablet's),
// or none (a computer)
// `finger`: the main pointer a finger (a phone, a tablet) — a touch laptop
// has touch points too, but a mouse or touchpad as its main pointer
const touch = (p, n, finger = n > 0) =>
  p.eval(`(() => {
    Object.defineProperty(navigator, "maxTouchPoints", { value: ${n}, configurable: true });
    if (!window.__mm) window.__mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/pointer: *coarse/.test(q) ? { matches: ${finger}, media: q, addEventListener() {}, removeEventListener() {} } : window.__mm(q));
    return true;
  })()`);
// the screen's orientation, as the phone reports it (turned for real)
const facing = (p, type) =>
  p.eval(`(Object.defineProperty(screen, "orientation", { value: Object.assign(new EventTarget(), { type: ${JSON.stringify(type)}, angle: 0 }), configurable: true }), true)`);
const real = (p) =>
  p.eval(`(window.__vvDesc && Object.defineProperty(window, "visualViewport", window.__vvDesc), window.__innerDesc && Object.defineProperty(window, "innerHeight", window.__innerDesc), fitChatToKeyboard(), true)`);

await journey("chatkeyboard: typing with the keyboard up, the chat keeps its size, right on top of the keyboard; not typing, back where it was", async (browser) => {
  step("Rita (a phone) opens a chat with Dan's car: half the screen");
  const dan = await browser.person("BT-KbDan");
  const rita = await browser.person("BT-KbRita");
  await rita.phone(W, H);
  await touch(rita, 5);
  await facing(rita, "portrait-primary");
  const danId = await dan.id();
  await goOnline(dan);
  await sees(rita, danId);
  await openChatWith(rita, danId);
  const before = await rect(rita);
  check(!before.kb && before.bottom === H && before.h <= 420, "half the screen, at the bottom", before);

  step("she taps the text box, the keyboard comes up: the chat the same size, right on top of the keyboard");
  await rita.eval(`document.getElementById("chat-input").focus(), true`);
  await keyboard(rita, H - KB);
  const up = await rect(rita);
  check(up.kb && up.h === before.h && up.bottom === H - KB, "the same height, its bottom on the keyboard", { before, up });
  check(up.msgs === before.msgs, "the messages keep their room — not squished", { before, up });
  // (owner's iPhone, 2026-11-22: white in the bottom corners with the
  // keyboard up) on the keyboard as on the screen's bottom: rounded on top
  // only — rounded below, the map showed through beside the keyboard
  const corners = await rita.eval(`(() => { const s = getComputedStyle(document.getElementById("chat")); return { tl: s.borderTopLeftRadius, tr: s.borderTopRightRadius, bl: s.borderBottomLeftRadius, br: s.borderBottomRightRadius }; })()`);
  check(corners.bl === "0px" && corners.br === "0px" && corners.tl !== "0px" && corners.tr !== "0px", "square bottom corners on the keyboard, rounded top ones", corners);

  // (owner, 2026-11-22: "in depth google into this") the iOS 26 keyboard is
  // see-through with rounded corners, and shows the page under it — the
  // light map lit its corners white (Apple forums 801060; 1ar.io Safari 26).
  // As native sheets do (wolt_modal_sheet #395): the chat's own color
  // carried down behind the keyboard, exactly to the page's bottom
  step("behind the keyboard: the chat's own color, down to the page's bottom — never the map, never a longer page");
  const backing = (p) =>
    p.eval(`(() => { const c = document.getElementById("chat"); const s = getComputedStyle(c, "::after"); return { content: s.content, h: Math.round(parseFloat(s.height) || 0), top: Math.round(parseFloat(s.top)), bg: s.backgroundColor, card: getComputedStyle(c).backgroundColor, pageH: document.documentElement.scrollHeight }; })()`);
  const under = await backing(rita);
  check(under.content !== "none" && under.h === KB && under.top === up.h && under.bg === under.card, "the chat's color, the keyboard's whole height, right under the chat", under);
  check(under.pageH <= H, "the page no longer than the screen (nothing new to scroll)", under);
  // (review, 2026-11-22) Safari scrolls the page to the text box — and its
  // window.scrollY is the VISIBLE area's top (WebKit 170981; Chrome's is the
  // page's): read in, the color hung past the page's bottom, the page grew
  // with every drag. Safari's numbers: scrollY = the visible area's top
  const safariScrolled = async (p, top) => {
    // (the window's own scrollY: kept once, put back as it was)
    await p.eval(`(window.__scrollYDesc = window.__scrollYDesc || Object.getOwnPropertyDescriptor(window, "scrollY"), Object.defineProperty(window, "scrollY", { value: ${top}, configurable: true }), true)`);
    await keyboard(p, H - KB, top);
    const b = await backing(p);
    const r = await rect(p);
    await p.eval(`(Object.defineProperty(window, "scrollY", window.__scrollYDesc), true)`);
    // (second review, 2026-11-22) the chat's own place read scrollY too: it
    // sat `top` px above the keyboard, the map between — on the keyboard
    // (the visible area's bottom), the color from there to the page's bottom
    return { ...b, chatBottom: r.bottom, colorBottom: r.bottom + b.h };
  };
  const scrolledAll = await safariScrolled(rita, KB);
  check(scrolledAll.h === 0 && scrolledAll.pageH <= H, "Safari scrolled the text box up to the keyboard: nothing past the page's bottom", scrolledAll);
  check(scrolledAll.chatBottom === H, "…the chat on the keyboard", scrolledAll);
  const scrolledSome = await safariScrolled(rita, 120);
  check(scrolledSome.h === KB - 120 && scrolledSome.pageH <= H, "Safari scrolled 120 px: the color down to the page's bottom, no further", scrolledSome);
  check(scrolledSome.chatBottom === 120 + H - KB && scrolledSome.colorBottom === H, "…the chat on the keyboard, the color from it to the page's bottom", scrolledSome);

  // (third review, 2026-11-22) Safari scrolling the PAGE itself (100 px) and
  // the visible area 20 px more inside it: the chat on the keyboard, the
  // color down to the map's bottom — the map 30 px longer than the page's
  // measured height (iOS 26: 100dvh a few px over the layout viewport,
  // Apple forums 803987): no strip of map left under the keyboard
  step("Safari scrolls the page itself, the map a little longer than the page: the chat on the keyboard, the color to the map's bottom");
  // (fifth review, 2026-11-22) where Safari measures on-screen places from
  // is reported both ways: the page's top (WebKit 170981, 257375) and the
  // visible area's top (shyden #934, a real iPhone). Both played here —
  // `visualRects`: every on-screen place given from the visible area — and
  // the result read in the page's own places (offsetTop), which neither
  // touches
  const layoutScroll = (visualRects) =>
    rita.eval(`(() => {
      const map = document.getElementById("screen-map");
      const c = document.getElementById("chat");
      window.__scrollYDesc = window.__scrollYDesc || Object.getOwnPropertyDescriptor(window, "scrollY");
      const rects = Element.prototype.getBoundingClientRect;
      // (everything put back even if a line here throws)
      try {
        document.documentElement.style.minHeight = "${H + 200}px";
        map.style.height = "${H + 30.6}px";
        window.scrollTo(0, 100);
        // (the page's real scroll, read before scrollY is faked)
        const realScroll = Math.round(document.scrollingElement.scrollTop);
        Object.defineProperty(window, "scrollY", { value: 120, configurable: true });
        if (${visualRects}) Element.prototype.getBoundingClientRect = function () { const r = rects.call(this); return new DOMRect(r.x, r.y - 20, r.width, r.height); };
        const fake = Object.assign(new EventTarget(), { width: ${W}, height: ${H - KB}, offsetTop: 20, offsetLeft: 0, pageTop: 120, pageLeft: 0, scale: 1 });
        Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
        fitChatToKeyboard();
        const h = parseFloat(getComputedStyle(c, "::after").height) || 0;
        // (in the page: the chat's bottom, its color's, the map's)
        // (exact, not rounded: a fraction of a pixel past the map's bottom
        // is a page to scroll — sixth review, 2026-11-22)
        const chatBottom = parseFloat(c.style.top) + parseFloat(c.style.height);
        return { realScroll, chatBottom: Math.round(chatBottom), colorBottom: chatBottom + h, colorH: h, mapBottom: map.offsetTop + rects.call(map).height };
      } finally {
        Element.prototype.getBoundingClientRect = rects;
        Object.defineProperty(window, "scrollY", window.__scrollYDesc);
        map.style.height = "";
        window.scrollTo(0, 0);
        document.documentElement.style.minHeight = "";
      }
    })()`);
  for (const [visualRects, how] of [[false, "places measured from the page's top"], [true, "places measured from the visible area's top"]]) {
    const s = await layoutScroll(visualRects);
    check(s.realScroll === 100, `(${how}: the page itself really scrolled 100 px)`, s);
    check(s.chatBottom === 120 + H - KB, `${how}: the chat on the keyboard (the visible area's bottom, in the page)`, s);
    check(Math.abs(s.mapBottom - (H + 30.6)) < 0.01 && s.colorBottom <= s.mapBottom && s.colorBottom > s.mapBottom - 1 && Number.isInteger(s.colorH), `${how}: the color whole pixels, down to the map's bottom — never past it`, s);
  }
  await keyboard(rita, H - KB);

  // (WebKit 217754, open since 2020: Safari keeps the home bar's inset with
  // the keyboard up — an empty strip between the text box and the keyboard)
  step("an iPhone with a home bar (34 px): on the keyboard no empty strip under the text box; at rest it clears the home bar");
  await rita.safeArea({ bottom: 34 });
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  const pad = () => rita.eval(`getComputedStyle(document.querySelector("#chat .chat-form")).paddingBottom`);
  const typingPad = await pad();
  check(typingPad === "10px", "on the keyboard: its own 10 px only", typingPad);
  await real(rita);
  const restPad = await pad();
  const rest = await backing(rita);
  check(restPad === "44px", "at rest: clear of the home bar", restPad);
  check(rest.content === "none", "at rest: nothing under the chat", rest);
  await rita.safeArea({ bottom: 0 });

  step("an iPhone that says window.innerHeight is the visible area too: the same — the keyboard still seen");
  await keyboard(rita, H - KB, 0, H - KB);
  const iphone = await rect(rita);
  check(iphone.kb && iphone.h === before.h && iphone.bottom === H - KB, "the same height, on the keyboard", { before, iphone });

  step("Safari scrolls the page 120 px to the text box: the chat follows, on the keyboard still");
  await keyboard(rita, H - KB, 120);
  const placed = Math.round(parseFloat(await rita.eval(`document.getElementById("chat").style.top`)));
  check(Math.abs(placed - (120 + H - KB - before.h)) <= 1, "placed by the visible area's place in the page", { placed, want: 120 + H - KB - before.h });

  step("too little room above the keyboard (a small phone, turned sideways): only then shorter — just under the top");
  await keyboard(rita, 300);
  const small = await rect(rita);
  check(small.kb && small.top === 8 && small.bottom === 300 && small.h === 292, "as much as fits, on the keyboard", small);

  // (review, 2026-11-21) a sideways phone with its toolbar and keyboard up
  // can leave ~100 px: a 120 px minimum put the name and close button above
  // what's visible
  step("almost no room (100 px): as tall as what's visible — the header never off screen");
  await keyboard(rita, 100);
  const tiny = await rect(rita);
  check(tiny.kb && tiny.top >= 0 && tiny.bottom === 100, "within what's visible", tiny);

  step("a short shrink (a toolbar, not a keyboard): left as it is");
  await keyboard(rita, H - 50);
  check(!(await rect(rita)).kb, "not taken for a keyboard");

  step("a browser that shrinks the whole page for the keyboard: the chat still its own size, on the keyboard");
  await real(rita);
  check(!(await rect(rita)).kb, "(no keyboard: as it was)");
  await rita.phone(W, H - KB);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await rita.eval(`(fitChatToKeyboard(), true)`);
  const shrunk = await rect(rita);
  check(shrunk.h === before.h && shrunk.bottom === H - KB, "the same height, on the keyboard — not 48% of a smaller page", { before, shrunk });
  // (review, 2026-11-21) …and turned while typing there: re-measured with
  // the keyboard still shrinking the page — the keyboard lost, squished
  await facing(rita, "landscape-primary");
  await rita.phone(H, W - 170);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await rita.eval(`(fitChatToKeyboard(), true)`);
  const turned = await rect(rita);
  // (sideways the chat is a side sheet — chatsideways — taller than what the
  // keyboard leaves: on it, as much as fits, 8 px under the top)
  check(turned.kb && turned.bottom === W - 170 && turned.top === 8 && turned.h === W - 170 - 8, "turned sideways: lifted, as much as fits (a side sheet there)", { before, turned });
  await facing(rita, "portrait-primary");
  await rita.phone(W, H - KB);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await rita.eval(`(fitChatToKeyboard(), true)`);
  const back = await rect(rita);
  check(back.kb && Math.abs(back.h - before.h) <= 2 && back.bottom === H - KB, "turned upright again: the upright size", { before, back });
  await rita.phone(W, H);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);

  // (review, 2026-11-21) a computer's window made shorter while typing was
  // taken for a keyboard — computers have none on screen
  step("a computer (no touch screen): the window made shorter while typing is no keyboard");
  await touch(rita, 0);
  await rita.eval(`(document.getElementById("chat-input").blur(), document.getElementById("chat-input").focus(), true)`);
  await rita.phone(W, H - 300);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await rita.eval(`(fitChatToKeyboard(), true)`);
  check(!(await rect(rita)).kb, "not taken for a keyboard", await rect(rita));
  await rita.phone(W, H);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);

  // (review, 2026-11-21) a Windows touch laptop has touch points, a mouse or
  // touchpad as its main pointer: its window made shorter is no keyboard
  step("a touch laptop (touch points, a touchpad pointer): the window made shorter while typing is no keyboard");
  await touch(rita, 10, false);
  await rita.eval(`(document.getElementById("chat-input").blur(), document.getElementById("chat-input").focus(), true)`);
  await rita.phone(W, H - 300);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await rita.eval(`(fitChatToKeyboard(), true)`);
  check(!(await rect(rita)).kb, "not taken for a keyboard", await rect(rita));
  await rita.phone(W, H);
  await touch(rita, 5);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);

  // (review, 2026-11-21) narrower but not turned — an iPad's Split View, a
  // Fold folded: taken for a turn, the chat blown up from a made-up height
  step("narrower while typing but not turned (Split View, a Fold): the chat its own size, never blown up");
  await rita.eval(`(document.getElementById("chat-input").blur(), document.getElementById("chat-input").focus(), true)`);
  await keyboard(rita, H - KB);
  check((await rect(rita)).kb, "(lifted)");
  // (the page 150 px narrower, its height the same — as Split View does; an
  // emulated narrower screen zooms the page instead)
  await rita.eval(`(() => {
    if (!window.__widthDesc) window.__widthDesc = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { value: ${W - 150}, configurable: true });
    fitChatToKeyboard();
    return true;
  })()`);
  const narrow = await rect(rita);
  await rita.eval(`(Object.defineProperty(window, "innerWidth", window.__widthDesc), true)`);
  check(narrow.h <= 420 && Math.abs(narrow.h - before.h) <= 2, "its own size — not blown up", { before, narrow });
  await real(rita);

  // the text box let go, and the app's look 350 ms on (the iOS 26 nudge,
  // if any, and its step back) DONE — known, not guessed: a timer of our
  // own at 351 ms, set after the app's, fires after it (timers keep their
  // order); then the nudge's step back. (A fixed wait, or watching the
  // 50 ms nudge itself, missed it on a busy machine — precommit, 2026-11-22)
  const blurSettled = async (p) => {
    await p.eval(`(document.getElementById("chat-input").blur(), window.__looked = false, setTimeout(() => { window.__looked = true; }, 351), true)`);
    await p.waitFor(`window.__looked && !nudging`, "the look after the keyboard done");
  };

  // (review, 2026-11-21) tapped sideways, then turned upright with the
  // keyboard up: the chat kept its sideways height — squished again
  step("tapped with the phone sideways, turned upright with the keyboard still up: the upright size, not the sideways one");
  await blurSettled(rita);
  await rita.waitFor(`!document.getElementById("chat").classList.contains("kb")`, "back");
  await facing(rita, "landscape-primary");
  await rita.phone(H, W);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await rita.eval(`document.getElementById("chat-input").focus(), true`);
  await keyboard(rita, W - 170);
  const sideways = await rect(rita);
  check(sideways.kb, "(sideways: lifted)", sideways);
  await real(rita);
  await facing(rita, "portrait-primary");
  await rita.phone(W, H);
  await rita.eval(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))`);
  await keyboard(rita, H - KB);
  const upright = await rect(rita);
  check(upright.kb && upright.h === before.h && upright.bottom === H - KB, "upright: its upright height, on the keyboard", { before, sideways, upright });

  step("the keyboard up again, then she taps away: back where it was — a leftover keyboard area ignored");
  await keyboard(rita, H - KB, 24);
  check((await rect(rita)).kb, "lifted");
  // (precommit, 2026-11-21) the leftover area makes the iOS 26 nudge run
  // 350 ms on — the page 1 px down for 50 ms: measured in that moment it
  // read 1 px off. Measured once it's done, as a person would see it
  await blurSettled(rita);
  await rita.waitFor(`!document.getElementById("chat").classList.contains("kb")`, "back");
  const after = await rect(rita);
  await real(rita);
  check(after.bottom === H && after.h === before.h && after.top === before.top, "exactly as before", { before, after });

  // (owner, 2026-11-21: "fix it according to what online says works")
  // iOS 26: after the keyboard closes the visible area can stay offset, or
  // short with its offset back at 0 (Apple forums 800154, 800125; WebKit
  // 297779, 300523). What's reported to work on real iPhones: scrolling the
  // page 1 px and back, so iOS measures again (Sedna.UI #172; glazelab #6)
  // — but this page is exactly the screen's height, nothing to scroll: the
  // nudge was clamped to nothing. It gets 1 px to scroll for that moment
  const nudgeWatch = (p) =>
    p.eval(`(() => {
      window.__nudge = [];
      window.__nudgeAt = [];
      if (!window.__scrollTo) window.__scrollTo = window.scrollTo.bind(window);
      window.scrollTo = (x, y) => { window.__scrollTo(x, y); window.__nudge.push(Math.round(window.scrollY)); window.__nudgeAt.push(performance.now()); };
      return true;
    })()`);
  const afterClose = async (p, h, top, scale = 1) => {
    // (every earlier blur waited out — blurSettled: no timer of its left)
    await p.eval(`document.getElementById("chat-input").focus(), true`);
    await keyboard(p, h, top);
    await p.eval(`(window.visualViewport.scale = ${scale}, true)`);
    await nudgeWatch(p);
    await blurSettled(p);
    const seen = await p.eval(`window.__nudge`);
    // (review, 2026-11-21 — WebKit ScrollingStateScrollingNode:
    // mergeOrAppendScrollRequest) down and straight back in one go reach
    // iOS as one "stay put": the back must come later (~50 ms, as
    // glazelab #6 and Sedna.UI f5fa53c do)
    const at = await p.eval(`window.__nudgeAt`);
    const apart = at.length === 2 ? Math.round(at[1] - at[0]) : null;
    const end = await p.eval(`({ y: Math.round(window.scrollY), minH: document.documentElement.style.minHeight })`);
    await real(p);
    return { seen, end, apart };
  };
  step("iOS 26, the keyboard closed, the visible area left OFFSET 24 px: the page really scrolled 1 px and back");
  const offset = await afterClose(rita, H - 24, 24);
  check(offset.seen.join() === "1,0" && offset.end.y === 0 && offset.end.minH === "", "scrolled 1 px down, then back — the page as it was", offset);
  check(offset.apart >= 40, "back a moment later — not merged into one by iOS", offset);

  step("…left SHORT 24 px with its offset back at 0: the same");
  const short = await afterClose(rita, H - 24, 0);
  check(short.seen.join() === "1,0" && short.end.y === 0 && short.end.minH === "", "scrolled 1 px down, then back — the page as it was", short);
  check(short.apart >= 40, "back a moment later — not merged into one by iOS", short);

  step("pinched in (zoomed): left alone — the visible area is smaller on purpose");
  const zoomed = await afterClose(rita, H / 2, 0, 2);
  check(zoomed.seen.length === 0, "no nudge while zoomed", zoomed);

  step("nothing left wrong after the keyboard: left alone");
  const fine = await afterClose(rita, H, 0);
  check(fine.seen.length === 0, "no nudge", fine);
  check(rita.errors.length === 0, "no page errors", rita.errors);
});
