// A long-open page on a lost connection (growth review, 2026-11-19).
//  * position updates: none queued while the connection is down (Phoenix
//    holds every push until the rejoin — ~180 an hour on shift, up to
//    ~2,400 moving mid-ride); the next tick after the rejoin sends again.
//  * the screen's wake lock: asked for once, not again at every reconnect
//    and return to the app; asked again once the phone has released it.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, dropAndWait, restoreAndWait } from "./app.mjs";

const queued = (p) => p.eval(`userChannel.pushBuffer.filter((x) => x.event === "driver_update").length`);

await journey("offlinequeue: no position updates queued while offline; one wake lock at a time", async (browser) => {
  step("Bob drives; Ann sees him");
  const bob = await browser.person("OQ-Bob");
  const ann = await browser.person("OQ-Ann");
  const bobId = await bob.id();
  await goOnline(bob);
  await sees(ann, bobId, "(his car)");

  step("Bob's connection drops: his updates come due — none queued");
  // (every push Bob's app makes, from here on)
  await bob.eval(`(() => { const push = userChannel.push.bind(userChannel); window.__pushed = []; userChannel.push = (e, ...r) => (window.__pushed.push(e), push(e, ...r)); return true; })()`);
  await dropAndWait(bob);
  for (let i = 0; i < 5; i++) await bob.eval(`(lastGeoSent = null, pushDriverUpdate(), true)`);
  check((await queued(bob)) === 0, "nothing queued while offline", await queued(bob));
  // (as if one had just gone before the drop: only the reconnect itself may
  // make the next one due — not this test)
  await bob.eval(`(lastGeoSent = HoodSendFilter.stamp(state.me, currentSpot(), Date.now(), Math.random), true)`);

  step("back: his position goes out on its own within a tick or two — not a heartbeat later");
  await bob.eval(`(window.__pushed = [], true)`);
  await restoreAndWait(bob);
  // (nothing went while offline, so the server's row is as old as the
  // outage: a 20 s heartbeat more could take it past 3 min — off the map)
  await bob.waitFor(`window.__pushed.includes("driver_update")`, "a position sent after the reconnect", 5000);
  check((await queued(bob)) === 0, "sent, not queued");
  await sees(ann, bobId, "(still)");

  step("at a pickup, the ride channel down: the automatic 'arrived' isn't queued every tick — said once it's back; a tap on 'I'm here' says 'try again'");
  const arrived = await bob.eval(`(() => {
    const saved = { ride: state.ride, ch: rideChannel, sent: lastRidePosSent };
    const pushed = [];
    // a ride, its pin right where Bob is: the automatic arrival is due
    state.ride = { status: "connected", role: "driver", id: "r-test", peer: { pin: { lat: state.me.lat, lng: state.me.lng } } };
    rideChannel = { state: "errored", push: (e) => pushed.push(e) };
    document.getElementById("banner").textContent = "";
    for (let i = 0; i < 5; i++) pushRidePos();
    const ticksOffline = pushed.filter((e) => e === "arrived").length;
    // (and no "try again" either: nobody tapped anything)
    const ticksBanner = document.getElementById("banner").textContent;
    // the button, connected but the ride channel only rejoining (a reload):
    // the one tap goes (held for the join), no "try again"
    document.getElementById("banner").textContent = "";
    declareArrived();
    const tapRejoining = pushed.filter((e) => e === "arrived").length;
    const toldRejoining = document.getElementById("banner").textContent;
    // the button, really disconnected: "try again", nothing sent
    const realUser = userChannel;
    userChannel = { state: "errored" };
    document.getElementById("banner").textContent = "";
    declareArrived();
    const tapOffline = pushed.filter((e) => e === "arrived").length - tapRejoining;
    const told = document.getElementById("banner").textContent;
    userChannel = realUser;
    // back: the next tick says it
    rideChannel.state = "joined";
    pushRidePos();
    const back = pushed.filter((e) => e === "arrived").length - tapRejoining;
    // the ride channel up, the user channel down (it fails on its own): the
    // tick still says it — and no "try again" (nobody tapped)
    const before = pushed.filter((e) => e === "arrived").length;
    const realUser2 = userChannel;
    userChannel = { state: "errored" };
    document.getElementById("banner").textContent = "";
    pushRidePos();
    const rideOnly = pushed.filter((e) => e === "arrived").length - before;
    const rideOnlyBanner = document.getElementById("banner").textContent;
    // …and a tap then: it goes too (the ride channel can carry it)
    declareArrived();
    const rideOnlyTap = pushed.filter((e) => e === "arrived").length - before - rideOnly;
    const rideOnlyTapBanner = document.getElementById("banner").textContent;
    userChannel = realUser2;
    state.ride = saved.ride;
    rideChannel = saved.ch;
    lastRidePosSent = saved.sent;
    return { ticksOffline, ticksBanner, tapRejoining, toldRejoining, tapOffline, told, back, rideOnly, rideOnlyBanner, rideOnlyTap, rideOnlyTapBanner, tryAgain: CANT_REACH() };
  })()`);
  check(arrived.ticksOffline === 0, "the ticks: nothing while the ride channel is down", JSON.stringify(arrived));
  check(arrived.ticksBanner !== arrived.tryAgain, "the ticks: no 'try again' banner (nobody tapped)", JSON.stringify(arrived));
  check(arrived.tapRejoining === 1 && arrived.toldRejoining !== arrived.tryAgain, "the tap while the ride channel rejoins: it goes, no 'try again'", JSON.stringify(arrived));
  check(arrived.tapOffline === 0 && arrived.told === arrived.tryAgain, "the tap while disconnected: 'try again', nothing queued", JSON.stringify(arrived));
  check(arrived.back === 1, "back: said once", JSON.stringify(arrived));
  check(arrived.rideOnly === 1 && arrived.rideOnlyBanner !== arrived.tryAgain, "the ride channel up, the user channel down: the tick says it, no 'try again'", JSON.stringify(arrived));
  check(arrived.rideOnlyTap === 1 && arrived.rideOnlyTapBanner !== arrived.tryAgain, "…and a tap goes too", JSON.stringify(arrived));

  step("the wake lock: asked for once however often it's asked; again once released");
  const count = await bob.eval(`(async () => {
    window.__wakeAsks = 0;
    // (a lock with a "release" event and NO \`released\` — as Chrome 84–86)
    window.__releaseLast = null;
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => (window.__wakeAsks++, { addEventListener: (t, f) => t === "release" && (window.__releaseLast = f) }) } });
    wakeLock = null;
    for (let i = 0; i < 3; i++) await requestWakeLock();
    const held = window.__wakeAsks;
    // two at once (start-up and a reload's hydrate): one request
    wakeLock = null;
    window.__wakeAsks = 0;
    await Promise.all([requestWakeLock(), requestWakeLock()]);
    const together = window.__wakeAsks;
    window.__wakeAsks = held;
    window.__releaseLast(); // the phone let it go (the app hidden)
    await requestWakeLock();
    return [held, window.__wakeAsks, together];
  })()`);
  check(count[0] === 1, "three asks while held: one lock", JSON.stringify(count));
  check(count[1] === 2, "released: asked for again", JSON.stringify(count));
  check(count[2] === 1, "two asks at once: one request", JSON.stringify(count));
});
