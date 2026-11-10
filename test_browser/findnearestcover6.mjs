// Find the nearest alongside the rest of the app (owner, 2026-11-09 — "test
// it to death"), real accounts, through the real server. Each search is
// made to wait (the server's answers held back) so things can happen
// part-way through it:
//
//   * a ride request sent mid-search ends the search; the driver declining
//     doesn't start it again (the map stays as you left it);
//   * a driver accepting a request mid-search ends theirs;
//   * a reload of the app's state mid-search (the connection back) — the
//     search carries on and finds the car, no "nobody nearby yet";
//   (a page frozen in the background, then shown again, can't be shown in
//   the headless test browser — it never makes the page visible again, nor
//   reconnects; what it would show is covered piece by piece: the drawing
//   held back and a dropped connection mid-search, findnearestcover4.mjs;
//   a reload mid-search, below)
//   * the REAL first location arriving while Settings is open (a shift
//     resumed on opening): the search it starts waits behind Settings, and
//     looks once it's gone.
//   * a 5K monitor, not looking for anyone: opening the app and the locate
//     button bring the map to the first zoom that shows cars one by one.
// Helpers and the rule: cover.mjs.
// The others: findnearestcover/2/3/3b/4/5/6.mjs, findnearestpause.mjs,
// findnearestnobody.mjs, findnearestovertime/backoff/driving/
// settle/faults/away/dot.mjs.
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith, holdAnswers, letAnswersGo } from "./app.mjs";
import { oracle, tapLocate, tapEl, looksNoMore, sleep } from "./cover.mjs";

const BLOCK = { latitude: HOME.latitude + 0.004, longitude: HOME.longitude + 0.003 };

// a search that waits at its first step: the map moved off first, so the
// search's own move asks the server again — and that answer is held back
async function waitingSearch(p) {
  await p.eval(`(map.jumpTo({ center: [state.me.lng + 0.02, state.me.lat], zoom: 14 }), true)`);
  await p.waitFor(`!map.isMoving() && worldSync.settled()`, "moved off, answered");
  await holdAnswers(p);
  await p.eval(`(__trace.length = 0, true)`);
  await tapLocate(p);
  await p.waitFor(`nearLooking && __trace.length === 1 && !map.isMoving()`, "the search waiting at its first step", 5000);
  await sleep(500);
  check(await p.eval(`nearLooking && __trace.length === 1`), "(waiting for the held answer)");
}

async function request(kim, doraId) {
  await openChatWith(kim, doraId);
  await kim.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride button");
  await kim.click("btn-ride-action");
  await kim.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
}
async function openRequest(dora, kimId) {
  await dora.waitFor(`realPeersById.has(${kimId}) && realPeersById.get(${kimId}).pending`, "Dora has the request");
  await dora.eval(`openChat(realPeersById.get(${kimId})), true`);
  await dora.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
}

