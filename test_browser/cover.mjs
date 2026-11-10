// Helpers for the find-the-nearest journeys (findnearestcover*.mjs,
// findnearestpause/nobody/overtime/backoff/driving/
// settle/faults/away/dot.mjs, and the older
// findnearest/late/slow.mjs — owner, 2026-11-09: "if you can see it on the
// map, it counts"). Runs no journey itself.
//
// The rule (nearby.js inSight): a person counts when their WHOLE drawn
// marker is on the screen and overlaps no box of anything over the map.
//
// The expected answers are worked out HERE, by the test's own copy of the
// rule (`oracle`, installed into the page) — its own Mercator maths, its own
// list of what covers the map, its own measure of each marker — never by
// the app's code, so a mistake in the app can't be copied into what the
// test expects. Every search is traced: the zoom steps it took must be
// exactly the steps up to the expected stop (it ran; it skipped none; it
// went no step too far). A case that can't be set up fails — nothing is
// skipped quietly.
import { check, BASE, HOME } from "./cdp.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what covers the map, as the test sees it (the app's own list is pinned
// by test/hoodride_web/near_covers_test.exs)
export const COVER_SEL = [
  "#btn-account",
  ".topbar-title",
  "#btn-mode",
  "#banner",
  "#update-available",
  "#btn-locate",
  "#bottom-controls > *",
  "#share-location",
  "#peer-card",
  "#pile-sheet",
  "#chat",
  ".maplibregl-ctrl",
];

// what may lie over a marker and still let you see it: see-through boxes
// (the top bar's fade, the bottom bar's row, the map's own layers and its
// corner holders) — anything else over a found marker fails the browser's
// own check below
export const SEE_THROUGH = [
  "#map", "#screen-map", "canvas", ".maplibregl-canvas-container", ".maplibregl-canvas", ".maplibregl-control-container",
  ".maplibregl-ctrl-top-left", ".maplibregl-ctrl-top-right", ".maplibregl-ctrl-bottom-left", ".maplibregl-ctrl-bottom-right",
  ".topbar", ".topbar-left", ".topbar-right", "#bottom-controls",
];

