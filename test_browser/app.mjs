// Hood Ride steps for the browser journeys: what a person does, done the way
// the app does it (a marker tap = openMarkerCard, then the real buttons).
import { check } from "./cdp.mjs";

const q = JSON.stringify;

// a button's look. GO ONLINE: yellow before the tap, dark once you're
// live. Need a ride: dark both times (the ✋ is yellow — on yellow it
// vanished; owner, 2026-11-01), and once raised a yellow ring and yellow
// words say you're waiting
export const YELLOW = "rgb(255, 193, 7)";
export const DARK = "rgb(29, 29, 31)";
export const WHITE = "rgb(245, 245, 245)";
export const ink = (p, id) => p.eval(`getComputedStyle(document.getElementById(${q(id)})).color`);
export const ring = (p, id) => p.eval(`getComputedStyle(document.getElementById(${q(id)})).boxShadow.startsWith("rgb(255, 193, 7) 0px 0px 0px 3px")`);
// the 📍 on a button while it finds your location (owner, 2026-11-01): it
// pulses only after 1 s. "no pin", "still" (no pulse), "waiting" (its 1 s
// not up yet) or "pulsing"
export const pinPulse = (p, id) =>
  p.eval(`(() => {
    const i = document.querySelector(${q(`#${id} img[data-emoji="\u{1F4CD}"]`)});
    if (!i) return "no pin";
    const a = i.getAnimations().filter((x) => x.animationName === "seeking");
    if (!a.length) return "still";
    return a[0].effect.getComputedTiming().progress === null ? "waiting" : "pulsing";
  })()`);
// nothing on the button pulses (any picture on it)
export const noPulse = (p, id) =>
  p.eval(`document.getElementById(${q(id)}).getAnimations({ subtree: true }).every((x) => x.animationName !== "seeking")`);
export const fill = (p, id) => p.eval(`getComputedStyle(document.getElementById(${q(id)})).backgroundColor`);

// a driver with a car, online (the browser's location is the home block)
export async function goOnline(p, car = { color: "Blue", make: "Toyota", model: "Prius" }) {
  const saved = await p.eval(
    `fetch("/api/car", {method: "POST", headers: {"content-type": "application/json"}, body: ${q(JSON.stringify(car))}}).then(r => r.ok)`
  );
  check(saved, `${p.name}: car saved`);
  // a fresh page reads the car again (state.myCar)
  await p.open();
  if ((await p.eval("state.mode")) !== "driver") await p.click("btn-mode");
  await p.waitFor(`state.mode === "driver" && state.myCar !== undefined`, `${p.name}: driver mode, car known`);
  check((await fill(p, "btn-online")) === YELLOW, `${p.name}: GO ONLINE is yellow`, await fill(p, "btn-online"));
  await p.click("btn-online");
  await p.waitFor("state.online", `${p.name}: online`);
  check((await fill(p, "btn-online")) === DARK, `${p.name}: GO OFFLINE is dark`, await fill(p, "btn-online"));
}

// someone's marker is on this person's map (the server sent it)
export async function sees(p, id, what = "on the map") {
  await p.waitFor(`realPeersById.has(${id}) && realEntries.has(${id})`, `${p.name} sees #${id} ${what}`, 15000);
}

// tap their marker, then Message: the chat with them is open
// (if the name never comes, the failure says why: the banners shown since
// the tap — a failed reveal closes the card with a short-lived reason —
// and what the card and the person look like now)
export async function openChatWith(p, id, type = "driver") {
  await p.eval(`(() => {
    window.__cardBanners = [];
    const b = document.getElementById("banner");
    new MutationObserver(() => b.textContent && window.__cardBanners.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    openMarkerCard(realPeersById.get(${id}), ${q(type)});
    return true;
  })()`);
  try {
    await p.waitFor(`!document.getElementById("peer-card").classList.contains("hidden") && !document.getElementById("btn-msg").disabled`, `${p.name}: the card, named`);
  } catch (e) {
    const why = await p
      .eval(`(() => { const peer = realPeersById.get(${id}); return { banners: window.__cardBanners, cardOpen: !document.getElementById("peer-card").classList.contains("hidden"), name: peer && peer.name, live: liveNow(), worldJoined: !!worldChannel && worldChannel.state }; })()`)
      .catch(() => "the page couldn't be read");
    throw new Error(`${e.message.split(" — last:")[0]} — ${q(why)}`);
  }
  await p.click("btn-msg");
  await p.waitFor(`!document.getElementById("chat").classList.contains("hidden") && state.chatPeer && state.chatPeer.id === ${id}`, `${p.name}: chat with #${id} open`);
  // its messages loaded and drawn (light reload: a chat a reload brought as
  // a summary loads when it's opened — read, and Send ready, only then)
  await p.waitFor(`chats.get(state.chatPeer).loaded !== false`, `${p.name}: chat with #${id} loaded`, 15000);
}

export const typeText = (p, text) =>
  p.eval(`(() => { const i = document.getElementById("chat-input"); i.value = ${q(text)}; i.dispatchEvent(new Event("input")); return true; })()`);

export const box = (p) => p.eval(`document.getElementById("chat-input").value`);

export const send = (p) => p.eval(`document.getElementById("chat-form").requestSubmit(), true`);

export const chatOpenWith = (p) =>
  p.eval(`document.getElementById("chat").classList.contains("hidden") ? null : state.chatPeer && state.chatPeer.id`);

