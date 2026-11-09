// Real-wire end-to-end test: two genuine websocket clients (rider + driver)
// run the full Hood Ride protocol against the LIVE server over actual TCP.
// Run with the server up:  node test_load/ws_test.mjs
import process from "node:process";
import { createRequire } from "node:module";

// the map's updates come grouped ("batch", since 2026-10): unpacked with the
// app's own helper, so this reads them exactly as the app does
const require = createRequire(import.meta.url);
const HoodMapFrame = require("../priv/static/mapframe.js");

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";
const CELL = "8f2830828052d25";
const SPOT = "8f2830828052d26"; // the car's display spot (opaque to the server)

let failures = 0;
function ok(label) {
  console.log("  PASS  " + label);
}
function fail(label, detail) {
  failures++;
  console.error("  FAIL  " + label + (detail ? " — " + detail : ""));
}

// ---- tiny Phoenix channels client (wire protocol v2) ----
class Phx {
  constructor(token, name) {
    this.name = name;
    this.ref = 0;
    this.pending = new Map(); // ref -> {resolve, reject}
    this.joinRefs = new Map(); // topic -> joinRef
    this.waiters = []; // {topic, event, pred, resolve}
    this.ws = new WebSocket(`${WS}&token=${encodeURIComponent(token)}`);
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error("ws error"));
    });
    this.ws.onmessage = (ev) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(ev.data);
      if (event === "phx_reply" && this.pending.has(ref)) {
        const { resolve, reject } = this.pending.get(ref);
        this.pending.delete(ref);
        if (payload.status === "ok") resolve(payload.response);
        else reject(new Error(`${topic} reply error: ${JSON.stringify(payload.response)}`));
        return;
      }
      // a "batch" is many updates in one message: each is delivered as if
      // it came alone (the waiters wait for the update, not the wrapping)
      if (event === "batch") {
        const each = new Proxy({}, { get: (_, ev) => (p) => this.deliver(topic, ev, p) });
        return HoodMapFrame.unbatch(payload.items, each);
      }
      this.deliver(topic, event, payload);
    };
  }

  deliver(topic, event, payload) {
    this.waiters = this.waiters.filter((w) => {
      if (w.topic === topic && w.event === event && (!w.pred || w.pred(payload))) {
        w.resolve(payload);
        return false;
      }
      return true;
    });
  }

  send(topic, event, payload) {
    const ref = String(++this.ref);
    const joinRef = event === "phx_join" ? ref : this.joinRefs.get(topic) ?? null;
    if (event === "phx_join") this.joinRefs.set(topic, ref);
    const p = new Promise((resolve, reject) => this.pending.set(ref, { resolve, reject }));
    this.ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    return p;
  }

  join(topic) {
    return this.send(topic, "phx_join", {});
  }

  // for server handlers that are {:noreply} — no reply will ever come
  fire(topic, event, payload) {
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify([this.joinRefs.get(topic) ?? null, ref, topic, event, payload]));
  }

  expect(topic, event, pred) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${event} on ${topic}`)),
        8000
      );
      this.waiters.push({
        topic,
        event,
        pred,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
      });
    });
  }
}

// ---- HTTP helpers ----
async function login(name) {
  const r = await fetch(`${BASE}/api/dev_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agree_terms: true, name }),
  });
  if (!r.ok) throw new Error("dev_login failed: " + r.status);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json();
  const tok = await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json();
  return { cookie, user: me.user, token: tok.token };
}