// the test's own copy of the rule, in the page (window.__o)
export const oracle = (p) =>
  p.eval(`(() => {
    if (window.__o) return true;
    const SEL = ${JSON.stringify(COVER_SEL)};
    const mapBox = () => document.getElementById("map").getBoundingClientRect();
    const size = () => { const m = mapBox(); return { w: m.width, h: m.height }; };
    const rel = (r) => { const m = mapBox(); return { top: r.top - m.top, bottom: r.bottom - m.top, left: r.left - m.left, right: r.right - m.left }; };
    // the phone's edges the page is drawn under: the test's own probe
    const probe = document.createElement("div");
    Object.assign(probe.style, { position: "fixed", top: "0", left: "0", width: "0", height: "0", visibility: "hidden", pointerEvents: "none" });
    probe.style.padding = "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(probe);
    // a solid ring round a cover (a spread-only box-shadow — the raised ✋'s
    // yellow ring — or an outline): you see it, so it covers too
    // (written without regular expressions: this is a template string, where
    // a backslash would quietly vanish)
    const ring = (el) => {
      const cs = getComputedStyle(el);
      let g = 0;
      // its shadows one by one (a comma inside a colour doesn't split one)
      const parts = [];
      let depth = 0, cur = "";
      for (const ch of cs.boxShadow === "none" ? "" : cs.boxShadow) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
      }
      parts.push(cur);
      for (const sh of parts) {
        if (sh.includes("inset") || sh.includes("transparent")) continue;
        // its colour's alpha (after the slash, else the 4th value): 0 draws nothing
        const open = sh.indexOf("("), close = sh.indexOf(")");
        const inner = open >= 0 && close > open ? sh.slice(open + 1, close) : "";
        const alpha = inner.includes("/") ? inner.split("/")[1] : inner.split(",")[3];
        if (alpha !== undefined && parseFloat(alpha) === 0) continue;
        const rest = open >= 0 && close > open ? sh.slice(0, open) + " " + sh.slice(close + 1) : sh;
        const n = rest.split(" ").filter((w) => w.endsWith("px")).map(parseFloat);
        if (n.length === 4 && n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] > 0) g = Math.max(g, n[3]);
      }
      if (cs.outlineStyle !== "none") g = Math.max(g, (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0));
      return g;
    };
    const covers = () => {
      const out = [];
      for (const sel of SEL)
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest(".hidden")) continue;
          const r = el.getBoundingClientRect();
          const g = ring(el);
          if (r.width && r.height) out.push({ sel, ...rel({ top: r.top - g, bottom: r.bottom + g, left: r.left - g, right: r.right + g }) });
        }
      const cs = getComputedStyle(probe), W = innerWidth, H = innerHeight;
      const edge = (sel, top, bottom, left, right) => out.push({ sel, ...rel({ top, bottom, left, right }) });
      const pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0, pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      if (pt) edge("phone-edge", 0, pt, 0, W);
      if (pb) edge("phone-edge", H - pb, H, 0, W);
      if (pl) edge("phone-edge", 0, H, 0, pl);
      if (pr) edge("phone-edge", 0, H, W - pr, W);
      // (the keyboard only while typing — or a page pinched in)
      const ae = document.activeElement;
      const typing = !!ae && !ae.closest(".hidden") && ae.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
      const vv = typing || (window.visualViewport && window.visualViewport.scale > 1.01) ? window.visualViewport : null;
      if (vv && vv.offsetTop > 0.5) edge("keyboard", 0, vv.offsetTop, 0, W);
      if (vv && vv.offsetTop + vv.height < H - 0.5) edge("keyboard", vv.offsetTop + vv.height, H, 0, W);
      if (vv && vv.offsetLeft > 0.5) edge("keyboard", 0, H, 0, vv.offsetLeft);
      if (vv && vv.offsetLeft + vv.width < W - 0.5) edge("keyboard", 0, H, vv.offsetLeft + vv.width, W);
      return out;
    };
    // a drawn marker: its middle, and how far it reaches each SIDE (a
    // group's badge pokes out of one corner), everything it draws included
    const drawnBox = (el) => {
      const r = el.getBoundingClientRect();
      let { top, bottom, left, right } = r;
      for (const k of el.querySelectorAll("*")) {
        const c = k.getBoundingClientRect();
        if (!c.width || !c.height) continue;
        top = Math.min(top, c.top); bottom = Math.max(bottom, c.bottom);
        left = Math.min(left, c.left); right = Math.max(right, c.right);
      }
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      return { cx, cy, half: { l: cx - left, r: right - cx, t: cy - top, b: bottom - cy }, w: r.width, h: r.height };
    };
    const merc = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
    const point = (me, pos, z, s) => {
      const k = 512 * 2 ** z;
      let d = pos.lng - me.lng;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return { x: s.w / 2 + (d / 360) * k, y: s.h / 2 + (merc(pos.lat) - merc(me.lat)) * k };
    };
    // (h: {l, r, t, b}, or {x, y} the same each way)
    const reach = (h) => ({ l: h.l ?? h.x, r: h.r ?? h.x, t: h.t ?? h.y, b: h.b ?? h.y });
    const clear = (pt, half, s, cs) => {
      const h = reach(half);
      const L = pt.x - h.l, R = pt.x + h.r, T = pt.y - h.t, B = pt.y + h.b;
      return L >= 0 && R <= s.w && T >= 0 && B <= s.h && cs.every((c) => R <= c.left || L >= c.right || B <= c.top || T >= c.bottom);
    };
    // the search's steps: the usual view, half a level wider each time, to
    // the widest view that still shows people one by one (that zoom: the
    // app's own, tested on its own in test_js/nearby.test.mjs)
    // (where it starts — the usual view, closer in on a screen so big it
    // shows counts there — and the widest: the app's own, each tested on
    // its own in test_js/nearby.test.mjs; the steps between: worked out here)
    const steps = () => {
      // (for a screen NEAR_EDGE_PX bigger each side — as the app works its
      // zooms out: its real view may be a pixel wider than measured)
      const ladder = { viewport: HoodViewport, h3, center: state.me, size: { w: mapSize().w + 2 * NEAR_EDGE_PX, h: mapSize().h + 2 * NEAR_EDGE_PX }, rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS };
      const z0 = HoodNearby.markerStartZoom({ ...ladder, maxZoom: 14 });
      const w = HoodNearby.widestMarkerZoom({ ...ladder, maxZoom: z0 });
      const zs = [z0];
      for (let z = z0 - 0.5; z >= w + 0.25 - 1e-9; z -= 0.5) zs.push(Math.round(z * 100) / 100);
      if (w < z0) zs.push(w);
      return zs;
    };
    // the marker you look for: the car (drivers[0]), the pretend ✋, or a
    // real person by id (the group marker that holds them)
    const target = (who) => {
      if (who === "car") { const d = drivers[0]; return d.visible ? { pos: d.pos, el: d.marker.getElement() } : null; }
      if (who === "hand") return mockHand && mockHand.visible ? { pos: mockHand.pos, el: mockHand.marker.getElement() } : null;
      for (const pm of pileMarkers.values()) if (pm.ids.includes(who)) { const at = pm.marker.getLngLat(); return { pos: { lat: at.lat, lng: at.lng }, el: pm.el, n: pm.ids.length }; }
      return null;
    };
    // the first step showing any of whos, the covers as they are now (all
    // but those matching without, if given)
    const stop = (whos, without = null) => {
      const s = size(), cs = covers().filter((c) => c.sel !== without);
      const ts = whos.map(target).filter(Boolean).map((t) => ({ ...t, half: drawnBox(t.el).half }));
      const zs = steps();
      const z = zs.find((z) => ts.some((t) => clear(point(state.me, t.pos, z, s), t.half, s, cs)));
      return { stop: z === undefined ? null : z, steps: zs, found: ts.length };
    };
    // seen right now, where the map is (not the search's prediction)
    const seenNow = (who) => {
      const t = target(who);
      if (!t) return false;
      const b = drawnBox(t.el), m = mapBox();
      return clear({ x: b.cx - m.left, y: b.cy - m.top }, b.half, size(), covers());
    };
    // the search's camera moves, in order (each carries the search's number)
    const ease = map.easeTo.bind(map);
    // every banner change: [text, its bottom, ms] (a failure shows what changed it)
    window.__banners = [];
    const bn = document.getElementById("banner");
    new MutationObserver(() => { window.__banners.push([bn.textContent, Math.round(bn.getBoundingClientRect().bottom), Math.round(performance.now())]); if (window.__banners.length > 30) window.__banners.shift(); }).observe(bn, { childList: true, subtree: true, characterData: true, attributes: true });
    window.__trace = [];
    window.__onStep = null;
    map.easeTo = (o, e) => {
      if (e && e.nearSearch != null) {
        if (!window.__trace.length) window.__firstStepAt = performance.now();
        window.__trace.push(o.zoom);
        if (window.__onStep) window.__onStep(window.__trace.length);
        if (window.__slowSteps) o = { ...o, duration: window.__slowSteps };
      }
      return ease(o, e);
    };
    // a spot where a marker of half-size h overlaps the cover sel (by 2 px
    // at least) and nothing else (1 px clear), wholly on the screen (1 px
    // in) — margins, so a fraction of a pixel can't tip it — nearest that
    // cover's middle; null: there is none
    const onlyUnder = (sel, h0) => {
      const s = size(), all = covers(), mine = all.filter((c) => c.sel === sel), others = all.filter((c) => c.sel !== sel);
      const h = reach(h0);
      const hitsBy = (pt, c, m) => pt.x + h.r > c.left + m && pt.x - h.l < c.right - m && pt.y + h.b > c.top + m && pt.y - h.t < c.bottom - m;
      const hits = (pt, c) => hitsBy(pt, c, 2);
      const near = (pt, o) => hitsBy(pt, o, -1);
      let best = null;
      for (const c of mine) {
        const mx = (c.left + c.right) / 2, my = (c.top + c.bottom) / 2;
        for (let x = Math.ceil(c.left - h.r + 1); x <= c.right + h.l - 1; x++)
          for (let y = Math.ceil(c.top - h.b + 1); y <= c.bottom + h.t - 1; y++) {
            const pt = { x, y };
            if (x - h.l < 1 || x + h.r > s.w - 1 || y - h.t < 1 || y + h.b > s.h - 1) continue;
            if (!hits(pt, c) || others.some((o) => near(pt, o))) continue;
            const d = (x - mx) ** 2 + (y - my) ** 2;
            if (!best || d < best.d) best = { x, y, d };
          }
      }
      return best && { x: best.x, y: best.y };
    };
    // the browser's OWN check, not the test's list: for each person found
    // in sight now, what's on top at points around their marker's edge (2 px
    // in) — with every element made to answer (pointer-events), so nothing
    // is skipped for letting touches through. On top must be the marker
    // itself, another person's marker, or a see-through box. A cover
    // missing from BOTH lists fails here.
    // points on a drawn marker: every 4 px along its four edges (1 px in)
    // and a 4 px grid inside
    const samples = (d) => {
      const h = d.half, L = d.cx - h.l + 1, R = d.cx + h.r - 1, T = d.cy - h.t + 1, B = d.cy + h.b - 1, out = [];
      for (let x = L; x <= R; x += 4) out.push([x, T], [x, B]);
      for (let y = T; y <= B; y += 4) out.push([L, y], [R, y]);
      for (let x = L + 4; x < R; x += 4) for (let y = T + 4; y < B; y += 4) out.push([x, y]);
      out.push([R, T], [R, B], [L, B]);
      return out;
    };
    // the people on the map: their markers' elements (NOT your own blue dot:
    // over a car, it would hide it — it's drawn under everyone)
    const people = () => [
      ...[...pileMarkers.values()].map((pm) => pm.el),
      ...(typeof drivers !== "undefined" ? drivers.map((d) => d.marker && d.marker.getElement()) : []),
      ...(typeof mockHand !== "undefined" && mockHand && mockHand.marker ? [mockHand.marker.getElement()] : []),
    ].filter(Boolean);
    const describe = (el) => el.tagName + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(" ").filter(Boolean).join(".") : "");
    // every element made to answer the browser's "what's here?" — even
    // those that let touches through (the top bar's title) — through a
    // stylesheet the page's security rules allow (an inserted <style> is
    // silently blocked); checked to have worked, never trusted blind.
    // Returns the undo.
    const forceHits = () => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("* { pointer-events: auto !important; }");
      const before = document.adoptedStyleSheets;
      document.adoptedStyleSheets = [...before, sheet];
      const probe = document.querySelector(".topbar") || document.body;
      if (getComputedStyle(probe).pointerEvents !== "auto") throw new Error("could not make every element answer the hit test");
      return () => { document.adoptedStyleSheets = before; };
    };
    // something you can actually see: not see-through, all the way up
    const seeable = (el) => {
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (parseFloat(cs.opacity) < 0.05 || cs.visibility === "hidden") return false;
      }
      return true;
    };
    // the browser's own word that a marker IS hidden by the cover sel: at
    // some point of it, what's on top is that cover (pointer-events forced)
    const coveredBy = (who, sel) => {
      const t = target(who);
      if (!t) return { ok: false, why: "not drawn" };
      const d = drawnBox(t.el);
      const style = forceHits();
      try {
        const h = d.half, L = d.cx - h.l + 0.5, R = d.cx + h.r - 0.5, T = d.cy - h.t + 0.5, B = d.cy + h.b - 0.5;
        for (let x = L; x <= R; x += 1)
          for (let y = T; y <= B; y += 1) {
            if (x > L && x < R && y > T && y < B && (Math.round(x - L) % 3 || Math.round(y - T) % 3)) continue;
            const top = document.elementFromPoint(x, y);
            if (top && top.closest(sel) && !t.el.contains(top) && seeable(top)) return { ok: true, x, y, top: describe(top) };
          }
      } finally {
        style();
      }
      return { ok: false, why: "nothing of " + sel + " on top of it anywhere" };
    };
    const hitCheck = (whos) => {
      const s = size(), cs = covers(), m = mapBox();
      const style = forceHits();
      const SEE = ${JSON.stringify(SEE_THROUGH)};
      const bad = [];
      let checked = 0;
      try {
        for (const who of whos) {
          const t = target(who);
          if (!t) continue;
          const d = drawnBox(t.el);
          const at = { x: d.cx - m.left, y: d.cy - m.top };
          if (!clear(at, d.half, s, cs)) continue;
          checked++;
          for (const [x, y] of samples(d)) {
            const top = document.elementFromPoint(x, y);
            if (!top || t.el.contains(top)) continue;
            // another person's marker: you see a person there (never any
            // other marker — the meeting pin covers; nor your dot)
            if (people().some((el) => el !== t.el && el.contains(top))) continue;
            if (SEE.some((sel) => top.matches(sel))) continue;
            bad.push({ who, x: Math.round(x), y: Math.round(y), top: describe(top) });
            if (bad.length > 5) break;
          }
        }
      } finally {
        style();
      }
      return { ok: bad.length === 0 && checked > 0, checked, bad };
    };
    // every look "nobody nearby yet" (or the search) takes at the map:
    // counted, so a test waits on looks, not on the clock
    const mos = mapOutOfSight;
    window.__looks = 0;
    mapOutOfSight = function () {
      window.__looks++;
      if (window.__lookWho) window.__lookWho.push(String(new Error().stack).split(String.fromCharCode(10)).slice(2, 5).map((l) => l.trim()).join(" < ") + " | seq " + nearSeq + " looking " + nearLooking + " nobody " + nobodyNear);
      const out = mos();
      if (!out) { const sh = document.getElementById("settings-sheet"); window.__lastInSight = sh ? rel(sh.getBoundingClientRect()) : null; }
      return out;
    };
    // what's drawn of a cover sticks out past its box (a long name, a
    // badge): the rule only counts the box — anything outside it is over the
    // map unseen by the rule. Each showing cover's descendants checked —
    // but not those a clipping box inside it cuts off (a scrolling list)
    const overflows = () => {
      const out = [];
      for (const sel of SEL)
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest(".hidden")) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const g = ring(el);
          const out_ = (b, what) => {
            if (b.width && b.height && (b.left < r.left - g - 0.5 || b.right > r.right + g + 0.5 || b.top < r.top - g - 0.5 || b.bottom > r.bottom + g + 0.5))
              out.push({ cover: sel, what, box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], of: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
          };
          // text spilling out of its element (a long word in a box that
          // doesn't clip): measured as the text itself
          const text = (e) => {
            for (const t of e.childNodes)
              if (t.nodeType === 3 && t.textContent.trim()) {
                const rg = document.createRange();
                rg.selectNodeContents(t);
                out_(rg.getBoundingClientRect(), "text in " + describe(e));
              }
          };
          const walk = (e) => {
            for (const k of e.children) {
              const cs = getComputedStyle(k);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              const b = k.getBoundingClientRect();
              if (b.width && b.height && (b.left < r.left - g - 0.5 || b.right > r.right + g + 0.5 || b.top < r.top - g - 0.5 || b.bottom > r.bottom + g + 0.5))
                out.push({ cover: sel, what: describe(k), box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], of: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
              if (cs.overflowX === "visible" && cs.overflowY === "visible") {
                text(k);
                walk(k);
              }
            }
          };
          const own = getComputedStyle(el);
          if (own.overflowX === "visible" || own.overflowY === "visible") {
            text(el);
            walk(el);
          }
        }
      return out;
    };
    window.__o = { size, covers, drawnBox, point, clear, steps, target, stop, seenNow, rel, onlyUnder, hitCheck, coveredBy, overflows };
    return true;
  })()`);