export const closeChatPanel = (p) => p.eval(`closeChat(), true`);

// their messages in this person's copy of the chat with #id. A chat a
// reload brought as a summary has none until it's opened (light reload):
// then it's opened (which reads it) and its messages waited for — a chat
// already loaded is read as it is, never opened
export async function textsFrom(p, id) {
  if (await p.eval(`chats.has(realPeersById.get(${id})) && chatFor(realPeersById.get(${id})).loaded === false`)) {
    await p.eval(`openChat(realPeersById.get(${id})), true`);
    await p.waitFor(`chatFor(realPeersById.get(${id})).loaded !== false`, `${p.name}: chat with #${id} loaded`, 15000);
  }
  return p.eval(`chats.has(realPeersById.get(${id})) ? chatFor(realPeersById.get(${id})).msgs.map(m => m.text) : []`);
}

export const unreadFrom = (p, id) => p.eval(`chats.has(realPeersById.get(${id})) ? chatFor(realPeersById.get(${id})).unread : null`);

// what an element shows, read as text: an icon picture reads as its emoji
// (data-emoji — icons.js), so "✋ Need a ride" is the hand picture and
// the words. (The car picture reads as nothing, as it always has.)
export const SHOWN = `((e) => [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent : n.dataset && n.dataset.emoji ? n.dataset.emoji + " " : "").join(""))`;
export const shown = (p, selector) => p.eval(`(() => { const e = document.querySelector(${q(selector)}); return e ? ${SHOWN}(e) : null; })()`);

// an icon where the app shows one is the picture (an <img> of src), and
// the emoji itself appears nowhere in the element's text
export const showsIcon = (p, selector, src) =>
  p.eval(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return false; const i = e.querySelector('img[src^="${src}"]'); return !!i && !!i.dataset.emoji && !e.textContent.includes(i.dataset.emoji); })()`);

export async function bannerIs(p, text, what) {
  try {
    await p.waitFor(`(() => { const b = document.getElementById("banner"); return !b.classList.contains("hidden") && ${SHOWN}(b) === ${q(text)}; })()`, `${p.name}: banner ${q(text)}${what ? ` (${what})` : ""}`);
  } catch (e) {
    throw new Error(`${e.message.split(" — last:")[0]} — on screen: ${q(await p.banner())}`);
  }
}

// Sign out (the drawer's button): the sign-in screen. If it doesn't come,
// the failure says why — the server's answer to the sign-out, the banners
// shown since the tap, whether the app still has you signed in
export async function signOut(p) {
  await p.eval(`(() => {
    const f = window.fetch;
    window.fetch = (u, o) => {
      const r = f(u, o);
      if (String(u).startsWith("/api/logout")) r.then((x) => (window.__logout = x.status), () => (window.__logout = "unreachable"));
      return r;
    };
    // every banner from the tap on (a short message may be gone by the end)
    window.__banners = [];
    const b = document.getElementById("banner");
    new MutationObserver(() => b.textContent && window.__banners.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  await p.click("btn-logout");
  try {
    await p.waitFor(
      `typeof state !== "undefined" && !state.realUser && !document.getElementById("auth-buttons").classList.contains("hidden")`,
      `${p.name} signed out`,
      15000
    );
  } catch (e) {
    const why = await p
      .eval(`({ server: window.__logout === undefined ? "no answer yet" : window.__logout, banners: window.__banners, signedIn: typeof state !== "undefined" && !!state.realUser, buttonDisabled: document.getElementById("btn-logout").disabled })`)
      .catch(() => "the page couldn't be read");
    throw new Error(`${e.message.split(" — last:")[0]} — ${q(why)}`);
  }
}

// the car in the banner is the owner's picture (car.png), not the emoji
export async function bannerHasCar(p) {
  await p.waitFor(`!!document.querySelector('#banner > img.car-icon[src^="car.png"]')`, `${p.name}: the car picture in the banner`);
}

// the picture shown where a car is (an <img> of car.png), not the emoji
export const showsCar = (p, selector) =>
  p.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !!e.querySelector('img[src^="car.png"]') && !e.textContent.includes("\u{1F697}"); })()`);

export async function dropAndWait(p) {
  await p.drop();
  await bannerIs(p, "Reconnecting to Hood Ride…", "the connection dropped").catch(async (e) => {
    // in a ride the ride's own line comes first: "… · Reconnecting…"
    const b = await p.banner();
    if (!b.endsWith(" · Reconnecting…")) throw e;
  });
}

export async function restoreAndWait(p) {
  await p.restore();
  await p.waitFor(`liveNow() && !connWatch.lost()`, `${p.name}: connected again`, 15000);
  // the rebuild after the reconnect has run (/api/state)
  await p.waitFor(`!reloading`, `${p.name}: rebuilt`);
}

// the banner starts with `start` (and ends with `end`, if given) — for lines
// with a live part in the middle, like the distance in a ride
export async function bannerLike(p, start, end = "", what) {
  try {
    await p.waitFor(
      `(() => { const b = document.getElementById("banner"); const t = ${SHOWN}(b); return !b.classList.contains("hidden") && t.startsWith(${q(start)}) && t.endsWith(${q(end)}); })()`,
      `${p.name}: banner ${q(start)} … ${q(end)}${what ? ` (${what})` : ""}`
    );
  } catch (e) {
    throw new Error(`${e.message.split(" — last:")[0]} — on screen: ${q(await p.banner())}`);
  }
}
