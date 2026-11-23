// The chat with the phone sideways (owner's iPhone, 2026-11-22: "I change to
// side and the chat is squished, can't see text"). Upright it's a sheet at
// the bottom; sideways — a short, wide screen — a bottom sheet left the
// messages ~30 px. Material (2's sheets guidance): in landscape a bottom sheet becomes a SIDE
// sheet. So, sideways: the chat on the start side (left; right in right to
// left), from under the top bar (which stays whole and tappable) to the
// bottom; the banner, the bottom buttons and "center on me" in the map
// beside it (the map's padding, as map apps do: Google Maps SDK setPadding);
// typing there, a slim name bar. Upright again: as it was.
import { journey, step, check, BASE } from "./cdp.mjs";
import { goOnline, sees, openChatWith, holdAnswers, letAnswersGo } from "./app.mjs";

const UP = { w: 390, h: 844 }; // an iPhone 14, upright
const SIDE = { w: 844, h: 390 }; // …sideways

const frames = (p, n = 2) =>
  p.eval(`new Promise((ok) => { let i = ${n}; const f = () => (--i <= 0 ? ok(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const facing = (p, type) =>
  p.eval(`(Object.defineProperty(screen, "orientation", { value: Object.assign(new EventTarget(), { type: ${JSON.stringify(type)}, angle: 0 }), configurable: true }), true)`);
// turned: the screen's size and which way it faces, then settled (the map
// resized, the layout and the banner fitted again)
async function turn(p, { w, h }) {
  await facing(p, w > h ? "landscape-primary" : "portrait-primary");
  await p.phone(w, h);
  await frames(p, 4);
  await p.waitFor(`!map.isMoving()`, "the map still");
  await frames(p, 3);
}
// where things are on screen (rounded px)
const layout = (p) =>
  p.eval(`(() => {
    const r = (el) => { if (!el || el.closest(".hidden")) return null; const b = el.getBoundingClientRect(); return b.width && b.height ? { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } : null; };
    const $ = (id) => document.getElementById(id);
    const pad = map.getPadding();
    const tappable = (id) => { const b = $(id).getBoundingClientRect(); const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!at && $(id).contains(at); };
    return {
      W: innerWidth, H: innerHeight,
      chat: r($("chat")), msgs: r($("chat-messages")), header: r(document.querySelector("#chat .chat-header")),
      topbar: r(document.querySelector(".topbar")),
      banner: r($("banner")),
      buttons: [...document.querySelectorAll("#bottom-controls > *")].map(r).filter(Boolean),
      pad: { left: Math.round(pad.left), right: Math.round(pad.right), top: Math.round(pad.top), bottom: Math.round(pad.bottom) },
      accountTappable: tappable("btn-account"), modeTappable: tappable("btn-mode"),
      links: !!r(document.querySelector("#chat .chat-links")), dist: !!r($("chat-dist")),
    };
  })()`);
// the banner shown and fitted
async function banner(p, text) {
  await p.eval(`(setBanner(${JSON.stringify(text)}), true)`);
  await p.waitFor(`!document.getElementById("banner").classList.contains("fitting") && !document.getElementById("banner").classList.contains("hidden")`, "the banner fitted");
  await frames(p, 2);
}
// a place on the map, on screen (its pixel) — to tell if the map moved
const pixelOf = (p, ll) => p.eval(`(() => { const q = map.project(${JSON.stringify(ll)}); return { x: Math.round(q.x), y: Math.round(q.y) }; })()`);

await journey("chatsideways: sideways the chat is a side sheet — room to read; the banner, buttons and map beside it", async (browser) => {
  step("Rita (a phone, upright) opens a chat with Dan's car: the sheet at the bottom, as always");
  const dan = await browser.person("BT-SideDan");
  const rita = await browser.person("BT-SideRita");
  await rita.phone(UP.w, UP.h);
  await facing(rita, "portrait-primary");
  const danId = await dan.id();
  await goOnline(dan);
  await sees(rita, danId);
  await openChatWith(rita, danId);
  const up = await layout(rita);
  check(up.chat.left === 0 && up.chat.right === UP.w && up.chat.bottom === UP.h, "upright: across the bottom", up.chat);
  check(up.pad.left === 0 && up.pad.right === 0, "upright: the map not padded", up.pad);

  step("she turns the phone sideways: the chat on the left, from under the top bar to the bottom — room for the messages");
  const ll = await rita.eval(`(() => { const c = map.unproject([innerWidth * 0.75, innerHeight * 0.4]); return [c.lng, c.lat]; })()`);
  // (review, 2026-11-22) what you were looking at: the place in the middle —
  // turned, the map jumped (padded against its old size, mid-turn)
  const mid0 = await rita.eval(`(() => { const c = map.unproject([innerWidth / 2, innerHeight / 2]); return [c.lng, c.lat]; })()`);
  await turn(rita, SIDE);
  const side = await layout(rita);
  const midSide = await pixelOf(rita, mid0);
  check(Math.abs(midSide.x - (side.chat.right + SIDE.w) / 2) <= 2 && Math.abs(midSide.y - SIDE.h / 2) <= 2, "turned: what she was looking at in the middle of the map beside the chat — no jump", { midSide, chat: side.chat });
  check(side.chat.left === 0 && side.chat.w >= 300 && side.chat.w <= 420, "on the left, 300–420 px wide", side.chat);
  check(Math.abs(side.chat.top - side.topbar.bottom) <= 1 && side.chat.bottom === SIDE.h, "from the top bar's bottom to the screen's bottom", { chat: side.chat, topbar: side.topbar });
  check(side.msgs.h >= 150, "the messages have room (≥ 150 px; was ~37)", side.msgs);
  check(side.accountTappable && side.modeTappable, "the top bar whole: Settings and Drive tappable", side);

  step("the map knows the chat covers its left: padded by the chat's width");
  check(side.pad.left === side.chat.right && side.pad.right === 0, "padding on the left = the chat's width", side.pad);

  step("a banner: centered in the map beside the chat, never under it");
  await banner(rita, "You're online");
  const b = await layout(rita);
  check(b.banner.left >= b.chat.right + 8 && b.banner.right <= SIDE.w - 8, "wholly in the map area", { banner: b.banner, chat: b.chat });
  check(Math.abs((b.banner.left + b.banner.right) / 2 - (b.chat.right + SIDE.w) / 2) <= 2, "centered in it", { banner: b.banner, chat: b.chat });
  await banner(rita, "Location is blocked for this site. Turn it on in your browser's settings for this site, then tap the locate button again to try once more.");
  const long = await layout(rita);
  check(long.banner.left >= long.chat.right + 8 && long.banner.right <= SIDE.w - 8, "a long one wraps inside the map area", { banner: long.banner, chat: long.chat });

  step("the bottom buttons: in the map area too");
  check(b.buttons.length > 0 && b.buttons.every((x) => x.left >= b.chat.right), "none under the chat", { buttons: b.buttons, chat: b.chat });

  step("center on me: in the middle of the map beside the chat, not under it");
  await rita.eval(`(centreOnYou(state.me), true)`);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const me = await rita.eval(`(() => { const q = map.project([state.me.lng, state.me.lat]); return { x: Math.round(q.x), y: Math.round(q.y) }; })()`);
  check(Math.abs(me.x - (side.chat.right + SIDE.w) / 2) <= 2, "you in the middle of the map area", { me, chat: side.chat });
  // (review, 2026-11-22) find the nearest works out where people land on
  // screen from where you are: padded, it put everyone ~200 px off
  const guess = await rita.eval(`(() => { const cars = peopleOnMap("driver"); if (!cars.length) return null; const p = cars[0].pos; const g = HoodNearby.screenPoint(state.me, p, map.getZoom(), mapSize()); const d = map.project([p.lng, p.lat]); return { guess: { x: Math.round(g.x), y: Math.round(g.y) }, drawn: { x: Math.round(d.x), y: Math.round(d.y) } }; })()`);
  check(!!guess && Math.abs(guess.guess.x - guess.drawn.x) <= 1 && Math.abs(guess.guess.y - guess.drawn.y) <= 1, "find the nearest puts Dan's car where the map draws it", guess);

  step("closing and opening the chat sideways: the map doesn't jump");
  const before = await pixelOf(rita, ll);
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  const closed = await layout(rita);
  const shut = await pixelOf(rita, ll);
  check(closed.pad.left === 0 && Math.abs(shut.x - before.x) <= 1 && Math.abs(shut.y - before.y) <= 1, "closed: unpadded, the map where it was", { before, shut, pad: closed.pad });
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  const opened = await pixelOf(rita, ll);
  check(Math.abs(opened.x - before.x) <= 1 && Math.abs(opened.y - before.y) <= 1, "opened: the map where it was", { before, opened });

  // (second review, 2026-11-22) what else opens over the map beside it
  step("a car's card, the pile list and 'Share location': in the map beside the chat, not under it");
  const inMapArea = (r, chat) => !!r && r.left >= chat.right + 8 && r.right <= SIDE.w - 8 && Math.abs((r.left + r.right) / 2 - (chat.right + SIDE.w) / 2) <= 2;
  await rita.eval(`(openMarkerCard(realPeersById.get(${danId}), "driver"), true)`);
  await rita.waitFor(`!document.getElementById("peer-card").classList.contains("hidden")`, "the card open");
  await frames(rita, 2);
  const card = await rita.eval(`(() => { const b = document.getElementById("peer-card").getBoundingClientRect(); const c = document.getElementById("chat"); return { card: { left: Math.round(b.left), right: Math.round(b.right) }, chatOpen: !c.classList.contains("hidden"), chat: { right: Math.round(c.getBoundingClientRect().right) } }; })()`);
  check(card.chatOpen && inMapArea(card.card, card.chat), "the card beside the chat", card);
  await rita.eval(`(closePeerCard(), true)`);
  const pile = await rita.eval(`(() => { const p = document.getElementById("pile-sheet"); const was = p.classList.contains("hidden"); p.classList.remove("hidden"); const b = p.getBoundingClientRect(); if (was) p.classList.add("hidden"); return { left: Math.round(b.left), right: Math.round(b.right) }; })()`);
  check(inMapArea(pile, side.chat), "the pile list beside the chat", { pile, chat: side.chat });
  const share = await rita.eval(`(() => { showSharePrompt("Share location"); const b = document.getElementById("share-location").getBoundingClientRect(); hideSharePrompt(); return { left: Math.round(b.left), right: Math.round(b.right) }; })()`);
  check(inMapArea(share, side.chat), "'Share location' beside the chat", { share, chat: side.chat });

  // (second review) the top bar's height read as a place on screen: with
  // Safari's page scrolled for a keyboard, it came out short (negative even)
  // and the sheet then started over the top bar
  step("the top bar resizing while Safari has the page scrolled: the sheet still starts right under it");
  const bar = await rita.eval(`new Promise((ok) => {
    const rects = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { const r = rects.call(this); return new DOMRect(r.x, r.y - 100, r.width, r.height); };
    const tb = document.querySelector(".topbar");
    tb.style.paddingTop = "20px";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      Element.prototype.getBoundingClientRect = rects;
      const want = Math.round(tb.getBoundingClientRect().height);
      const got = getComputedStyle(document.documentElement).getPropertyValue("--topbar-h").trim();
      tb.style.paddingTop = "";
      requestAnimationFrame(() => requestAnimationFrame(() => ok({ want, got })));
    }));
  })`);
  check(bar.got === `${bar.want}px`, "the sheet's top: the bar's real height", bar);

  // (second review) the hold-still move counted as "you moved the map": a
  // search, or its watch on who it found, ended when the chat opened/closed
  step("✋ up sideways, the nearest car found and watched: closing and opening the chat doesn't end the watch");
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 2);
  await rita.click("btn-hand");
  await rita.waitFor(`state.handRaised && !nearLooking && foundWatch !== null`, "found, and watched", 20000);
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  check(await rita.eval(`foundWatch !== null`), "opened: still watched");
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  check(await rita.eval(`foundWatch !== null`), "closed: still watched");
  await rita.click("btn-hand");
  await rita.waitFor(`!state.handRaised`, "✋ down");

  // (second review) …nor cuts short a move on its way (a glide, a search's step)
  step("the chat opening while the map glides: the glide still arrives");
  const goal = await rita.eval(`(() => { const c = map.unproject([innerWidth * 0.8, innerHeight * 0.5]); map.easeTo({ center: c, duration: 600 }); return [c.lng, c.lat]; })()`);
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await rita.waitFor(`!map.isMoving()`, "the glide done");
  await frames(rita, 3);
  // (the glide started with the chat closed: it brings `goal` to the
  // screen's middle; padded once there, the picture holds still — cut
  // short, `goal` stopped somewhere on the way)
  const arrived = await pixelOf(rita, goal);
  check(Math.abs(arrived.x - SIDE.w / 2) <= 1 && Math.abs(arrived.y - SIDE.h / 2) <= 1, "arrived where it was going", { arrived });

  // (third review, 2026-11-22) the search works out who's in sight from
  // where it looks from, drawn in the middle of what's shown: the chat
  // closing mid-search held the picture still — the middle moved, the
  // search's sums ~200 px off
  step("✋ up sideways, the chat closed while the search waits: it still looks from the middle of what's shown");
  await rita.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 17 }), true)`);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  await holdAnswers(rita);
  await rita.click("btn-hand");
  await rita.waitFor(`nearLooking && !map.isMoving() && window.__heldAsks.length > 0`, "searching, waiting for answers");
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  const looks = await rita.eval(`(() => { const s = mapSize(); const q = map.project([nearAt.lng, nearAt.lat]); return { at: { x: Math.round(q.x), y: Math.round(q.y) }, mid: { x: Math.round(s.cx), y: Math.round(s.cy) }, looking: nearLooking }; })()`);
  check(looks.looking && Math.abs(looks.at.x - looks.mid.x) <= 1 && Math.abs(looks.at.y - looks.mid.y) <= 1, "where it looks from: drawn in the middle of what's shown", looks);
  await letAnswersGo(rita);
  await rita.waitFor(`!nearLooking`, "the search done", 20000);
  await rita.click("btn-hand");
  await rita.waitFor(`!state.handRaised`, "✋ down");

  // (third review) held still, the place you were looking at — you, after
  // "center on me" — could end up under the sheet (with the notch on its
  // side, the sheet is wider than half the screen)
  step("the notch on the sheet's side, centered on her, the chat opens: she's still in view, beside it");
  await rita.safeArea({ left: 59 });
  await frames(rita, 3);
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 2);
  await rita.eval(`(map.jumpTo({ center: [state.me.lng, state.me.lat] }), true)`);
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  const seen = await rita.eval(`(() => { const q = map.project([state.me.lng, state.me.lat]); return { me: Math.round(q.x), sheet: Math.round(document.getElementById("chat").getBoundingClientRect().right) }; })()`);
  check(seen.me >= seen.sheet + 24, "she's beside the sheet, not under it", seen);
  await rita.safeArea({ left: 0 });
  await frames(rita, 3);

  // (fifth review, 2026-11-22) a real iPhone sideways reports its insets on
  // BOTH sides (~44–59 px each, wherever the notch is: Apple forums 92407):
  // the sheet always wider than half the screen — opening re-centred, closing
  // held still: each open and close walked the view ~190 px
  step("insets on both sides, as a real iPhone sideways: the chat opened and closed twice — the map back exactly where it was");
  await rita.safeArea({ left: 47, right: 47 });
  await frames(rita, 3);
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const home = await rita.eval(`(() => { const c = map.unproject([innerWidth / 2, innerHeight / 2]); return [c.lng, c.lat]; })()`);
  for (let i = 0; i < 2; i++) {
    await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
    await frames(rita, 3);
    await rita.waitFor(`!map.isMoving()`, "the map still");
    await rita.eval(`(closeChat(), true)`);
    await frames(rita, 3);
    await rita.waitFor(`!map.isMoving()`, "the map still");
  }
  const after = await pixelOf(rita, home);
  check(Math.abs(after.x - SIDE.w / 2) <= 1 && Math.abs(after.y - SIDE.h / 2) <= 1, "back where it was (no walk)", after);
  // (sixth review) you moved the map yourself with the chat open: closing
  // holds what you now see still — no jump back by half the sheet
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  // (a real drag, on the map beside the sheet)
  await rita.drag(650, 200, 590, 230);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const panned = await rita.eval(`(() => { const c = map.unproject([700, 200]); return [c.lng, c.lat]; })()`);
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const stayed = await pixelOf(rita, panned);
  check(Math.abs(stayed.x - 700) <= 1 && Math.abs(stayed.y - 200) <= 1, "closed after your own move: what you see stays put", stayed);
  // (seventh review, 2026-11-22) a Shift-drag box zoom (a computer) is
  // the one gesture MapLibre doesn't mark as yours (no originalEvent):
  // closing after it went back by half the sheet
  step("a Shift-drag box zoom with the chat open: closing holds what you see still");
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const zoom0 = await rita.eval(`map.getZoom()`);
  // (real input: Shift held, a box dragged on the map beside the sheet)
  await rita.drag(560, 120, 710, 240, 8);
  await rita.waitFor(`!map.isMoving()`, "the box zoom done");
  const zoom1 = await rita.eval(`map.getZoom()`);
  check(zoom1 > zoom0 + 0.5, "(zoomed into the box)", { zoom0, zoom1 });
  const boxed = await rita.eval(`(() => { const c = map.unproject([700, 200]); return [c.lng, c.lat]; })()`);
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const boxStayed = await pixelOf(rita, boxed);
  check(Math.abs(boxStayed.x - 700) <= 1 && Math.abs(boxStayed.y - 200) <= 1, "closed after your box zoom: what you see stays put", boxStayed);
  // (box zoom review, 2026-11-22) a box started and cancelled (Escape)
  // moved nothing: the sheet's way back on close is kept — the chat opened
  // re-centred, closed after it: back exactly where it was
  step("a Shift-drag box cancelled with Escape: nothing moved — closing still returns the map where it was");
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const home2 = await rita.eval(`(() => { const c = map.unproject([innerWidth / 2, innerHeight / 2]); return [c.lng, c.lat]; })()`);
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const zoomC = await rita.eval(`map.getZoom()`);
  await rita.drag(560, 120, 710, 240, 8, { beforeRelease: () => rita.key("Escape") });
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  check((await rita.eval(`map.getZoom()`)) === zoomC, "(cancelled: no zoom)");
  await rita.eval(`(closeChat(), true)`);
  await frames(rita, 3);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const back2 = await pixelOf(rita, home2);
  check(Math.abs(back2.x - SIDE.w / 2) <= 1 && Math.abs(back2.y - SIDE.h / 2) <= 1, "back where it was before the chat opened", back2);
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  // (sixth review) the top bar's buttons clear of the notch on either side
  const tb = await rita.eval(`(() => { const a = document.getElementById("btn-account").getBoundingClientRect(); const m = document.getElementById("btn-mode").getBoundingClientRect(); return { account: Math.round(a.left), mode: Math.round(m.right) }; })()`);
  check(tb.account >= 47 && tb.mode <= SIDE.w - 47, "Settings and Drive clear of the notch", tb);
  // (fifth review) ◎ at the end side, clear of the notch there
  const loc = await rita.eval(`(() => { const b = document.getElementById("btn-locate").getBoundingClientRect(); return { right: Math.round(b.right) }; })()`);
  check(loc.right <= SIDE.w - 47, "◎ clear of the notch", loc);
  await rita.eval(`(openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  await rita.safeArea({ left: 0, right: 0 });
  await frames(rita, 3);

  // (third review) a notch on the far side: the map beside the sheet ends
  // there — the banner centered in what's left
  step("a notch on the far side: the banner centered between the sheet and the notch");
  await rita.safeArea({ right: 47 });
  await frames(rita, 3);
  await banner(rita, "You're online");
  const far = await layout(rita);
  check(Math.abs((far.banner.left + far.banner.right) / 2 - (far.chat.right + SIDE.w - 47) / 2) <= 2, "centered between them", { banner: far.banner, chat: far.chat });
  // (fourth review) …and the map's own middle there too: "center on me"
  // ~23 px off the banner's, the padding ignoring that notch
  await rita.eval(`(centreOnYou(state.me), true)`);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const meFar = await rita.eval(`(() => { const q = map.project([state.me.lng, state.me.lat]); return Math.round(q.x); })()`);
  check(Math.abs(meFar - (far.chat.right + SIDE.w - 47) / 2) <= 2, "center on me: in the middle between them too", { meFar, chat: far.chat });
  await rita.safeArea({ right: 0 });
  await frames(rita, 3);

  step("typing sideways (the keyboard up): a slim name bar — the messages still have room");
  await rita.eval(`document.getElementById("chat-input").focus(), true`);
  const KB = 200;
  await rita.eval(`(() => {
    if (!window.__vvDesc) window.__vvDesc = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const fake = Object.assign(new EventTarget(), { width: ${SIDE.w}, height: ${SIDE.h - KB}, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    if (!window.__mm) window.__mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/pointer: *coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : window.__mm(q));
    fitChatToKeyboard();
    return true;
  })()`);
  await frames(rita, 2);
  const typing = await layout(rita);
  check(typing.chat.bottom === SIDE.h - KB, "(lifted onto the keyboard)", typing.chat);
  // (one row: the name and its button — Request ride here; 86 px before)
  check(!typing.links && !typing.dist && typing.header.h <= 60, "a slim name bar: one row, the name and its button", typing);
  check(typing.msgs.h >= 40, "a couple of lines of messages still showing", typing.msgs);
  await rita.eval(`(document.getElementById("chat-input").blur(), Object.defineProperty(window, "visualViewport", window.__vvDesc), window.matchMedia = window.__mm, fitChatToKeyboard(), true)`);
  await frames(rita, 3);

  step("a notch on the left (turned that way): the chat's text clear of it");
  await rita.safeArea({ left: 47 });
  await frames(rita, 3);
  const notch = await rita.eval(`(() => { const n = document.getElementById("chat-name").getBoundingClientRect(); const i = document.getElementById("chat-input").getBoundingClientRect(); return { name: Math.round(n.left), input: Math.round(i.left) }; })()`);
  check(notch.name >= 47 && notch.input >= 47, "the name and the text box right of the notch", notch);
  // (review, 2026-11-22) the notch came without a resize: the sheet wider,
  // the map's padding and the banner's place kept the old width
  const notched = await layout(rita);
  check(notched.chat.w === side.chat.w + 47 && notched.pad.left === notched.chat.right, "the map's padding follows the wider sheet", { chat: notched.chat, pad: notched.pad });
  await rita.safeArea({ left: 0 });

  step("upright again: the sheet at the bottom, the map unpadded, the banner centered on the screen");
  const mid1 = await rita.eval(`(() => { const p = map.getPadding(); const c = map.unproject([p.left + (innerWidth - p.left - p.right) / 2, innerHeight / 2]); return [c.lng, c.lat]; })()`);
  await turn(rita, UP);
  const midUp = await pixelOf(rita, mid1);
  check(Math.abs(midUp.x - UP.w / 2) <= 2 && Math.abs(midUp.y - UP.h / 2) <= 2, "turned back: what she was looking at in the middle again — no jump", midUp);
  await banner(rita, "You're online");
  const back = await layout(rita);
  check(back.chat.left === 0 && back.chat.right === UP.w && back.chat.bottom === UP.h && back.chat.h === up.chat.h, "as before", { up: up.chat, back: back.chat });
  check(back.pad.left === 0 && back.pad.right === 0, "unpadded", back.pad);
  check(Math.abs((back.banner.left + back.banner.right) / 2 - UP.w / 2) <= 2, "the banner centered on the screen", back.banner);

  // (review, 2026-11-22) a browser that shrinks the whole page for the
  // keyboard: upright, the page can come out wider than tall (MDN: the
  // orientation feature and on-screen keyboards) — not a turn
  // (fourth review) the map resized from every window resize, chat or not —
  // dragging a computer's window edge: ~60 a second, each a move (hexes
  // re-planned, the view saved). Only before a padding change
  step("the chat closed, the window resized: the map left to resize itself (no extra resizes)");
  await rita.eval(`(closeChat(), (() => { const r = map.resize.bind(map); window.__inResize = 0; map.resize = (...a) => { if (window.event && window.event.type === "resize") window.__inResize++; return r(...a); }; })(), true)`);
  await rita.phone(UP.w, UP.h - 40);
  await frames(rita, 4);
  await rita.phone(UP.w, UP.h);
  await frames(rita, 4);
  const extra = await rita.eval(`window.__inResize`);
  await rita.eval(`(delete map.resize, openChat(realPeersById.get(${danId})), true)`);
  await frames(rita, 3);
  check(extra === 0, "none from the window's resize event", extra);

  step("upright, a keyboard shrinking the whole page wider than tall (360×330): still the sheet at the bottom");
  await rita.phone(360, 330);
  await frames(rita, 4);
  await rita.waitFor(`!map.isMoving()`, "the map still");
  const squat = await layout(rita);
  check(squat.chat.left === 0 && squat.chat.right === 360 && squat.chat.bottom === 330 && squat.pad.left === 0, "across the bottom, the map unpadded", { chat: squat.chat, pad: squat.pad });
  await turn(rita, UP);

  step("right to left (Arabic), sideways: the chat on the right, the map padded there, the banner in the map to its left");
  const amal = await browser.person("BT-SideAmal");
  await amal.phone(SIDE.w, SIDE.h);
  await facing(amal, "landscape-primary");
  await amal.goto(`${BASE}/privacy`);
  await amal.eval(`(document.cookie = "hoodride_lang=ar; path=/", true)`);
  await amal.open();
  check((await amal.eval(`document.documentElement.dir`)) === "rtl", "(right to left)");
  await sees(amal, danId);
  await openChatWith(amal, danId);
  await frames(amal, 4);
  await amal.waitFor(`!map.isMoving()`, "the map still");
  await banner(amal, "You're online");
  const rtl = await layout(amal);
  check(rtl.chat.right === SIDE.w && rtl.chat.w >= 300 && rtl.chat.w <= 420, "on the right", rtl.chat);
  check(rtl.pad.right === SIDE.w - rtl.chat.left && rtl.pad.left === 0, "padded on the right", rtl.pad);
  check(rtl.banner.right <= rtl.chat.left - 8 && rtl.banner.left >= 8 && Math.abs((rtl.banner.left + rtl.banner.right) / 2 - rtl.chat.left / 2) <= 2, "the banner centered in the map to its left", { banner: rtl.banner, chat: rtl.chat });
  check(rita.errors.length === 0 && amal.errors.length === 0, "no page errors", [rita.errors, amal.errors]);
});