// the demo, on a screen of w×h CSS px at `scale`; `lang` picked (the
// switch's cookie); `notch` safe-area insets; `at` where you stand
export async function demo(browser, name, { w, h, scale = 1, lang = null, notch = null, at = HOME }) {
  const p = await browser.visitor(name, at);
  await p.phone(w, h, scale);
  if (notch) await p.safeArea(notch);
  if (lang) {
    await p.goto(`${BASE}/privacy`);
    await p.eval(`(document.cookie = "hoodride_lang=${lang}; path=/", true)`);
  }
  await p.goto(`${BASE}/?demo=1`);
  await p.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && map.loaded() && drivers.length >= 2 && !!state.me`, `${name}: the demo`, 20000);
  // (the demo always stands in New York, whatever the phone says: placed
  // there by hand — the map, the markers and the maths are the real ones)
  if (at !== HOME) {
    await p.eval(`(() => { state.me = { lat: ${at.latitude}, lng: ${at.longitude} }; meMarker.setLngLat([state.me.lng, state.me.lat]); map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: INTENT_ZOOM }); refreshWorldMarkers(); return true; })()`);
    await p.waitFor(`!map.isMoving() && Math.abs(map.getCenter().lat - ${at.latitude}) < 1e-6`, `${name}: standing where asked`, 15000);
  }
  // (the demo's pretend driver messages you 6 s after every ✋ up — a banner
  // that moves what covers the map mid-case: off, every time)
  await p.eval(`(() => { const sh = setHand; setHand = (up) => { sh(up); clearTimeout(handPingTimer); }; return true; })()`);
  // (its pretend rider's request 14 s after going online: off as well — a
  // banner that moves what covers the map mid-case)
  await p.eval(`(scheduleIncomingRequest = () => {}, true)`);
  // (the jitter of "look again" at its middle: exact waits — 5, 10, 20… s)
  await p.eval(`(nearRand = () => 0.5, true)`);
  await oracle(p);
  return p;
}

// the pretend people stop wandering (placed to the pixel below) — only the
// wander (±20 m a tick): the demo still places its ✋ and riders at their
// real distance (300 m and more)
export const freeze = (p) =>
  p.eval(`(() => { const o = offsetPos; offsetPos = (pos, dx, dy) => (Math.abs(dx) <= 20 && Math.abs(dy) <= 20 ? pos : o(pos, dx, dy)); return true; })()`);

// the first showing element matching `sel`, on the map's own pixels — it
// must be showing (a case that can't be set up fails)
export async function box(p, sel) {
  const b = await p.eval(`(() => { for (const e of document.querySelectorAll(${JSON.stringify(sel)})) { if (e.closest(".hidden")) continue; const r = e.getBoundingClientRect(); if (r.width && r.height) return __o.rel(r); } return null; })()`);
  check(!!b, `(${sel} showing)`);
  return b;
}

export const mapSize = (p) => p.eval(`__o.size()`);

// the map on you at the usual view; the looked-for person at screen point
// (x, y): a rider's car (drivers[0]; the other cars 20 km off) or an online
// driver's ✋ (mockHand)
export async function place(p, { x, y }, who = "car") {
  await p.eval(`(() => {
    map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: __o.steps()[0] });
    const ll = map.unproject([${x}, ${y}]);
    if (${JSON.stringify(who)} === "hand") {
      mockHand.pos = { lat: ll.lat, lng: ll.lng };
      if (mockHand.marker) mockHand.marker.setLngLat([ll.lng, ll.lat]);
    } else {
      drivers.forEach((d, i) => {
        d.pos = i === 0 ? { lat: ll.lat, lng: ll.lng } : { lat: state.me.lat + 0.18 + i * 0.01, lng: state.me.lng };
        if (d.marker) d.marker.setLngLat([d.pos.lng, d.pos.lat]);
      });
    }
    refreshWorldMarkers();
    return true;
  })()`);
  await p.waitFor(`!map.isMoving()`, "still");
}

// typing in a text box (the keyboard is up only then — the app counts its
// area only while you type): a text box made the focused element, or not
export const typing = (p, on) =>
  p.eval(on
    ? `(() => { const t = document.createElement("textarea"); Object.defineProperty(document, "activeElement", { configurable: true, get: () => t }); return true; })()`
    : `(delete document.activeElement, true)`);

// the locate button's tap — the search — traced: { trace, z, nobody, ran }
export async function search(p) {
  const before = await p.eval(`(__trace.length = 0, nearSeq)`);
  // a finger on the locate button when one can reach it; when a panel lies
  // over it (the chat, a card, a group's list — open on a phone), started
  // as it really can be then (your location arriving, ✋ up, a search
  // already under way): checked to be covered, not assumed
  const reach = await locateReachable(p);
  if (reach.ok) await p.tapAt(reach.x, reach.y);
  else {
    check(/chat|peer|pile/.test(reach.top || ""), "(the locate button under an open panel)", reach);
    await p.eval(`(findNearest(state.me), true)`);
  }
  await p.waitFor(`nearSeq > ${before}`, "the search started");
  await p.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 30000);
  return p.eval(`({ trace: __trace.slice(), z: map.getZoom(), nobody: nobodyNear })`);
}

// a finger on the locate button: at its middle, after checking the button
// is what's there (nothing over it)
export async function tapEl(p, id, { x = 0.5, y = 0.5 } = {}) {
  const at = await p.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); const b = el.getBoundingClientRect(); const px = b.left + b.width * ${x}, py = b.top + b.height * ${y}; const top = document.elementFromPoint(px, py); return { x: px, y: py, ok: !!top && el.contains(top), top: top && (top.id || String(top.className)) }; })()`);
  check(at.ok, `(${id}: what a finger there touches)`, at);
  await p.tapAt(at.x, at.y);
}