// ---- the actual flow ----
async function main() {
  console.log("E2E over the real wire, two clients:");

  // keeps the event loop alive for the whole run and kills hung runs
  const watchdog = setTimeout(() => {
    console.error("E2E WATCHDOG: run exceeded 60s, aborting");
    process.exit(1);
  }, 60000);
  watchdog; // referenced so the timer refs the loop

  const suffix = Math.random().toString(36).slice(2, 7);
  const rider = await login(`E2E-Rider-${suffix}`);
  const driver = await login(`E2E-Driver-${suffix}`);
  ok(`logins + socket tokens (rider #${rider.user.id}, driver #${driver.user.id})`);

  // bad token must be refused at the socket level
  const badWs = new WebSocket(`${WS}&token=garbage`);
  const refused = await new Promise((res) => {
    const t = setTimeout(() => res(true), 3000); // never opened = refused
    badWs.addEventListener("error", () => {}, { once: true });
    badWs.addEventListener("close", () => {
      clearTimeout(t);
      res(true);
    });
    badWs.addEventListener("open", () => {
      clearTimeout(t);
      res(false);
    });
  });
  if (refused) ok("garbage token refused at socket connect");
  else fail("garbage token refused at socket connect", "it connected!");

  const R = new Phx(rider.token, "rider");
  const D = new Phx(driver.token, "driver");
  await Promise.all([R.opened, D.opened]);
  ok("both websockets connected with signed tokens");

  const riderTopic = `user:${rider.user.id}`;
  const driverTopic = `user:${driver.user.id}`;
  await R.join(riderTopic);
  await D.join(driverTopic);
  ok("user channels joined");

  // rider watches the cell via the world multiplexer; driver goes online there
  await R.join("world");
  const synced = await R.send("world", "sync", { geo: [CELL] }); // full desired set
  const seen = R.expect("world", "driver_update", (p) => p.id === driver.user.id);
  // a browsing car is its spot: an old app's lat/lng is ignored, never relayed
  D.fire(driverTopic, "driver_update", { cell: CELL, spot: SPOT, lat: 40.71, lng: -74.0 });
  const drv = await seen;
  if (JSON.stringify(Object.keys(drv).sort()) === '["cell","id","spot"]' && drv.spot === SPOT)
    ok("rider sees the car appear as {id, cell, spot} — no position, no name, no photo");
  else fail("car broadcast must be {id, cell, spot} only", JSON.stringify(drv));
  const who = await R.send("world", "reveal", { id: driver.user.id });
  if (who.name === driver.user.name) ok("tapping the car reveals the driver's name (reveal)");
  else fail("reveal returns the driver's profile", JSON.stringify(who));
  if (Array.isArray(synced.geo) && Array.isArray(synced.geo[0].drivers))
    ok("world sync returned the cell snapshot");

  // chat, both directions
  const toDriver = D.expect(driverTopic, "msg", (p) => p.text === "yo can you grab me?");
  await R.send(riderTopic, "send_msg", { to: driver.user.id, text: "yo can you grab me?" });
  await toDriver;
  ok("rider→driver message delivered over the wire");

  const toRider = R.expect(riderTopic, "msg", (p) => p.text === "omw");
  await D.send(driverTopic, "send_msg", { to: rider.user.id, text: "omw" });
  await toRider;
  ok("driver→rider message delivered over the wire");

  // request → accept → ride_started on both
  const reqSeen = D.expect(driverTopic, "request", (p) => p.from.id === rider.user.id);
  await R.send(riderTopic, "request_ride", { to: driver.user.id });
  await reqSeen;
  ok("ride request delivered to the driver");

  const rideR = R.expect(riderTopic, "ride_started");
  const rideD = D.expect(driverTopic, "ride_started");
  await D.send(driverTopic, "accept_request", { rider_id: rider.user.id });
  const [startedR, startedD] = await Promise.all([rideR, rideD]);
  if (startedR.ride_id === startedD.ride_id && startedR.role === "rider" && startedD.role === "driver")
    ok(`ride born on both phones (${startedR.ride_id})`);
  else fail("ride_started consistency", JSON.stringify([startedR, startedD]));
  const rideTopic = `ride:${startedR.ride_id}`;

  // ride channel: pos relay + pin + end
  await R.join(rideTopic);
  await D.join(rideTopic);
  ok("both parties joined the ride channel");

  const posSeen = R.expect(rideTopic, "peer_pos", (p) => p.lat === 40.72);
  D.fire(rideTopic, "pos", { lat: 40.72, lng: -74.01 });
  await posSeen;
  ok("driver position relayed to rider");

  const pinSeen = D.expect(rideTopic, "pin", (p) => p.pin && p.pin.lat === 40.715);
  R.fire(rideTopic, "set_pin", { lat: 40.715, lng: -74.005 });
  await pinSeen;
  ok("rider's pin reached the driver");

  const endedR = R.expect(rideTopic, "ended");
  const endedD = D.expect(rideTopic, "ended");
  R.fire(rideTopic, "end_ride", {});
  await Promise.all([endedR, endedD]);
  ok("ride ended on both phones");

  // rehydration truth-check: server state agrees afterwards
  // (as the app asks: the chat list — light reload, 2026-11-08 — and the
  // chat's messages when it's opened)
  const st = await (await fetch(`${BASE}/api/state?chats=list`, { headers: { cookie: rider.cookie } })).json();
  if (st.ride === null) ok("post-ride /api/state shows no ride (death is deletion)");
  else fail("post-ride state clean", JSON.stringify(st.ride));
  const conv = st.conversations.find((c) => c.peer.id === driver.user.id);
  if (conv && conv.last && !conv.messages) ok("the chat list: the conversation as a summary");
  else fail("conversation summary", JSON.stringify(st.conversations));
  const opened = await (await fetch(`${BASE}/api/chat?peer=${driver.user.id}`, { headers: { cookie: rider.cookie } })).json();
  if (opened.messages && opened.messages.length >= 2) ok("conversation survived the ride with full history");
  else fail("conversation survival", JSON.stringify(opened));

  R.ws.close();
  D.ws.close();
  clearTimeout(watchdog);

  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e.message);
  process.exit(1);
});
