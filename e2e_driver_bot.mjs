// A real driver, minus the human: logs in over the wire, cruises near the
// demo location, answers chat, accepts requests, drives to the pickup.
// Run while the browser rider is open:  node e2e_driver_bot.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const h3 = require("./priv/static/h3-js.umd.js");
// the app's own rule for a browsing car's spot (sticky, block-level)
const F = require("./priv/static/sendfilter.js");
let spot = null;

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";
const RES = 8;

// name and start offset configurable: node e2e_driver_bot.mjs [name] [dLat] [dLng]
const BOT_NAME = process.argv[2] || "DeShawn-Bot";
let pos = {
  lat: 40.7128 + (parseFloat(process.argv[3]) || 0.0032),
  lng: -74.006 + (parseFloat(process.argv[4]) || -0.003),
};
let target = null; // where to drive during a ride
let riderPos = null;
let rideTopic = null;
let state = "cruising"; // cruising | riding
let arrivedSent = false;

const REPLIES = ["yo what's up 🤖", "yea I can grab you", "omw in a sec 🚗", "aight bet"];
let replyIdx = 0;

function log(s) {
  console.log(new Date().toISOString().slice(11, 19) + "  " + s);
}

function step(from, to, meters) {
  const R = 6371000;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const la1 = (from.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos((to.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const total = 2 * R * Math.asin(Math.sqrt(h));
  if (total <= meters) return { ...to };
  const t = meters / total;
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
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
        payload.status === "ok" ? resolve(payload.response) : reject(new Error(JSON.stringify(payload)));
        return;
      }
      this.handlers.forEach((h) => h(topic, event, payload));
    };
    // phoenix heartbeat so the server doesn't drop us
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
      name: BOT_NAME,
      photo:
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#4a90d9"/><text x="48" y="64" font-size="48" text-anchor="middle">🤖</text></svg>'
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
  log("online — cruising near the demo location");

  phx.on((topic, event, payload) => {
    if (topic === myTopic && event === "msg") {
      log(`msg from ${payload.from.name}: ${payload.text}`);
      const line = REPLIES[Math.min(replyIdx++, REPLIES.length - 1)];
      setTimeout(() => phx.send(myTopic, "send_msg", { to: payload.from.id, text: line }), 1200);
    }

    if (topic === myTopic && event === "request") {
      log(`ride request from ${payload.from.name} — accepting in 2s`);
      setTimeout(
        () =>
          phx
            .send(myTopic, "accept_request", { rider_id: payload.from.id })
            .catch((e) => log("accept failed: " + e.message)),
        2000
      );
    }

    if (topic === myTopic && event === "ride_started") {
      rideTopic = `ride:${payload.ride_id}`;
      state = "riding";
      target = null;
      riderPos = null;
      arrivedSent = false;
      log(`ride ${payload.ride_id} started — joining ride channel`);
      phx.send(rideTopic, "phx_join", {}).then((st) => {
        if (st.pin) target = st.pin;
      });
    }

    if (topic === rideTopic && event === "peer_pos") {
      riderPos = { lat: payload.lat, lng: payload.lng };
    }

    if (topic === rideTopic && event === "pin") {
      target = payload.pin;
      arrivedSent = false; // new destination — arrival starts over
      log(payload.pin ? "pin set — rerouting" : "pin cleared");
    }

    if (topic === rideTopic && event === "ended") {
      log("ride ended — going offline (driving the trip), back online in 20s");
      state = "offline";
      rideTopic = null;
      target = null;
      setTimeout(() => {
        state = "cruising";
        log("trip done — GO ONLINE 🚗");
      }, 20000);
    }
  });

  // the engine: wander while cruising, pursue while riding
  setInterval(() => {
    if (state === "cruising") {
      pos = {
        lat: pos.lat + (Math.random() - 0.5) * 0.0004,
        lng: pos.lng + (Math.random() - 0.5) * 0.0004,
      };
      spot = F.stickySpot(spot, { ...pos, accuracy: 10 }, h3, 9);
      const { cell, parents } = F.cellsOf(spot, h3, RES, [7, 5]);
      phx.fire(myTopic, "driver_update", { cell, spot, parents });
    } else if (state === "riding" && rideTopic) {
      const dest = target || riderPos || { lat: 40.7128, lng: -74.006 };
      pos = step(pos, dest, 40);
      phx.fire(rideTopic, "pos", { lat: pos.lat, lng: pos.lng });
      // step() snaps onto the destination when within one stride
      if (!arrivedSent && pos.lat === dest.lat && pos.lng === dest.lng) {
        arrivedSent = true;
        log("arrived — declaring 🚗");
        phx.send(rideTopic, "arrived", {}).catch((e) => log("arrived failed: " + e.message));
      }
    }
  }, 1500);

  log("bot running — Ctrl+C to stop");
}

main().catch((e) => {
  console.error("bot crashed:", e);
  process.exit(1);
});