const locateReachable = (p) =>
  p.eval(`(() => { const b = document.getElementById("btn-locate").getBoundingClientRect(); const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2; const top = document.elementFromPoint(x, y); const panel = top && top.closest("#chat, #peer-card, #pile-sheet"); return { x, y, ok: !!top && document.getElementById("btn-locate").contains(top), top: panel ? panel.id : top && (top.id || String(top.className)) }; })()`);
export async function tapLocate(p) {
  const at = await locateReachable(p);
  check(at.ok, "(the locate button is what a finger there touches)", at);
  await p.tapAt(at.x, at.y);
}

// the search ends exactly where the test's own rule says, having taken
// exactly the steps up to there — `expect` worked out BEFORE the tap unless
// given (a cover that changes mid-search: worked out after)
// (`bannerMayChange`: a case that changes the banner on purpose — then it
// must be back as it was when the search ends)
export async function stopsWhereExpected(p, who, label, { expect = null, mustBe = null, bannerMayChange = false } = {}) {
  const want = expect ?? (await p.eval(`__o.stop(${JSON.stringify([who].flat())})`));
  check(want.found > 0, `(${label}: the marker is drawn)`, want);
  if (mustBe === "usual") check(want.stop === want.steps[0], `(${label}: in sight at the usual view, by the test's rule)`, want);
  if (mustBe === "further") check(want.stop !== null && want.stop < want.steps[0], `(${label}: hidden at the usual view, seen further out, by the test's rule)`, want);
  if (mustBe === "nobody") check(want.stop === null, `(${label}: never in sight, by the test's rule)`, want);
  const bannerBefore = await p.eval(`(window.__bannersFrom = __banners.length, document.getElementById("banner").textContent)`);
  const got = await search(p);
  // the banner never changed mid-search but for "nobody nearby yet" itself
  // (a message arriving would move what covers the map under the test)
  const changed = await p.eval(`__banners.slice(window.__bannersFrom).map((b) => b[0]).filter((t) => t !== ${JSON.stringify(bannerBefore)} && !t.includes("nobody nearby yet"))`);
  got.banner = [bannerBefore, await p.eval(`document.getElementById("banner").textContent`)];
  got.banners = await p.eval(`__banners.slice(-6)`);
  if (bannerMayChange) check(got.banner[1] === bannerBefore || got.banner[1].includes("nobody nearby yet"), `(${label}: the banner back as it was)`, got.banner);
  else check(changed.length === 0, `(${label}: the banner held still during the search)`, { before: bannerBefore, changed });
  const upTo = want.stop === null ? want.steps : want.steps.slice(0, want.steps.indexOf(want.stop) + 1);
  const same = got.trace.length === upTo.length && got.trace.every((z, i) => Math.abs(z - upTo[i]) < 1e-6);
  check(same, `${label}: the search took exactly the steps up to ${want.stop ?? "the widest view"}`, { trace: got.trace, upTo, want, banner: got.banner, banners: got.banners });
  if (want.stop === null) {
    check(got.nobody, `${label}: 'nobody nearby yet'`, got);
    // the words on the screen (unless the test has the banner held to a
    // long line of its own)
    const shown = await p.eval(`({ held: !!window.__setBanner && setBanner !== window.__setBanner, text: document.getElementById("banner").textContent, lang: document.documentElement.lang })`);
    if (!shown.held) {
      check(shown.lang === "en", `(${label}: the words checked in English — another language needs its own words here)`, shown);
      check(shown.text.includes("nobody nearby yet"), `${label}: 'nobody nearby yet' on the screen`, shown);
    }
  }
  else {
    check(Math.abs(got.z - want.stop) < 1e-6 && !got.nobody, `${label}: stopped at ${want.stop}`, { got, want });
    // …because it FOUND someone (watched from then on) — not merely stopped
    check(await p.eval(`foundWatch !== null`), `${label}: found (watched), not merely stopped`);
    // the browser's own word, independent of both lists: nothing over them
    const hit = await p.eval(`__o.hitCheck(${JSON.stringify([who].flat())})`);
    check(hit.ok, `${label}: on the screen, nothing but see-through over the one found (the browser's own hit test)`, hit);
  }
  return { want, got };
}

