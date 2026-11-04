// One-shot test driver: broadcasts from point A, then jumps to point B,
// to verify coarse-hex counts move with boundary crossings.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
// the app's own rule for a browsing car's spot (sticky, block-level)
const F = require("../priv/static/sendfilter.js");
let spot = null;

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";

const A = { lat: 40.713, lng: -74.006 }; // lower Manhattan
const B = { lat: 40.76, lng: -73.975 }; // midtown — different res-7 parent
let pos = A;

function log(s) {
  console.log(new Date().toISOString().slice(11, 19) + "  " + s);
}

async function main() {
  const r = await fetch(`${BASE}/api/dev_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agree_terms: true, name: "Roamer-Bot" }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
  const token = (await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json())
    .token;

  const ws = new WebSocket(`${WS}&token=${encodeURIComponent(token)}`);
  await new Promise((res) => (ws.onopen = res));
  let ref = 0;
  const send = (topic, event, payload, joinRef) =>
    ws.send(JSON.stringify([joinRef ?? "1", String(++ref), topic, event, payload]));
  send(`user:${me.id}`, "phx_join", {}, "1");
  setInterval(() => ws.send(JSON.stringify([null, String(++ref), "phoenix", "heartbeat", {}])), 25000);

  log(`Roamer #${me.id} at A (res7: ${h3.latLngToCell(A.lat, A.lng, 7)})`);
  log(`will jump to B (res7: ${h3.latLngToCell(B.lat, B.lng, 7)}) in 75s`);

  setInterval(() => {
    spot = F.stickySpot(spot, { ...pos, accuracy: 10 }, h3, 9);
    const { cell, parents } = F.cellsOf(spot, h3, 8, [7, 5]);
    send(`user:${me.id}`, "driver_update", { cell, spot, parents });
  }, 1500);

  setTimeout(() => {
    pos = B;
    log("jumped to B");
  }, 75000);
}

main().catch((e) => {
  console.error("roamer crashed:", e);
  process.exit(1);
});