await journey("findnearestcover6: a request, an accept, a reload and the first location — mid-search", async (browser) => {
  step("Dora and Eve online a few blocks off; Kim (rider) with ✋ up, their cars on her map");
  const dora = await browser.person("BT-Dora", BLOCK);
  await dora.phone(390, 844);
  await goOnline(dora);
  const eve = await browser.person("BT-Eve", { latitude: BLOCK.latitude - 0.002, longitude: BLOCK.longitude - 0.004 });
  await eve.phone(390, 844);
  await goOnline(eve, { color: "Red", make: "Honda", model: "Fit" });
  const kim = await browser.person("BT-Kim");
  await kim.phone(390, 844);
  await kim.open();
  await kim.waitFor(`worldChannel && worldChannel.state === "joined" && worldSync.settled()`, "Kim's map loaded");
  await kim.click("btn-hand");
  await kim.waitFor(`state.handRaised && !nearLooking && !map.isMoving()`, "Kim's ✋ up, its search over", 30000);
  const [doraId, kimId, eveId] = [await dora.id(), await kim.id(), await eve.id()];
  await sees(kim, doraId);
  await sees(kim, eveId);
  await oracle(kim);

  step("a ride request (to Eve) sent mid-search ends the search at once; Eve declining doesn't start it again");
  await waitingSearch(kim);
  await request(kim, eveId);
  await kim.waitFor(`!nearLooking`, "the request ended the search", 1000);
  await kim.eval(`(closeChat(), true)`);
  await letAnswersGo(kim);
  await kim.waitFor(`worldSync.settled()`, "the held answer in", 10000);
  await looksNoMore(kim, 2200, "requested");
  const afterReq = await kim.eval(`({ trace: __trace.slice(), looking: nearLooking, nobody: nobodyNear })`);
  check(afterReq.trace.length === 1 && !afterReq.looking && !afterReq.nobody, "no more steps once requested, nothing said", afterReq);
  await letAnswersGo(kim);
  await openRequest(eve, kimId);
  await eve.click("btn-decline");
  await kim.waitFor(`!state.ride`, "Kim's request declined");
  await looksNoMore(kim, 2500, "declined");
  const afterDecline = await kim.eval(`({ trace: __trace.slice(), looking: nearLooking, nobody: nobodyNear, hand: state.handRaised })`);
  check(afterDecline.trace.length === 1 && !afterDecline.looking && !afterDecline.nobody, "declined: the search doesn't start again — the map as Kim left it", afterDecline);

  step("Dora (driver) mid-search accepts Kim's request: her search ends at once");
  await oracle(dora);
  await request(kim, doraId);
  await kim.eval(`(closeChat(), true)`);
  await openRequest(dora, kimId);
  await dora.eval(`(closeChat(), true)`);
  await waitingSearch(dora);
  await dora.eval(`(openChat(realPeersById.get(${kimId})), true)`);
  await dora.waitFor(`document.getElementById("btn-ride-action").textContent === "Accept ride"`, "Accept ride button");
  await dora.click("btn-ride-action");
  await dora.waitFor(`state.ride && !nearLooking`, "accepted: Dora's search over", 2000);
  await letAnswersGo(dora);
  await dora.waitFor(`worldSync.settled()`, "the held answer in", 10000);
  await looksNoMore(dora, 2200, "accepted");
  const afterAccept = await dora.eval(`({ trace: __trace.slice(), looking: nearLooking, nobody: nobodyNear })`);
  check(afterAccept.trace.length === 1 && !afterAccept.looking && !afterAccept.nobody, "no more steps in the ride, nothing said", afterAccept);
  await letAnswersGo(dora);
  await kim.waitFor(`state.ride && state.ride.status === "connected"`, "Kim's ride on");
  await kim.click("btn-endride");
  await kim.waitFor(`!state.ride`, "the ride over (Kim)");
  await dora.waitFor(`!state.ride`, "the ride over (Dora)");
  await dora.eval(`(closeChat(), true)`);
  // (a ride lowers the rider's ✋ — and leaves the driver offline, back on
  // the map only by GO ONLINE: checked, then both put back)
  check(!(await kim.eval(`state.handRaised`)), "after the ride, Kim's ✋ is down");
  check(!(await dora.eval(`state.online`)), "after the ride, Dora is offline");
  await kim.click("btn-hand");
  await kim.waitFor(`state.handRaised`, "Kim's ✋ up again");
  await dora.click("btn-online");
  await dora.waitFor(`state.online`, "Dora online again");
  await kim.waitFor(`!nearLooking && !map.isMoving()`, "Kim's map still", 30000);

  step("the app's state reloaded mid-search (as when the connection comes back): the search carries on — a car found, no 'nobody nearby yet'");
  await waitingSearch(kim);
  const seqR = await kim.eval(`nearSeq`);
  await kim.eval(`softReload().then(() => (window.__reloaded = true)), true`);
  await kim.waitFor(`window.__reloaded === true`, "reloaded", 15000);
  check(await kim.eval(`state.handRaised`), "(✋ still up)");
  // the SAME search, still waiting (not ended by the reload, nor a new one)
  check(await kim.eval(`nearLooking && nearSeq === ${seqR}`), "reloaded: the same search still waiting", await kim.eval(`({ looking: nearLooking, seq: nearSeq, was: ${seqR} })`));
  await letAnswersGo(kim);
  await kim.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 30000);
  // (Dora's or Eve's car: both are near — whichever is in sight)
  const afterReload = await kim.eval(`({ trace: __trace.slice(), z: map.getZoom(), nobody: nobodyNear, seen: __o.seenNow(${doraId}) || __o.seenNow(${eveId}), found: foundWatch !== null, seq: nearSeq })`);
  check(!afterReload.nobody && afterReload.seen && afterReload.found && afterReload.seq === seqR, "that same search found a car, in sight — no 'nobody nearby yet'", afterReload);

  step("Dora's app opened afresh with no location yet (her shift resumes); Settings open; THEN her first location comes: the search it starts waits behind Settings, and looks once it's gone");
  check(await dora.eval(`state.online`), "(Dora's shift on)");
  await dora.noSignal();
  await dora.open();
  const resumed = await dora.waitFor(`state.online && worldChannel && worldChannel.state === "joined" && !state.haveFix`, "Dora's shift resumed, no location yet", 15000).catch(async (e) => {
    throw new Error(e.message + " — " + JSON.stringify(await dora.eval(`({ online: state.online, mode: state.mode, fix: state.haveFix, joined: worldChannel && worldChannel.state, ride: !!state.ride, banner: document.getElementById("banner").textContent })`)));
  });
  await oracle(dora);
  const acct = await dora.eval(`(() => { const b = document.getElementById("btn-account").getBoundingClientRect(); return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }; })()`);
  await dora.tapAt(acct.x, acct.y);
  await dora.waitFor(`document.getElementById("settings-sheet").classList.contains("open")`, "Settings open (tapped)");
  await dora.eval(`(__trace.length = 0, true)`);
  await dora.locate(BLOCK);
  await dora.waitFor(`state.haveFix && __trace.length >= 1`, "the first location: a search started", 15000);
  await sleep(1500);
  const held = await dora.eval(`({ looking: nearLooking, trace: __trace.slice(), nobody: nobodyNear })`);
  check(held.looking && held.trace.length === 1 && !held.nobody, "behind Settings: it waits at its first step", held);
  await tapEl(dora, "settings-close");
  await dora.waitFor(`!nearLooking && !map.isMoving()`, "the search over", 30000);
  const found = await dora.eval(`({ trace: __trace.slice(), z: map.getZoom(), nobody: nobodyNear, seen: __o.seenNow(${kimId}), found: foundWatch !== null })`);
  check(!found.nobody && found.seen && found.found, "Settings gone: it looked — Kim's ✋ found", found);

  step("a 5K monitor (5120×2880 at 100%), not looking for anyone: opening the app and the locate button bring the map to the first zoom that shows cars one by one (the usual view shows counts there)");
  const big = await browser.person("BT-Big");
  await big.phone(5120, 2880, 1);
  await big.open();
  await big.waitFor(`worldChannel && worldChannel.state === "joined" && state.haveFix && !map.isMoving()`, "Big's map on Big", 20000);
  await oracle(big);
  const z0 = await big.eval(`__o.steps()[0]`);
  // (beyond 15 here: the locate button's own "at least 15" isn't enough)
  check(z0 > 15, "(this screen shows counts at the usual view, and at 15)", z0);
  const opened = await big.eval(`({ z: map.getZoom(), people: HoodNearby.showsMarkers(HoodViewport, h3, HoodNearby.screenAt(state.me, map.getZoom(), __o.size()), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS), looking: !!HoodNearby.lookingFor(state) })`);
  check(!opened.looking && Math.abs(opened.z - z0) < 1e-6 && opened.people, "opened: at the first zoom that shows cars one by one", { opened, z0 });
  await big.eval(`(map.jumpTo({ center: [state.me.lng + 0.01, state.me.lat], zoom: 12 }), true)`);
  await big.waitFor(`!map.isMoving()`, "moved away, zoomed out");
  await tapLocate(big);
  await big.waitFor(`!map.isMoving() && Math.abs(map.getCenter().lng - state.me.lng) < 1e-6`, "back on Big");
  const located = await big.eval(`({ z: map.getZoom(), people: HoodNearby.showsMarkers(HoodViewport, h3, HoodNearby.screenAt(state.me, map.getZoom(), __o.size()), [H3_RES, ...AGG_RESES], MAX_WATCHED_CELLS) })`);
  check(located.z >= z0 - 1e-6 && located.z >= 15 && located.people, "the locate button: cars one by one there too", { located, z0 });
  await big.close();

  await kim.close();
  await eve.close();
  await dora.close();
});