// the placed marker sits where the rule puts it (the map draws markers
// centred on their spot, to within a pixel)
export async function drawnWherePredicted(p, who = "car") {
  const d = await p.eval(`(() => { const t = __o.target(${JSON.stringify(who)}); const b = __o.drawnBox(t.el); const m = document.getElementById("map").getBoundingClientRect(); const pt = map.project([t.pos.lng, t.pos.lat]); const c = map.getCenter(); const pr = __o.point(state.me, t.pos, map.getZoom(), __o.size()); return { dx: b.cx - m.left - pr.x, dy: b.cy - m.top - pr.y, onMe: Math.abs(c.lat - state.me.lat) < 1e-9 && Math.abs(c.lng - state.me.lng) < 1e-9 }; })()`);
  check(d.onMe, "(the map centred on you)", d);
  check(Math.abs(d.dx) <= 1 && Math.abs(d.dy) <= 1, "the marker drawn where the test's own maths puts it (to a pixel)", d);
}

// spots around a cover's box (the marker's half-size `hx`/`hy`):
// inside it, or `gap` px clear of / into one side
export const inside = (b, f = 0.5) => ({ x: Math.round(b.left + (b.right - b.left) / 2), y: Math.round(b.top + (b.bottom - b.top) * f) });
export const leftOf = (b, hx, gap, y = null) => ({ x: b.left - hx - gap, y: y ?? Math.round((b.top + b.bottom) / 2) });
export const rightOf = (b, hx, gap, y = null) => ({ x: b.right + hx + gap, y: y ?? Math.round((b.top + b.bottom) / 2) });
export const below = (b, hy, gap, x = null) => ({ x: x ?? Math.round((b.left + b.right) / 2), y: b.bottom + hy + gap });
export const above = (b, hy, gap, x = null) => ({ x: x ?? Math.round((b.left + b.right) / 2), y: b.top - hy - gap });

