// A driver's last-known distance when the rider's page was silent — frozen
// (iOS holds a background tab's messages and hands them over when it
// wakes) — and he went offline meanwhile (review, 2026-11-24). The news
// handled after the silence is stamped at the silence's start, not "now":
// else "0 min ago" for a driver gone the whole time.
// (A test browser's frozen page still gets its socket's messages at once
// — tried: Page.setWebLifecycleState — so the silence is set as a frozen
// page leaves it: no message heard for a minute, Phoenix's channel handler
// running before the socket's onMessage sees the gap.)
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, DRAWN } from "./app.mjs";

await journey("lastfrozen: a driver whose leaving is heard after a silence (a frozen page) is last seen when the silence began", async (browser) => {
  step("Rosa sees Dirk's car; her page hears nothing for a minute (as frozen); Dirk goes offline: kept from the silence's start");
  const rosa = await browser.person("BT-FrozenRosa");
  const dirk = await browser.person("BT-FrozenDirk", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  await goOnline(dirk);
  const dirkId = await dirk.id();
  await sees(rosa, dirkId, "(his car)");
  // (as a frozen page leaves it: nothing heard for a minute)
  const silentFrom = await rosa.eval(`(socketLiveAt = provenLiveAt = Date.now() - 60_000, socketLiveAt)`);
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await rosa.waitFor(`!realEntries.has(${dirkId}) && !!realPeersById.get(${dirkId}).lastSeen`, "his car gone, kept", 15000);
  const at = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at === silentFrom, "last seen: when the silence began, not when the news was handled", { silentFrom, at, diff: at - silentFrom });
  // (and the burst noted: the rest of a woken page's held news dated the same)
  check((await rosa.eval(`heldFrom`)) === silentFrom, "the held burst noted for what follows", await rosa.eval(`heldFrom`));

  step("Dirk back; a silence again, and Rosa switches to driving: the cars hidden then are kept from the silence's start, not 'now'");
  await rosa.eval(`(heldFrom = null, true)`);
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, back)");
  const silent2 = await rosa.eval(`(socketLiveAt = provenLiveAt = Date.now() - 60_000, socketLiveAt)`);
  await rosa.eval(`(document.getElementById("btn-mode").click(), true)`);
  await rosa.waitFor(`state.mode === "driver" && !(${DRAWN(dirkId)})`, "driving: the cars hidden");
  const at2 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at2 === silent2, "kept from the silence's start", { silent2, at2 });

  step("a silence; a held message comes as the page wakes; then the connection drops; a car gone meanwhile: dated to the silence's start, not the wake-up");
  await rosa.eval(`(document.getElementById("btn-mode").click(), true)`);
  await rosa.waitFor(`state.mode === "rider"`, "riding again");
  await sees(rosa, dirkId, "(his car, again)");
  // (as it is just after a woken page's burst: the silence's start proven
  // last; the burst's messages heard, its window over — then the
  // connection drops. Set and dropped in one turn: nothing heard between)
  const silent3 = await rosa.eval(`(() => {
    const from = Date.now() - 60_000;
    lostFrom = null;
    provenLiveAt = from;
    heldFrom = from;
    heldUntil = Date.now() - 1;
    socketLiveAt = Date.now();
    socket.disconnect();
    return from;
  })()`);

  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await rosa.eval(`(socket.connect(), true)`);
  await rosa.waitFor(`socket.isConnected() && !realEntries.has(${dirkId})`, "back: his car gone", 15000);
  const at3 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at3 === silent3, "dated to the silence's start", { silent3, at3, diff: at3 - silent3 });

  step("the connection just dropped (seconds, not a silence yet); Rosa switches to driving: cars hidden then dated to the drop, not 'now'");
  await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, once more)");
  await rosa.eval(`(lostFrom = null, heldFrom = null, true)`);
  const dropped = await rosa.eval(`(socket.disconnect(), Date.now())`);
  await new Promise((r) => setTimeout(r, 3000));
  await rosa.eval(`(document.getElementById("btn-mode").click(), true)`);
  await rosa.waitFor(`state.mode === "driver" && !(${DRAWN(dirkId)})`, "driving: the cars hidden");
  const at4 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at4 <= dropped + 500, "dated to the drop (3 s before)", { dropped, at4, diff: at4 - dropped });
  await rosa.eval(`(socket.connect(), true)`);

  step("a NEW connection after a long outage: its first news is fresh — Dirk leaving just after is dated now, not to before the outage");
  await rosa.waitFor(`socket.isConnected() && hydrated && !reloading`, "back", 15000);
  await rosa.eval(`(document.getElementById("btn-mode").click(), true)`);
  await rosa.waitFor(`state.mode === "rider"`, "riding again");
  if (!(await dirk.eval(`state.online`))) await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, last time)");
  // (an outage of a minute: the old connection's last message that long ago)
  await rosa.eval(`(socket.disconnect(), socketLiveAt = provenLiveAt = Date.now() - 60_000, socket.connect(), true)`);
  await rosa.waitFor(`socket.isConnected() && worldSync.settled()`, "connected anew", 15000);
  const before5 = await rosa.eval(`Date.now()`);
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await rosa.waitFor(`!realEntries.has(${dirkId})`, "his car gone", 15000);
  const at5 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at5 >= before5, "dated now (after the reconnect), not to before the outage", { before5, at5, diff: at5 - before5 });

  step("two freezes with a short wake between (a glance, no message after the wake's burst): a car gone in the second is dated to the wake, not the first freeze");
  if (!(await dirk.eval(`state.online`))) await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, the glance)");
  // (first freeze: 50 s — short enough that the connection survives it: the
  // server drops a silent one after ~60 s)
  const firstSilence = await rosa.eval(`(heldFrom = null, lostFrom = null, socketLiveAt = provenLiveAt = Date.now() - 50_000, provenLiveAt)`);
  // (the wake: a message comes — the burst)
  await dirk.locate({ latitude: HOME.latitude + 0.0042, longitude: HOME.longitude });
  await rosa.waitFor(`heldFrom === ${firstSilence}`, "woken: the burst", 35000);
  await new Promise((r) => setTimeout(r, 2500));
  // (then a second freeze, as it leaves things: the wake — its burst — was
  // the last message, 46 s ago; its window ended 2 s after it; the first
  // freeze's start still the last PROVEN-live time)
  const wakeAt = await rosa.eval(`(() => { const w = Date.now() - 46_000; socketLiveAt = w; heldUntil = w + 2000; return w; })()`);
  await dirk.click("btn-online");
  await dirk.waitFor(`!state.online`, "Dirk offline");
  await rosa.waitFor(`!realEntries.has(${dirkId}) && !!realPeersById.get(${dirkId}).lastSeen`, "his car gone, kept", 15000);
  const at6 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at6 === wakeAt, "dated to the glance (the wake), not the first freeze", { firstSilence, wakeAt, at6 });

  step("frozen 2 min, woken (the backlog burst), the connection found dead, still down 50 s later; Rosa switches to driving: dated to the freeze, not the burst");
  // (review, 2026-11-25: past 45 s of silence the loss wasn't looked at —
  // the burst counted as live)
  if (!(await dirk.eval(`state.online`))) await goOnline(dirk);
  await sees(rosa, dirkId, "(his car, before the long freeze)");
  const frozeAt = await rosa.eval(`(() => {
    const from = Date.now() - 120_000;
    lostFrom = null;
    provenLiveAt = from;
    heldFrom = from;
    heldUntil = Date.now() - 1;
    socketLiveAt = Date.now() - 50_000;
    socket.disconnect();
    return from;
  })()`);
  await rosa.eval(`(document.getElementById("btn-mode").click(), true)`);
  await rosa.waitFor(`state.mode === "driver" && !${DRAWN(dirkId)} && !!realPeersById.get(${dirkId}).lastSeen`, "driving: his car hidden, kept");
  const at7 = await rosa.eval(`realPeersById.get(${dirkId}).lastSeen.at`);
  check(at7 === frozeAt, "dated to the freeze (the loss), not the backlog burst", { frozeAt, at7, diff: at7 - frozeAt });
  await rosa.eval(`(socket.connect(), true)`);

  check(rosa.errors.length === 0, "no page errors", rosa.errors);
});
