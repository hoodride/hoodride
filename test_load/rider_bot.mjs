// A rider, minus the human: raises a hand near the demo location, engages
// the first driver who comes online in that cell (messages, then requests),
// re-requests after a decline, rides, and raises the hand again afterwards.
// Run:  node test_load/rider_bot.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";
const RES = 8;

// Jaylen waits ~150m east of the demo location
const myPos = { lat: 40.7131, lng: -74.0043 };
const myCell = h3.latLngToCell(myPos.lat, myPos.lng, RES);
const mySpot = h3.latLngToCell(myPos.lat, myPos.lng, 9);
// the browser-driver broadcasts from the demo location's cell
const watchCell = h3.latLngToCell(40.7128, -74.006, RES);

let driverId = null;
let engaged = false;
let rideTopic = null;
const REPLIES = ["cool! I'm by the fountain ðŸ™‹", "aight, watching for you", "ðŸ‘"];
let replyIdx = 0;

function log(s) {
  console.log(new Date().toISOString().slice(11, 19) + "  " + s);
}

class Phx {
  constructor(token) {
    this.ref = 0;
    this.pending = new Map();
    this.joinRefs = new Map();
    this.handlers = [];
    this.ws = new WebSocket(`${WS}&token=${encodeURIComponent(token)}`);
    this.opened = new Promise((res) => (this.ws.onopen = res));
    this.ws.onmessage = (ev) => {
      const [_jr, ref, topic, event, payload] = JSON.parse(ev.data);
      if (event === "phx_reply" && this.pending.has(ref)) {
        const { resolve, reject } = this.pending.get(ref);
        this.pending.delete(ref);
        payload.status === "ok"
          ? resolve(payload.response)
          : reject(new Error(JSON.stringify(payload)));
        return;
      }
      this.handlers.forEach((h) => h(topic, event, payload));
    };
    setInterval(() => {
      this.ws.send(JSON.stringify([null, String(++this.ref), "phoenix", "heartbeat", {}]));
    }, 25000);
  }
  send(topic, event, payload) {
    const ref = String(++this.ref);
    const joinRef = event === "phx_join" ? ref : this.joinRefs.get(topic) ?? null;
    if (event === "phx_join") this.joinRefs.set(topic, ref);
    const p = new Promise((resolve, reject) => this.pending.set(ref, { resolve, reject }));
    this.ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    return p;
  }
  fire(topic, event, payload) {
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify([this.joinRefs.get(topic) ?? null, ref, topic, event, payload]));
  }
  on(fn) {
    this.handlers.push(fn);
  }
}

async function main() {
  const r = await fetch(`${BASE}/api/dev_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agree_terms: true,
      name: "Jaylen-Bot",
      photo:
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#e0a030"/><text x="48" y="64" font-size="48" text-anchor="middle">ðŸ™‹</text></svg>'
        ),
    }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
  const token = (await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json())
    .token;
  log(`logged in as ${me.name} (#${me.id})`);

  const phx = new Phx(token);
  await phx.opened;
  const myTopic = `user:${me.id}`;
  await phx.send(myTopic, "phx_join", {});
  // Option B: one world channel, cells watched via sync
  await phx.send("world", "phx_join", {});
  await phx.send("world", "sync", { geo: [watchCell] }); // full desired set
  phx.fire(myTopic, "hand_up", { cell: myCell, spot: mySpot, parents: [7, 5].map((r) => h3.latLngToCell(myPos.lat, myPos.lng, r)) }); // {:noreply} on the server â€” never await it
  log(`âœ‹ hand up in ${myCell}, watching ${watchCell} for a driver`);

  function engage(id) {
    if (engaged || id === me.id) return;
    engaged = true;
    driverId = id;
    log(`driver #${id} spotted â€” messaging, then requesting`);
    setTimeout(
      () => phx.send(myTopic, "send_msg", { to: driverId, text: "yo! can you get me? ðŸ™‹" }),
      2500
    );
    setTimeout(
      () =>
        phx
          .send(myTopic, "request_ride", { to: driverId })
          .then(() => log("ride requested"))
          .catch((e) => log("request failed: " + e.message)),
      6000
    );
  }

  phx.on((topic, event, payload) => {
    if (topic === "world" && event === "driver_update") engage(payload.id);

    if (topic === myTopic && event === "msg") {
      log(`msg from ${payload.from.name}: ${payload.text}`);
      const line = REPLIES[Math.min(replyIdx++, REPLIES.length - 1)];
      setTimeout(() => phx.send(myTopic, "send_msg", { to: payload.from.id, text: line }), 1200);
    }

    if (topic === myTopic && event === "request_declined") {
      // the server's re-request cooldown is 60s per driver ("no" sticks)
      log("declined ðŸ˜¤ â€” asking again in 61s");
      setTimeout(
        () =>
          driverId &&
          phx
            .send(myTopic, "request_ride", { to: driverId })
            .then(() => log("re-requested"))
            .catch((e) => log("re-request failed: " + e.message)),
        61000
      );
    }

    if (topic === myTopic && event === "request_expired") log("request expired");

    if (topic === myTopic && event === "ride_started") {
      rideTopic = `ride:${payload.ride_id}`;
      log(`ride ${payload.ride_id} started with ${payload.peer.name}`);
      phx.send(rideTopic, "phx_join", {});
    }

    if (topic === rideTopic && event === "arrived") log("driver says they're here ðŸš•");

    if (topic === rideTopic && event === "ended") {
      log("ride ended â€” hand back up in 6s");
      rideTopic = null;
      engaged = false;
      driverId = null;
      replyIdx = 0;
      setTimeout(() => {
        phx.fire(myTopic, "hand_up", { cell: myCell, spot: mySpot, parents: [7, 5].map((r) => h3.latLngToCell(myPos.lat, myPos.lng, r)) });
        log("âœ‹ hand up again");
      }, 6000);
    }
  });

  // gentle position jitter while riding (a human shifting their weight)
  setInterval(() => {
    if (rideTopic) {
      phx.fire(rideTopic, "pos", {
        lat: myPos.lat + (Math.random() - 0.5) * 0.00008,
        lng: myPos.lng + (Math.random() - 0.5) * 0.00008,
      });
    }
  }, 1500);

  log("rider bot running â€” Ctrl+C to stop");
}

main().catch((e) => {
  console.error("rider bot crashed:", e);
  process.exit(1);
});