// a spot under `sel` and nothing else (the test's rule finds one, or fails)
export async function onlyUnder(p, sel, who = "car") {
  const spot = await p.eval(`__o.onlyUnder(${JSON.stringify(sel)}, __o.drawnBox(__o.target(${JSON.stringify(who)}).el).half)`);
  check(!!spot, `(a spot under ${sel} and nothing else)`, spot);
  return spot;
}

// the looked-for marker's reach, measured: each side ({l, r, t, b}), and
// the most each way ({x, y} — a single marker's are all the same)
export const half = (p, who = "car") =>
  p.eval(`(() => { const h = __o.drawnBox(__o.target(${JSON.stringify(who)}).el).half; return { ...h, x: Math.max(h.l, h.r), y: Math.max(h.t, h.b) }; })()`);

// place `who` at `spot`, then search: expected ("usual" | "further" |
// "nobody") checked against the test's own rule first, then the app.
// `only` (a cover's selector): that cover ALONE hides the spot — without it,
// the test's rule finds them at once (so the case can't pass because
// something else covers the same spot)
export async function at(p, spot, mustBe, label, who = "car", only = null) {
  await place(p, spot, who);
  if (only) {
    const without = await p.eval(`__o.stop(${JSON.stringify([who])}, ${JSON.stringify(only)})`);
    check(without.stop === without.steps[0], `(${label}: ${only} alone hides it)`, without);
    // …and the browser's own word: that cover IS on top of it, somewhere
    // (the phone's edges and the keyboard aren't page elements: their word is
    // the test's own maths above)
    if (only !== "phone-edge" && only !== "keyboard") {
      const hid = await p.eval(`__o.coveredBy(${JSON.stringify(who)}, ${JSON.stringify(only)})`);
      check(hid.ok, `(${label}: on the screen, ${only} is on top of it)`, hid);
    }
  }
  return stopsWhereExpected(p, who, label, { mustBe });
}

