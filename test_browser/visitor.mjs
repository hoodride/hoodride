// The front door (owner, 2026-10-30): the signed-out screen (Google, the
// privacy policy, 18+), signing in from it, and the demo (?demo=1) — the
// pretend world a visitor can try without an account.
import { journey, step, check, BASE } from "./cdp.mjs";
import { bannerIs, bannerLike, bannerHasCar, showsCar, typeText, send } from "./app.mjs";

const visible = (id) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.classList.contains("hidden") && e.offsetParent !== null; })()`;
// the GitHub mark inside `where`, as the page shows it: the picture drawn
// (loaded) at its size, linking to the code in a new tab, with a label
const sourceLink = (where) => `(() => { const a = document.querySelector(${JSON.stringify(where)} + " a.source-link"); const i = a && a.querySelector("img"); if (!a || !i) return null; const r = i.getBoundingClientRect(); return { href: a.href, target: a.target, rel: a.rel, label: a.title, drawn: i.complete && i.naturalWidth > 0, size: Math.round(r.height) }; })()`;
const SOURCE = (size) => ({ href: "https://github.com/hoodride/hoodride", target: "_blank", rel: "noopener", label: "Source code on GitHub", drawn: true, size });

await journey("visitor: the signed-out screen, signing in, the demo", async (browser) => {
  step("Vic opens Hood Ride signed out: Continue with Google, Facebook only if offered, the Terms and the privacy policy");
  const vic = await browser.visitor("BT-Vic");
  await vic.goto(`${BASE}/`);
  await vic.waitFor(visible("auth-buttons"), "the sign-in buttons");
  // signed out the page stays zoomable (low vision); the map screen won't zoom
  const zoom = (p) => p.eval(`[getComputedStyle(document.documentElement).touchAction, getComputedStyle(document.body).touchAction]`);
  check(JSON.stringify(await zoom(vic)) === JSON.stringify(["auto", "auto"]), "the sign-in screen: zoomable", await zoom(vic));
  check(await vic.eval(visible("btn-google")), "Continue with Google shown");
  check(await vic.eval(`(() => { const i = document.querySelector("img.brand-car"); return !!i && i.complete && i.naturalWidth === 384; })()`), "the logo: the car picture, loaded");
  // the car tucked close above the name (the Terms screen matches: terms journey)
  const gap = await vic.eval(`(() => { const i = document.querySelector("img.brand-car").getBoundingClientRect(); const h = document.querySelector(".brand h1").getBoundingClientRect(); return Math.round(h.top - i.bottom); })()`);
  check(gap === -2, "the car right above the name", gap);
  // Facebook only where the server offers it (on hoodride.app it has no keys:
  // hidden; with the dev sign-in, as here, it's offered)
  const offered = await vic.eval(`document.querySelector('meta[name="hoodride-providers"]').content`);
  check((await vic.eval(visible("btn-facebook"))) === offered.includes("facebook"), "Facebook shown only if offered", offered);
  const fine = await vic.eval(`document.querySelector(".fineprint").textContent`);
  check(fine === "By continuing, you agree to our Terms and Privacy Policy.", "the Terms and the privacy policy", fine);
  check(!(await vic.eval(`typeof state !== "undefined" && !!state.realUser`)), "nobody signed in");
  // the code is public (owner, 2026-11-04): GitHub's mark below the line —
  // drawn, small (smaller than the car), centered, below the text, not over it
  check(JSON.stringify(await vic.eval(sourceLink(".source-login"))) === JSON.stringify(SOURCE(20)), "GitHub's mark: the code, in a new tab", await vic.eval(sourceLink(".source-login")));
  // and Discord's beside it (owner, 2026-11-04): the pair centred as one,
  // 24 px apart, both below the text, much smaller than the car
  const marks = await vic.eval(`(() => { const [g, d] = [...document.querySelectorAll(".source-login img")].map((i) => i.getBoundingClientRect()), f = document.querySelector(".fineprint").getBoundingClientRect(), car = document.querySelector("img.brand-car").getBoundingClientRect(); return { below: Math.min(g.top, d.top) >= f.bottom, centered: Math.abs((g.left + d.right) / 2 - innerWidth / 2) <= 1, apart: Math.round(d.left - g.right), onScreen: Math.max(g.bottom, d.bottom) <= innerHeight, smaller: Math.max(g.height, d.height) < car.height / 3 }; })()`);
  check(marks.below && marks.centered && marks.apart >= 24 && marks.onScreen && marks.smaller, "GitHub and Discord: below the line, centered as a pair, 24 px apart, on screen, much smaller than the car", marks);
  const signInDiscord = await vic.eval(`(async () => { const a = document.querySelectorAll(".source-login a.source-link")[1]; const i = a && a.querySelector("img"); if (!i) return null; await i.decode(); const c = document.createElement("canvas"); c.width = 78; c.height = 60; const x = c.getContext("2d"); x.drawImage(i, 0, 0, 78, 60); const d = x.getImageData(0, 0, 78, 60).data; let white = 0; for (let k = 0; k < d.length; k += 4) if (d[k+3] > 200) white = Math.max(white, Math.min(d[k], d[k+1], d[k+2])); return { href: a.href, target: a.target, label: a.title, size: Math.round(i.getBoundingClientRect().height), white }; })()`);
  check(JSON.stringify(signInDiscord) === JSON.stringify({ href: "https://discord.gg/ehce7eGQFt", target: "_blank", label: "Hood Ride on Discord", size: 20, white: 255 }), "the sign-in page's Discord symbol: the invite, a new tab, drawn white", signInDiscord);

  // (fully loaded before moving on: a link's page finishing later would
  // count as the next goto's load)
  step("the Terms and the privacy policy open from there");
  await vic.eval(`document.querySelector('.fineprint a[href="/terms"]').click(), true`);
  await vic.waitFor(`location.pathname === "/terms" && document.readyState === "complete" && document.querySelector("h1").textContent === "Terms of Use"`, "the Terms page");
  await vic.goto(`${BASE}/`);
  await vic.waitFor(`!document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in screen again");
  await vic.eval(`document.querySelector('.fineprint a[href="/privacy"]').click(), true`);
  await vic.waitFor(`location.pathname === "/privacy" && document.readyState === "complete" && document.querySelector("h1").textContent === "Privacy Policy"`, "the privacy page");

  step("Continue with Google: on hoodride.app it goes to Google; on this machine it signs in by name");
  await vic.goto(`${BASE}/`);
  await vic.waitFor(visible("btn-google"), "the button");
  check((await vic.eval(`HoodSession.loginRoute("hoodride.app")`)) === "google", "hoodride.app → Google");
  await vic.eval(`localStorage.setItem("hoodride_dev_name", "BT-Vic"), true`);
  // every screen this page shows, in order — a reload would wipe the list
  // (owner, 2026-11-04: the map flashed before the Terms, then a reload)
  await vic.eval(`(() => { window.__screens = []; const rec = () => { const a = [...document.querySelectorAll(".screen.active")].map((e) => e.id).join(","); if (window.__screens[window.__screens.length - 1] !== a) window.__screens.push(a); }; rec(); new MutationObserver(rec).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] }); return true; })()`);
  await vic.click("btn-google");
  // a new account: "Before you start" first (the terms journey covers it)
  await vic.waitFor(`document.getElementById("screen-terms").classList.contains("active")`, "the Terms screen", 15000);
  await vic.click("btn-agree");
  await vic.waitFor(`!!state.realUser && state.realUser.name === "BT-Vic" && liveNow()`, "signed in as BT-Vic, connected", 15000);
  const screens = await vic.eval(`window.__screens || "the page reloaded"`);
  check(JSON.stringify(screens) === JSON.stringify(["screen-login", "screen-terms", "screen-map"]), "sign-in → Terms → map: never the map before agreeing, no reload", screens);
  check(JSON.stringify(await zoom(vic)) === JSON.stringify(["pan-x pan-y", "pan-x pan-y"]), "the map screen: the page itself can't zoom", await zoom(vic));

  step("the link preview: the page's Open Graph tags, and its picture loads at 1200×630");
  // (owner, 2026-11-02: what a shared link shows — Facebook, iMessage, WhatsApp, X…)
  const og = await vic.eval(`(() => { const m = (k) => { const e = document.querySelector('meta[property="' + k + '"], meta[name="' + k + '"]'); return e && e.content; }; return { title: m("og:title"), description: m("og:description"), url: m("og:url"), image: m("og:image"), w: m("og:image:width"), h: m("og:image:height"), card: m("twitter:card") }; })()`);
  check(og.title === "Hood Ride" && og.description === "Rides from your neighborhood", "the name and its line", og);
  // full addresses, at the server's PUBLIC address (its config — hoodride.app
  // live), not whatever address this test reached it by
  check(/^https?:\/\/[^/]+\/$/.test(og.url) && og.image && og.image.startsWith(og.url + "og.png?vsn="), "full addresses: the front page, the versioned picture", og);
  og.image = BASE + new URL(og.image).pathname + new URL(og.image).search; // fetched from this test server
  check(og.w === "1200" && og.h === "630" && og.card === "summary_large_image", "the picture's size; X's large card", og);
  const shown = await vic.eval(`new Promise((ok) => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok("didn't load"); i.src = ${JSON.stringify(og.image)}; })`);
  check(JSON.stringify(shown) === "[1200,630]", "the picture loads, 1200×630", shown);

  step("a typo address: a real 404 and 'Page not found', the address as typed; its button: the map, connected");
  // (owner, 2026-11-02: it used to show the map silently)
  check((await vic.eval(`fetch("/a-typo").then((r) => r.status)`)) === 404, "the server says 404");
  await vic.goto(`${BASE}/a-typo`);
  check((await vic.eval(`document.querySelector("h1") && document.querySelector("h1").textContent`)) === "Page not found", "it says 'Page not found'");
  check(await vic.eval(`location.pathname === "/a-typo" && typeof state === "undefined"`), "the address as typed, and not the app");
  check(await vic.eval(`(() => { const i = document.querySelector("main img"); return !!i && i.complete && i.naturalWidth > 0; })()`), "the car picture shows");
  // a little air under the car, looser than the sign-in screen's -2 px (owner, 2026-11-02: kept)
  const nfGap = await vic.eval(`(() => { const i = document.querySelector("main img").getBoundingClientRect(); const h = document.querySelector("main h1").getBoundingClientRect(); return Math.round(h.top - i.bottom); })()`);
  check(nfGap === 19, "the car a little above 'Page not found' (19 px, as the owner kept it)", nfGap);
  check(await vic.eval(`(() => { const a = document.querySelector("a.home"); const r = a && a.getBoundingClientRect(); return !!a && r.width > 0 && getComputedStyle(a).backgroundColor === "rgb(255, 193, 7)"; })()`), "a yellow 'Go to Hood Ride' button");
  await vic.eval(`document.querySelector("a.home").click(), true`);
  await vic.waitFor(`location.pathname === "/" && typeof state !== "undefined" && !!state.realUser && liveNow() && !!map`, "its button: the map, signed in and connected", 15000);

  step("Dee tries the demo: a pretend world, nothing sent to the server");
  // her browser would say she's in London (permission granted) — the demo
  // never asks (owner, 2026-11-02: no location prompt in a demo): its
  // pretend world is around its own fixed spot, not her
  const dee = await browser.visitor("BT-Dee", { latitude: 51.5074, longitude: -0.1278 });
  await dee.goto(`${BASE}/?demo=1`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 0`, "the demo's pretend drivers", 15000);
  check(await dee.eval(`!state.realUser && !socket`), "no account, no connection");
  // (past the old 12 s location wait: nothing changes)
  await new Promise((r) => setTimeout(r, 2000));
  const around = await dee.eval(`({ me: [state.me.lat, state.me.lng], fix: state.haveFix, far: Math.max(...drivers.map((d) => metersBetween(DEFAULT_POS, d.pos))) })`);
  check(around.me[0] === 40.7128 && around.me[1] === -74.006 && !around.fix, "the demo's own spot, not her location", around);
  check(around.far < 1500, "its pretend cars around that spot", around);
  check(!(await dee.banner()).includes("location"), "no location message", await dee.banner());

  step("the demo zoomed out, as the real app: counted hexagons, then 'Zoom in to see who's around', then the cars again");
  // (owner, 2026-11-02: the demo showed every car at every zoom)
  // zoom out from Dee's spot until the ladder steps down a level
  const levelAt = async (z) => {
    await dee.eval(`map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: ${z} }), true`);
    return dee.waitFor(`map.getZoom() === ${z} && !map.isMoving() ? { res: demoPlan ? demoPlan.res : "floor" } : null`, `the level at zoom ${z}`);
  };
  // the hexagons' numbers on screen (the layer appears with the first hexagon)
  await dee.eval(`window.hexLabels = () => (map.getLayer("agg-label") ? map.queryRenderedFeatures({ layers: ["agg-label"] }) : []), true`);
  let hexZoom = null, floorZoom = null;
  for (let z = 14; z >= 1 && floorZoom === null; z -= 0.5) {
    const { res } = await levelAt(z);
    if (res !== 8 && res !== "floor" && hexZoom === null) hexZoom = z;
    if (res === "floor") floorZoom = z;
  }
  check(hexZoom !== null && floorZoom !== null && floorZoom < hexZoom, "the ladder: hexagons, then the floor further out", { hexZoom, floorZoom });

  await levelAt(hexZoom);
  // each number on screen = the pretend cars inside that hexagon. Not "the
  // numbers add up to every car": a car up to ~1 km out can sit in a hexagon
  // whose centre (where its number is drawn) is just off screen — that
  // failed now and then (gate, 2026-11-03). The cars drift each tick, so
  // both sides are read in the same moment.
  const hexCheck = `(() => {
    const f = hexLabels();
    if (!demoPlan || f.length === 0) return null;
    const res = demoPlan.res;
    const inCell = (c) => drivers.filter((d) => h3.latLngToCell(d.pos.lat, d.pos.lng, res) === c).length;
    const shown = f.map((x) => { const [lng, lat] = x.geometry.coordinates; const c = h3.latLngToCell(lat, lng, res); return { shown: Number(x.properties.label), cars: inCell(c) }; });
    return shown.every((s) => s.shown === s.cars && s.cars > 0) ? shown : null;
  })()`;
  // on a miss, say WHY (it failed once under a fully loaded CPU, 2026-11-04,
  // with only "null"): the level, how many numbers were drawn, and each
  // number against the cars really inside its hexagon
  const hexWhy = `(() => {
    const f = hexLabels();
    const res = demoPlan && demoPlan.res;
    const inCell = (c) => drivers.filter((d) => h3.latLngToCell(d.pos.lat, d.pos.lng, res) === c).length;
    // what's drawn vs what's there: the hex shapes, the numbers' data, and
    // the map font the numbers need (fetched from the map server on first use)
    const src = map.getSource("agg-label-src");
    const fonts = performance.getEntriesByType("resource").filter((e) => /\\/fonts\\//.test(e.name)).map((e) => ({ font: decodeURIComponent(e.name.split("/fonts/")[1] || ""), ms: Math.round(e.duration), status: e.responseStatus }));
    return { res, zoom: map.getZoom(), moving: map.isMoving(), tilesLoaded: map.areTilesLoaded(), styleLoaded: map.isStyleLoaded(),
      shapes: map.getLayer("agg-fill") ? map.queryRenderedFeatures({ layers: ["agg-fill"] }).length : "no layer",
      numbersData: src && src._data && src._data.features ? src._data.features.length : "no source",
      fonts, drawn: f.length, cars: drivers.length,
      labels: f.map((x) => { const [lng, lat] = x.geometry.coordinates; return { shown: Number(x.properties.label), cars: res ? inCell(h3.latLngToCell(lat, lng, res)) : null }; }) };
  })()`;
  // the numbers are text in the map's bold font, fetched from the map server
  // on first use: until it arrives none can be drawn (shapes and data are
  // there). Proven 2026-11-04 by holding that font back (delayRequests):
  // "drawn: 0" exactly as the occasional failure on a busy machine. So:
  // wait for the font first (a slow download isn't the app's fault), then
  // the numbers must be right
  await dee.waitFor(`performance.getEntriesByType("resource").some((e) => /\\/fonts\\/Noto(%20| )Sans(%20| )Bold\\//.test(e.name))`, "the map's bold font arrived", 20000);
  const counted = await dee.waitFor(hexCheck, "each hexagon counts the pretend cars inside it", 5000).catch(async (e) => {
    throw new Error(`${e.message.split("\n")[0]}\n  hexagons: ${JSON.stringify(await dee.eval(hexWhy).catch((x) => String(x.message)))}`);
  });
  check(counted.reduce((s, x) => s + x.shown, 0) > 0, "the hexagons count the pretend cars", counted);
  check(await dee.eval(`drivers.every((d) => !d.visible) && document.querySelectorAll(".maplibregl-marker .marker-car").length === 0`), "no car markers among the hexagons");

  // a tap on a hexagon dives in, as in the real app
  const hex = await dee.eval(`(() => { const f = hexLabels()[0]; const p = map.project(f.geometry.coordinates); return { x: Math.round(p.x), y: Math.round(p.y), z: map.getZoom() }; })()`);
  await dee.tapAt(hex.x, hex.y);
  await dee.waitFor(`map.getZoom() > ${hex.z + 1} && !map.isMoving()`, "a tapped hexagon zooms in", 5000);

  await levelAt(floorZoom);
  await bannerIs(dee, "Zoom in to see who's around");
  // (the map takes a frame to redraw: a wait, then why if it never clears)
  await dee.waitFor(`hexLabels().length === 0 && drivers.every((d) => !d.visible)`, "at the floor: no hexagons, no cars", 5000).catch(async (e) => {
    throw new Error(e.message + "\n  floor: " + (await dee.eval(`JSON.stringify({ labels: hexLabels().length, aggData: aggData.size, demoPlan: demoPlan && demoPlan.res, carsShown: drivers.filter((d) => d.visible).length, zoom: map.getZoom() })`)));
  });

  await levelAt(15);
  await dee.waitFor(`drivers.every((d) => d.visible)`, "close in: the cars again", 5000);
  check(await dee.eval(`aggData.size === 0 && hexLabels().length === 0`), "and no hexagons");

  step("✋ in the demo: up, and a pretend driver writes");
  await dee.click("btn-hand");
  await bannerIs(dee, "✋ Nearby drivers can see you need a ride");
  // (an object: the first driver is number 0, which a wait reads as "not yet")
  const { i: driver } = await dee.waitFor(
    `(() => { for (const [p, c] of chats) if (c.msgs.some((m) => m.text === "yo, saw your hand ✋ need a pickup?")) return { i: drivers.indexOf(p) }; return null; })()`,
    "a pretend driver's message",
    15000
  );
  check(driver >= 0, "from one of the pretend drivers", driver);

  step("Dee answers: a pretend reply");
  await dee.eval(`openChat(drivers[${driver}]), true`);
  await typeText(dee, "hi!");
  await send(dee);
  await dee.waitFor(`chatFor(drivers[${driver}]).msgs.filter((m) => !m.mine).length >= 2`, "a reply", 5000);

  step("Dee closes the chat and cancels Need a ride: the chat stays, and so does its button (as in the real app)");
  await dee.click("chat-close");
  await dee.click("btn-hand");
  await dee.waitFor(`!state.handRaised`, "the hand down");
  check(await dee.eval(`chats.has(drivers[${driver}]) && chatFor(drivers[${driver}]).msgs.length >= 3`), "the chat and its messages kept");
  check(await dee.eval(`!document.getElementById("btn-chat").classList.contains("hidden")`), "the chat button still there");
  await dee.click("btn-hand");
  await dee.waitFor(`state.handRaised`, "the hand up again");
  await dee.click("btn-chat");
  await dee.waitFor(`state.chatPeer === drivers[${driver}] && !document.getElementById("chat").classList.contains("hidden")`, "the chat opens from its button");

  step("Dee asks for a ride: accepted, on the way; then ends it");
  await dee.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await dee.click("btn-ride-action");
  await dee.waitFor(`state.ride && state.ride.status === "connected"`, "accepted", 5000);
  const name = await dee.eval(`drivers[${driver}].name`);
  await bannerLike(dee, `${name} is on the way`);
  await bannerHasCar(dee);
  await dee.click("btn-endride");
  await dee.waitFor(`!state.ride`, "ended");

  step("Dee drives in the demo: online, the pretend ✋ is there at once, no 'Someone nearby' banner — as the real app");
  // (owner, 2026-11-02: it waited 5 s, with a banner the real app doesn't have)
  await dee.click("btn-mode");
  await dee.waitFor(`state.mode === "driver"`, "Drive mode");
  for (const round of ["online", "online again"]) {
    await dee.click("btn-online");
    await dee.waitFor(`state.online && !!mockHand && mockHand.visible`, `${round}: the ✋ at once`, 1500);
    check(!(await dee.banner()).includes("Someone nearby"), `${round}: no 'Someone nearby' banner`, await dee.banner());
    await dee.click("btn-online"); // offline: the ✋ goes
    await dee.waitFor(`!state.online && !mockHand`, `${round}: offline, the ✋ gone`);
  }

  step("Dee picks up the pretend ✋: it stays on her map as 🙋 at the rider's exact spot, and Navigate goes there");
  // (owner, 2026-11-02: the demo's own "hide the ✋ mid-ride" rule removed
  // the 🙋 just placed; and one pretend rider showed as 💃)
  await dee.click("btn-online");
  await dee.waitFor(`state.online && !!mockHand && mockHand.visible`, "the ✋ again");
  await dee.eval(`(window.__rider = mockHand, openChat(mockHand)), true`);
  await typeText(dee, "need a lift?");
  await send(dee);
  await dee.waitFor(`__rider.pending && document.getElementById("btn-ride-action").textContent === "Accept ride"`, "the rider asks: Accept ride", 5000);
  await dee.click("btn-ride-action");
  await dee.waitFor(`state.ride && state.ride.status === "connected" && state.ride.peer === __rider`, "in the ride");
  // past a few world ticks: the browse rule runs on each
  await new Promise((r) => setTimeout(r, 3500));
  const onMap = await dee.eval(`(() => { const m = __rider.marker, el = m && m.getElement(); const ll = m && m.getLngLat(); return { shown: !!(m && m._map), person: !!(el && el.querySelector('img[src^="person.svg"]')), atExact: !!ll && Math.abs(ll.lat - __rider.exactPos.lat) < 1e-9 && Math.abs(ll.lng - __rider.exactPos.lng) < 1e-9 }; })()`);
  check(onMap.shown && onMap.person && onMap.atExact, "🙋 on the map, at the rider's exact spot", onMap);
  // Navigate: the first time asks the app — Google Maps' link goes to that spot
  await dee.eval(`(() => { const a = document.getElementById("btn-navigate"); const stop = (e) => e.preventDefault(); a.addEventListener("click", stop); a.click(); a.removeEventListener("click", stop); return true; })()`);
  await dee.waitFor(`!document.getElementById("nav-sheet").classList.contains("hidden")`, "the map-app box");
  const to = await dee.eval(`document.getElementById("nav-google").href`);
  const exact = await dee.eval(`__rider.exactPos`);
  check(to === `https://www.google.com/maps/dir/?api=1&destination=${exact.lat}%2C${exact.lng}`, "Navigate: to the rider's exact spot, not the block centre", { to, exact });
  await dee.click("nav-cancel");
  // whoever is picked up shows as 🙋 — the other pretend rider's own emoji
  // (💃) too
  check(await dee.eval(`(() => { const p = { emoji: "💃", pos: state.me }; materializeRiderMarker(p); const ok = !!p.marker.getElement().querySelector('img[src^="person.svg"]'); p.marker.remove(); return ok; })()`), "any rider picked up: 🙋");
  await dee.click("btn-endride");
  await dee.waitFor(`!state.ride`, "the ride ended");
  check(await dee.eval(`!socket`), "still nothing sent to the server");

  step("Dee leaves the demo from Settings: the sign-in page, nothing sent to the server");
  // (owner, 2026-11-02: "Sign out" did nothing in the demo — no account)
  await dee.click("btn-account");
  await dee.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "Settings open");

  // Your car, in the demo too (owner, 2026-11-13): the same form and checks,
  // kept on this page only — nothing sent to the server
  await dee.eval(`(() => { window.__apiCalls = []; const f = window.fetch; window.fetch = (u, ...a) => { if (String(u).includes("/api/")) window.__apiCalls.push(String(u)); return f(u, ...a); }; return true; })()`);
  check(await dee.eval(`getComputedStyle(document.getElementById("btn-car")).display !== "none"`), "Your car is in the demo's menu");
  check((await dee.eval(`document.getElementById("car-note").textContent`)) === "Add it before you drive", "no car yet", await dee.eval(`document.getElementById("car-note").textContent`));
  await dee.click("btn-car");
  await dee.waitFor(`carSheetOpen()`, "the car form");
  await dee.eval(`(() => { document.getElementById("car-color").value = "Blue"; document.getElementById("car-make").value = "Honda"; document.getElementById("car-model").value = ""; return true; })()`);
  await dee.click("car-save");
  await dee.waitFor(`!document.getElementById("car-error").classList.contains("hidden")`, "the same checks: the model is missing");
  check(await dee.eval(`carSheetOpen()`), "the form stays open to fix it");
  await dee.eval(`(document.getElementById("car-model").value = "Civic", true)`);
  await dee.click("car-save");
  await dee.waitFor(`!carSheetOpen()`, "saved: the form closes");
  const note = await dee.eval(`document.getElementById("car-note").textContent`);
  check(note.includes("Honda Civic"), "Settings shows the car", note);
  check(await dee.eval(`state.myCar && state.myCar.model === "Civic"`), "kept on the page");
  check((await dee.eval(`window.__apiCalls.length`)) === 0 && (await dee.eval(`!socket`)), "nothing sent to the server", await dee.eval(`window.__apiCalls`));

  const row = await dee.eval(`({ label: document.querySelector("#btn-logout .settings-label").textContent, note: document.getElementById("logout-note").textContent, enabled: !document.getElementById("btn-logout").disabled, del: getComputedStyle(document.getElementById("delete-wrap")).display, legal: document.querySelector(".drawer-legal").innerText.trim() })`);
  check(row.label === "Leave demo" && row.note === "Back to the sign-in page" && row.enabled, "the row: Leave demo, back to the sign-in page", row);
  check(row.del === "none" && row.legal === "Terms · Privacy Policy", "no Delete account (no account): just Terms · Privacy Policy", row);
  // the GitHub mark in the menu too, on its own line: drawn, small (the
  // text's size), the repo in a new tab
  check(JSON.stringify(await dee.eval(sourceLink(".drawer-source"))) === JSON.stringify(SOURCE(16)), "the menu's GitHub mark: the code, in a new tab", await dee.eval(sourceLink(".drawer-source")));
  // and Discord's, beside it (the menu only): the invite, a new tab, drawn
  // WHITE — its file colours itself with a <style> the page's rules must
  // not block (it would draw black, unseen on the dark menu)
  const discord = await dee.eval(`(async () => { const a = document.querySelectorAll(".drawer-source a.source-link")[1]; const i = a && a.querySelector("img"); if (!i) return null; await i.decode(); const c = document.createElement("canvas"); c.width = 63; c.height = 48; const x = c.getContext("2d"); x.drawImage(i, 0, 0, 63, 48); const d = x.getImageData(0, 0, 63, 48).data; let white = 0; for (let k = 0; k < d.length; k += 4) if (d[k+3] > 200) white = Math.max(white, Math.min(d[k], d[k+1], d[k+2])); return { href: a.href, target: a.target, rel: a.rel, label: a.title, size: Math.round(i.getBoundingClientRect().height), white }; })()`);
  check(JSON.stringify(discord) === JSON.stringify({ href: "https://discord.gg/ehce7eGQFt", target: "_blank", rel: "noopener", label: "Hood Ride on Discord", size: 16, white: 255 }), "the menu's Discord symbol: the invite, a new tab, drawn white", discord);
  // any sign-out request would be noted where it outlives the page change
  await dee.eval(`(() => { const f = window.fetch; window.fetch = (u, ...a) => { if (String(u).includes("/api/")) sessionStorage.setItem("demo_api_call", String(u)); return f(u, ...a); }; return true; })()`);
  await dee.click("btn-logout");
  await dee.waitFor(`location.pathname === "/" && location.search === "" && typeof DEMO !== "undefined" && !DEMO && document.getElementById("screen-login").classList.contains("active") && !document.getElementById("auth-buttons").classList.contains("hidden")`, "the sign-in page, Continue with Google", 15000);
  check((await dee.eval(`sessionStorage.getItem("demo_api_call")`)) === null, "no request sent while leaving", await dee.eval(`sessionStorage.getItem("demo_api_call")`));

  // the chat on a wide screen (owner, 2026-11-04): at most 640 px, centered
  // — lines of ~60 characters, not ~150 across a desktop; a phone keeps
  // it full width (Material 3's bottom sheets cap at 640dp)
  step("Wes opens the demo's chat on a desktop, then on a phone: 640 px centered, then full width");
  const wes = await browser.visitor("BT-Wes");
  const chatBox = `(() => { const r = document.getElementById("chat").getBoundingClientRect(); return { width: Math.round(r.width), left: Math.round(r.left), right: Math.round(innerWidth - r.right) }; })()`;
  for (const [w, h, scale, want] of [
    [1440, 900, 1, { width: 640, left: 400, right: 400 }],
    [390, 780, 2, { width: 390, left: 0, right: 0 }],
  ]) {
    await wes.phone(w, h, scale);
    await wes.goto(`${BASE}/?demo=1`);
    await wes.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && drivers.length > 0`, `${w} px: the demo`, 15000);
    await wes.eval(`openMarkerCard(drivers[0], "driver"), true`);
    await wes.click("btn-msg");
    await wes.waitFor(`!document.getElementById("chat").classList.contains("hidden")`, `${w} px: the chat`);
    check(JSON.stringify(await wes.eval(chatBox)) === JSON.stringify(want), `${w} px wide: the chat ${want.width} px, ${want.left} px either side`, await wes.eval(chatBox));
  }

  // a letter avatar's letter in the middle of its circle (owner, 2026-11-04:
  // the "D" sat ~5% low — "central" centered the font's whole box); drawn
  // in this browser, its white ink measured against the 96×96 picture
  step("the letter avatars: each capital in the middle of its circle");
  const inkCenter = (name) => `(async () => {
    const i = new Image(); i.src = HoodAvatar.url(${JSON.stringify(name)}); await i.decode();
    const c = document.createElement("canvas"); c.width = c.height = 96;
    const x = c.getContext("2d"); x.drawImage(i, 0, 0, 96, 96);
    const d = x.getImageData(0, 0, 96, 96).data; let t = 96, b = -1, l = 96, r = -1;
    for (let y = 0; y < 96; y++) for (let k = 0; k < 96; k++) { const o = (y * 96 + k) * 4; if (d[o] > 230 && d[o + 1] > 230 && d[o + 2] > 230) { t = Math.min(t, y); b = Math.max(b, y); l = Math.min(l, k); r = Math.max(r, k); } }
    return { name: ${JSON.stringify(name)}, down: (t + b) / 2 - 47.5, right: (l + r) / 2 - 47.5 };
  })()`;
  // (plain capitals: an accent above, as in Ö, rightly lifts the ink)
  for (const name of ["Dan", "Jaylen", "Eve", "Maria", "Zoe"]) {
    const at = await wes.eval(inkCenter(name));
    check(Math.abs(at.down) <= 2 && Math.abs(at.right) <= 3, `${name}: the letter centered (within 2 of 96 up/down)`, at);
  }
  await wes.close();
});
