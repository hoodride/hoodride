// Real-websocket check that two rules can't trap a real app in a loop:
//   - the JOIN BUDGET refuses joins when spent (rate_limited)
//   - the JOIN DEADLINE closes a socket that hasn't joined its user channel
//     within 10 s
// If the app's user-channel join kept being refused past 10 s, the deadline
// would close its socket, it would reconnect, and so on. By reasoning it
// settles (refused joins spend nothing; the budget refills one join every
// 2 s; the user channel is the app's first join). This proves it.
//
// The simulated tab behaves like the real app: Phoenix rejoins a refused
// channel after rejoinAfterMs, reconnects a closed socket after
// reconnectAfterMs — both HoodSync.reconnectBackoff, the app's own — and a
// closed socket starts over unless it was told session_moved.
//
// Run: node e2e_join_deadline.mjs [rounds]   (server on :4000, dev_login on)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const HoodSync = require("./priv/static/sync.js");

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";
const ROUNDS = Number(process.argv[2] || 3);

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(name) {
  const r = await fetch(`${BASE}/api/dev_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agree_terms: true, name }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
  return { cookie, me };
}
const token = async (cookie) =>
  (await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json()).token;

function socketTo(tok) {
  const ws = new WebSocket(`${WS}&token=${encodeURIComponent(tok)}`);
  let ref = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const [, r, , event, payload] = JSON.parse(e.data);
    if (event === "phx_reply" && waiting.has(r)) waiting.get(r)(payload);
    if (ws.onevent) ws.onevent(event);
  };
  ws.push = (topic, event, payload, joinRef = "1") =>
    new Promise((res) => {
      const r = String(++ref);
      waiting.set(r, res);
      ws.send(JSON.stringify([joinRef, r, topic, event, payload]));
      setTimeout(() => res({ status: "timeout" }), 3000);
    });
  ws.opened = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return ws;
}

async function round(n) {
  const { cookie, me } = await login(`JD-${Date.now()}-${n}`);
  const topic = `user:${me.id}`;

  // 1. spend this account's join budget (joins to rides that don't exist:
  //    each spends a join, then fails "gone")
  const s0 = socketTo(await token(cookie));
  await s0.opened;
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const r = await s0.push(`ride:bogus${i}`, "phx_join", {}, String(100 + i));
    if (r.status === "error" && r.response.reason === "rate_limited") refused++;
  }
  if (refused === 0) return fail(`round ${n}: the join budget never ran out`);

  // 2. the app arrives with an EMPTY join budget
  const t0 = performance.now();
  const tab = { connects: 0, closesBeforeJoin: 0, refusedJoins: 0, joinedAt: null, live: null, moved: false };
  const log = [];
  const at = () => ((performance.now() - t0) / 1000).toFixed(1) + "s";

  const connect = async (attempt = 1) => {
    if (tab.moved) return;
    tab.connects++;
    const ws = socketTo(await token(cookie));
    tab.live = ws;
    let joined = false;
    ws.onevent = (event) => {
      if (event === "session_moved") tab.moved = true;
    };
    ws.onclose = () => {
      if (tab.live !== ws || tab.moved) return;
      if (!joined) tab.closesBeforeJoin++;
      log.push(`${at()} socket closed${joined ? "" : " before joining"}`);
      tab.joinedAt = null;
      setTimeout(() => connect(attempt + 1), HoodSync.reconnectBackoff(attempt));
    };
    try {
      await ws.opened;
    } catch (_) {
      log.push(`${at()} connect refused`);
      return; // onclose schedules the reconnect
    }
    log.push(`${at()} connected`);
    const tryJoin = async (tries) => {
      if (tab.live !== ws || ws.readyState !== WebSocket.OPEN) return;
      const r = await ws.push(topic, "phx_join", {});
      if (r.status === "ok") {
        joined = true;
        tab.joinedAt = performance.now();
        log.push(`${at()} user channel joined`);
      } else {
        tab.refusedJoins++;
        log.push(`${at()} join refused (${r.response && r.response.reason})`);
        setTimeout(() => tryJoin(tries + 1), HoodSync.reconnectBackoff(tries));
      }
    };
    tryJoin(1);
  };

  connect();
  // settled = joined and still open for 12 s past the join (beyond any deadline)
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    if (tab.joinedAt && performance.now() - tab.joinedAt > 12000) break;
  }

  const settled = tab.live && tab.live.readyState === WebSocket.OPEN && tab.joinedAt;
  console.log(`  round ${n}: ${log.join(" · ")}`);
  settled
    ? ok(`round ${n}: settled — joined at ${((tab.joinedAt - t0) / 1000).toFixed(1)} s, still open 12 s later`)
    : fail(`round ${n}: not settled after 40 s`);
  tab.connects <= 2
    ? ok(`round ${n}: ${tab.connects} connect(s), ${tab.closesBeforeJoin} deadline close(s), ${tab.refusedJoins} refused join(s) — no loop`)
    : fail(`round ${n}: ${tab.connects} connects, ${tab.closesBeforeJoin} closes before joining — a loop`);
  tab.live && tab.live.close();
}

console.log("join budget × join deadline: a real app arriving with an empty join budget:\n");
for (let n = 1; n <= ROUNDS; n++) await round(n);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL JOIN-DEADLINE CHECKS PASSED");
process.exit(failures ? 1 : 0);