// a rider with ✋ up
// (the demo's pretend driver messages you 6 s after ✋ goes up — a banner
// for a few seconds, two lines: cancelled, so no case measures a banner
// that's about to change; the search's own check below catches any other)
export async function riderLooking(p) {
  await p.click("btn-hand");
  await p.waitFor(`state.handRaised`, "✋ up");
  await p.eval(`(clearTimeout(handPingTimer), true)`);
  await p.waitFor(`!nearLooking && !map.isMoving()`, "the first search over", 20000);
}

// every line the banner shows, as long as a longer language makes it (3
// lines on a phone) — until `off()`
export const LONG = "A long line on purpose, as a longer language makes it, wrapping onto three lines on a phone so the banner reaches further down";
export const HUGE = `${LONG} — and on, and on, as no real line ever does, so that it covers a good deal more of the map than any real banner would`;
export async function longBanner(p, text = LONG) {
  await p.eval(`(() => {
    if (!window.__setBanner) window.__setBanner = setBanner;
    setBanner = () => window.__setBanner(${JSON.stringify(text)});
    setBanner();
    return true;
  })()`);
  // until it shows that text and has stopped growing
  let last = null;
  for (let i = 0; i < 40; i++) {
    const b = await p.eval(`(() => { const e = document.getElementById("banner"); return { t: e.textContent, y: e.getBoundingClientRect().bottom }; })()`);
    if (b.t.includes(text.slice(0, 30)) && last !== null && Math.abs(b.y - last) < 0.5) break;
    last = b.t.includes(text.slice(0, 30)) ? b.y : null;
    await sleep(50);
  }
  const done = await p.eval(`(() => { const e = document.getElementById("banner"); return { t: e.textContent, y: e.getBoundingClientRect().bottom }; })()`);
  check(done.t.includes(text.slice(0, 30)) && last !== null && Math.abs(done.y - last) < 0.5, "(the long banner showing, settled)", done);
  return { off: () => p.eval(`(setBanner = window.__setBanner, setBanner(contextBanner()), true)`) };
}

// at the CURRENT view (no jump), `who` moved to screen point (x, y)
export const moveTo = (p, { x, y }, who = "car") =>
  p.eval(`(() => { const ll = map.unproject([${x}, ${y}]); const t = ${JSON.stringify(who)} === "hand" ? mockHand : drivers[0]; t.pos = { lat: ll.lat, lng: ll.lng }; t.marker && t.marker.setLngLat([ll.lng, ll.lat]); refreshWorldMarkers(); return true; })()`);

