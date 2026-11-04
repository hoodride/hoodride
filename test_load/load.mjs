// Real websockets at scale, against a running server: what the in-process
// soak/storm tests can't see (Phoenix.ChannelTest opens no real sockets, so
// the socket process, the per-socket topic, the take-over at connect and the
// join deadline only ever ran with a handful of sockets).
//
//   1. ARRIVAL: N users connect at once, each doing what the app does —
//      connect, join its user channel and the map, one sync.
//   2. MEMORY: the server's memory before and after, per connected user.
//   3. RECONNECT STORM: everyone drops and reconnects in the same second
//      (every phone after a deploy).
//   4. DEADLINE: 15 s later (past the 10 s join deadline) all still open.
//
// Run: node test_load/load.mjs [users=300]   (server on :4000, dev_login on)
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";
const N = Number(process.argv[2] || 300);
const CELL = "882a1072c7fffff";

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// the server's memory (the process listening on :4000), in MB
function serverMB() {
  const out = execSync(
    'powershell -NoProfile -Command "(Get-Process -Id (Get-NetTCPConnection -LocalPort 4000 -State Listen).OwningProcess).WorkingSet64"'
  )
    .toString()
    .trim();
  return Number(out) / 1048576;
}

async function login(name) {
  const r = await fetch(`${BASE}/api/dev_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agree_terms: true, name }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
  const { token } = await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json();
  return { me, token };
}

// one app: connect, join user + map, one sync → ms taken (or throws)
function app(user) {
  const t0 = performance.now();
  const ws = new WebSocket(`${WS}&token=${encodeURIComponent(user.token)}`);
  let ref = 0;
  const waiting = new Map();
  const a = { ws, moved: false, closed: false };
  ws.onmessage = (e) => {
    const [, r, , event, payload] = JSON.parse(e.data);
    if (event === "session_moved") a.moved = true;
    if (event === "phx_reply" && waiting.has(r)) waiting.get(r)(payload);
  };
  ws.onclose = () => (a.closed = true);
  const push = (topic, event, payload, joinRef) =>
    new Promise((res, rej) => {
      const r = String(++ref);
      waiting.set(r, res);
      ws.send(JSON.stringify([joinRef, r, topic, event, payload]));
      setTimeout(() => rej(new Error(`no reply to ${event} on ${topic}`)), 10000);
    });
  a.ready = (async () => {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("connect refused"));
    });
    const u = await push(`user:${user.me.id}`, "phx_join", {}, "1");
    if (u.status !== "ok") throw new Error(`user join: ${JSON.stringify(u.response)}`);
    const w = await push("world", "phx_join", {}, "2");
    if (w.status !== "ok") throw new Error(`map join: ${JSON.stringify(w.response)}`);
    const s = await push("world", "sync", { geo: [CELL] }, "2");
    if (s.status !== "ok") throw new Error(`sync: ${JSON.stringify(s.response)}`);
    return performance.now() - t0;
  })();
  return a;
}

async function wave(users, label) {
  const apps = users.map(app);
  const results = await Promise.allSettled(apps.map((a) => a.ready));
  const times = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
  console.log(
    `  ${label}: ${times.length}/${users.length} ready — p50 ${pct(times, 50)?.toFixed(0)} ms, ` +
      `p95 ${pct(times, 95)?.toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms`
  );
  if (errors.length) console.log(`    errors: ${[...new Set(errors)].slice(0, 3).join(" | ")} (${errors.length})`);
  return { apps, times, errors };
}

console.log(`real websockets at scale: ${N} users\n`);

console.log("  logging in users…");
const users = [];
for (let i = 0; i < N; i++) users.push(await login(`Load-${Date.now()}-${i}`));
await sleep(2000);
const mb0 = serverMB();

// 1. ARRIVAL
const first = await wave(users, "arrival (all at once)");
first.errors.length === 0 ? ok(`all ${N} connected, joined and synced`) : fail(`${first.errors.length} failed`);
pct(first.times, 95) < 2000 ? ok("p95 under 2 s") : fail(`p95 ${pct(first.times, 95).toFixed(0)} ms`);

// 2. MEMORY
await sleep(3000);
const mb1 = serverMB();
const perUser = ((mb1 - mb0) * 1024) / N;
console.log(`  server memory: ${mb0.toFixed(1)} MB → ${mb1.toFixed(1)} MB with ${N} live users`);
ok(`≈ ${perUser.toFixed(0)} KB per connected user (socket + user channel + map channel)`);

// 3. RECONNECT STORM: everyone drops at once, then everyone reconnects at once
for (const a of first.apps) a.ws.close();
await sleep(1000);
const second = await wave(users, "reconnect storm (all at once)");
second.errors.length === 0 ? ok(`all ${N} reconnected and settled`) : fail(`${second.errors.length} failed to reconnect`);
const moved = second.apps.filter((a) => a.moved).length;
moved === 0 ? ok("no one was told session_moved (the old sockets were really gone)") : fail(`${moved} told session_moved`);

// 4. DEADLINE: all joined their user channel, so none may be closed by it
await sleep(15000);
const stillOpen = second.apps.filter((a) => a.ws.readyState === WebSocket.OPEN).length;
stillOpen === N ? ok(`all ${N} still open 15 s later (the join deadline spares joined sockets)`) : fail(`${N - stillOpen} closed`);
const mb2 = serverMB();
console.log(`  server memory after the storm: ${mb2.toFixed(1)} MB`);

for (const a of second.apps) a.ws.close();
await sleep(2000);
console.log(`  server memory after everyone left: ${serverMB().toFixed(1)} MB`);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL LOAD CHECKS PASSED");
process.exit(failures ? 1 : 0);