// everyone far off (20 km): no step of the search shows them
export async function farAway(p, who = "car") {
  await place(p, { x: 10, y: 10 }, who);
  await p.eval(`(() => { const t = ${JSON.stringify(who)} === "hand" ? mockHand : drivers[0]; t.pos = { lat: state.me.lat + 0.2, lng: state.me.lng }; t.marker && t.marker.setLngLat([t.pos.lng, t.pos.lat]); refreshWorldMarkers(); return true; })()`);
  const want = await p.eval(`__o.stop([${JSON.stringify(who)}])`);
  // (how many steps: the cases that need several check that themselves)
  check(want.stop === null && want.steps.length >= 2, "(nobody in reach: the search would take every step)", want);
}

// everyone far off: the search ends at "nobody nearby yet"
export async function nobodyAround(p, who = "car") {
  await farAway(p, who);
  const got = await search(p);
  check(got.nobody, "(nobody around: 'nobody nearby yet')", got);
}

// only the once-a-second look can clear "nobody nearby yet" now: the
// map's own redraws stop looking (the interval keeps the real one)
export const onlyTheSecondLook = (p) => p.eval(`(window.__nearbyArrived = window.__nearbyArrived || nearbyArrived, nearbyArrived = () => {}, true)`);
export const allLooksBack = (p) => p.eval(`(window.__nearbyArrived && (nearbyArrived = window.__nearbyArrived), true)`);

// the looks counted from now
export const looksFrom = (p) => p.eval(`(__looks = 0, window.__seqFrom = nearSeq, true)`);

// a search waiting `ms` — and really waiting: it looked again and again
// meanwhile (behind a drawer every 0.25 s — NEAR_HIDDEN_MS; once a second
// for "nobody nearby yet"), not stopped
export async function keepsLooking(p, ms, label) {
  const want = Math.max(3, Math.floor(ms / 300));
  await looksFrom(p);
  // (until it has looked that many times — however slow the machine)
  await p.waitFor(`__looks >= ${want}`, `${label}: it kept looking meanwhile (${want} looks)`, ms * 10);
}

// nothing looks any more for `ms` (a search that ended is really over)
export async function looksNoMore(p, ms, label) {
  await p.eval(`(__looks = 0, window.__lookWho = [], true)`);
  await sleep(ms);
  const n = await p.eval(`({ n: __looks, who: (window.__lookWho || []).slice(0, 3) })`);
  await p.eval(`(window.__lookWho = null, true)`);
  check(n.n === 0, `(${label}: no look at all meanwhile — it's over)`, n);
}

// "nobody nearby yet" is still up after `ms` — and it really looked (at
// least `minLooks` times) meanwhile, not just a quiet clock
export async function staysNobody(p, ms, label, minLooks = 2) {
  await looksFrom(p);
  const t0 = Date.now();
  // (at least `ms`, and until it has looked `minLooks` times — however slow
  // the machine; checked all the while)
  while (Date.now() - t0 < ms || (await p.eval(`__looks`)) < minLooks) {
    check(await p.eval(`nobodyNear`), `${label}: 'nobody nearby yet' stays`);
    check(Date.now() - t0 < ms * 10, `(${label}: it never looked ${minLooks} times)`, await p.eval(`__looks`));
    await sleep(250);
  }
}

// "nobody nearby yet" clears — by the first or second look after the change
// (counted from looksFrom(), called before the change), however slow the
// clock (`ms`: only a far ceiling)
export async function clearsWithin(p, ms, label, maxLooks = 2) {
  await p.waitFor(`!nobodyNear`, `${label}: 'nobody nearby yet' clears`, Math.max(ms, 8000));
  const n = await p.eval(`__looks`);
  check(n <= maxLooks + 1, `${label}: cleared by the first or second look after it`, n);
  // …because someone came into sight (they're watched now) — not because
  // something ended the search (a move, a new search)
  const why = await p.eval(`({ watched: foundWatch !== null, seq: nearSeq, from: window.__seqFrom })`);
  check(why.watched && why.seq === why.from, `${label}: cleared by someone in sight (watched; no other search)`, why);
}

// the map stopped at the FIRST step that shows person `id` (a real
// account's marker), by the test's own rule: in sight on this step, not on
// the step before it
export async function firstStepShowing(p, id) {
  await oracle(p);
  return p.eval(`(() => {
    const steps = __o.steps();
    const z = map.getZoom();
    const i = steps.findIndex((s) => Math.abs(s - z) < 1e-6);
    const t = __o.target(${JSON.stringify(id)});
    if (!t) return { z, steps, i, ok: false, why: "not drawn" };
    const half = __o.drawnBox(t.el).half, s = __o.size(), cs = __o.covers();
    const seen = (zz) => __o.clear(__o.point(state.me, t.pos, zz, s), half, s, cs);
    return { z, steps, i, now: seen(z), before: i > 0 && seen(steps[i - 1]), ok: i > 0 && seen(z) && !seen(steps[i - 1]) };
  })()`);
}

// person `id` (a real account's marker) in sight where the map is now, by
// the test's own rule
export async function inSightNow(p, id) {
  await oracle(p);
  return p.eval(`__o.seenNow(${JSON.stringify(id)})`);
}
