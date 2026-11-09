// THE MONSTER: a crowd of simulated people on REAL websockets, all at once,
// against a running server. Drivers go online, drive block to block, park,
// take ride requests, drive to their rider, arrive, finish rides, go
// offline. Riders pan and zoom, tap cars and piles, raise and lower ✋,
// message drivers, request rides, ride, set pins. And real life's mess:
// reloads, Wi-Fi blips, a second tab, Drive↔Ride switches.
//
// Every frame any agent receives is checked against the laws:
//   L1 privacy: once an agent's own state has been stable 3 s, a rider gets
//      no hands, an online driver no cars, someone in a ride no map frames
//   L2 a marker is {id, cell, spot} ({id} for a departure); a snapshot entry
//      likewise; a count carries one side — never a position, name or photo
//   L3 exact positions only on your own ride's channel, from your partner;
//      a (re)joining partner is handed the other's last one at once
//   L4 a second tab hands the old one over (session_moved, then it closes);
//      the device chosen last wins: a replaced tab coming back by itself
//      is refused (session_moved) and the live tab is never disturbed;
//      nobody else is ever told session_moved
//   L5 honest behaviour is never rate_limited (a refusal = a budget too
//      tight for real use)
//   L6 rides: both people hear it start; both hear it end
//   L7 no unexpected error reply (bad_request, crashes…)
//   L8 after the crowd leaves, a fresh observer sees no car and no ✋
// Plus reply times per action and the server's memory, wave after wave.
//
// Run: node test_load/monster.mjs [agents=150] [seconds_per_wave=150] [waves=2] [seed] [chaos=1]
//      (server on :4000, dev_login on)
import { createRequire } from "node:module";
import { exec } from "node:child_process";
const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const F = require("../priv/static/sendfilter.js");
const HoodSync = require("../priv/static/sync.js");
const HoodRehydrate = require("../priv/static/rehydrate.js");

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";
const N = Number(process.argv[2] || 150);
const SECONDS = Number(process.argv[3] || 150);
const WAVES = Number(process.argv[4] || 2);
const SEED = Number(process.argv[5] || Date.now() % 1e9);
// how often real life's mess strikes: 1 = each person every 30-90 s; 3 = 3× as often
const CHAOS = Number(process.argv[6] || 1);

// ---------- seeded randomness (so a failure can be rerun) ----------
let s = SEED >>> 0;
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;
const between = (a, b) => a + rnd() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------- the neighbourhood ----------
const CENTER = { lat: 40.7154, lng: -74.0086 };
const RADIUS_M = 1200;
const offset = (p, m, deg) => {
  const r = (deg * Math.PI) / 180;
  return {
    lat: p.lat + (m * Math.cos(r)) / 111195,
    lng: p.lng + (m * Math.sin(r)) / (111195 * Math.cos((p.lat * Math.PI) / 180)),
  };
};
const somewhere = () => offset(CENTER, Math.sqrt(rnd()) * RADIUS_M, rnd() * 360);
const AREA = h3.gridDisk(h3.latLngToCell(CENTER.lat, CENTER.lng, 8), 4); // the observer's view

// ---------- results ----------
const laws = { L1: [], L2: [], L3: [], L4: [], L5: [], L6: [], L7: [], L8: [] };
// EVERY violation is kept (a rare one hiding behind the first few printed
// went undiagnosed once): all of them go to a JSON file at the end
const violate = (law, agent, msg) => {
  laws[law].push(`${agent ? agent.name : "-"}: ${msg}`);
};
const lat = {}; // event → [ms]
// a slow reply is only the server's fault if THIS process wasn't frozen:
// every reply over 1 s is logged with the worst pause of our own event loop
// around it (a pause delays reading the reply, so it times as slow)
const slowReplies = []; // {event, topic, ms, at}
const loopPauses = []; // {at, ms}: this process didn't run for ms
{
  let last = performance.now();
  setInterval(() => {
    const t = performance.now();
    if (t - last > 250) loopPauses.push({ at: t, ms: t - last - 50 });
    last = t;
  }, 50).unref();
}
const counts = {};
const bump = (k, n = 1) => (counts[k] = (counts[k] || 0) + n);
const refusals = {};
const memory = [];
const pct = (xs, p) => {
  if (!xs || !xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
// asynchronous: starting PowerShell takes seconds, and a BLOCKING call froze
// this whole process meanwhile, so replies arriving then timed as 3-4 s
// "stalls" that were never the server's
function serverMB() {
  return new Promise((res) =>
    exec(
      'powershell -NoProfile -Command "(Get-Process -Id (Get-NetTCPConnection -LocalPort 4000 -State Listen).OwningProcess).WorkingSet64"',
      (err, out) => res(err ? NaN : Number(String(out).trim()) / 1048576)
    )
  );
}

// expected refusals: the world moved on between seeing and acting
const EXPECTED = new Set([
  "unavailable",
  "out_of_view",
  "driver_busy",
  "driver_offline",
  "already_requested",
  "request_cooldown",
  "rider_busy",
  "no_request",
  "not_found",
  "gone",
  "busy",
  "self",
  "not_driver",
  "already_arrived",
]);

// ---------- one real Phoenix connection ----------
class Conn {
  // params: the session stamp params (Hoodride.SessionStamp), as the app sends
  constructor(agent, token, params = {}) {
    this.agent = agent;
    const extra = Object.entries(params).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
    this.ws = new WebSocket(`${WS}&token=${encodeURIComponent(token)}${extra}`);
    this.ref = 0;
    this.joinRefs = new Map();
    this.waiting = new Map();
    this.closed = false;
    this.sessionMoved = 0;
    // topic → {p, done}: settles true/false when its join answers. A push
    // waits on it, like the Phoenix client buffering until joined (a push
    // sent before the join is "unmatched topic" — the real app never does that)
    this.joins = new Map();
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (ev) => {
        // why the client gave up on it (a 1006 says only "no close frame")
        this.error = ev.error ? `${ev.error.message}${ev.error.cause ? " / " + ev.error.cause.code + " " + ev.error.cause.message : ""}` : ev.message || "?";
        rej(new Error("connect refused"));
      };
    });
    this.ws.onclose = (ev) => {
      this.closed = true;
      this.closedAt = now();
      this.closeCode = ev.code;
      // who closed it, and how (1000 = a clean close by either side)
      agent.trace(`${this.tag} socket closed (code ${ev.code}${ev.reason ? " " + ev.reason : ""}, ${this.sessionMoved} session_moved before it${this.error ? ", error: " + this.error : ""}, last frame ${this.lastFrameAt ? now() - this.lastFrameAt + " ms ago" : "never"})`);
      if (ev.code === 1006) bump(`close_1006 (${this.error || "no error event"})`);
      for (const j of this.joins.values()) j.done(false);
      if (this.interval && this.interval.closedAt === null) this.interval.closedAt = now();
      clearInterval(this.hb);
      for (const w of this.waiting.values()) w.res({ status: "closed", response: {} });
      this.waiting.clear();
      agent.onClose(this);
    };
    this.ws.onmessage = (e) => {
      this.lastFrameAt = now();
      const [, ref, topic, event, payload] = JSON.parse(e.data);
      // like the app: live news a state snapshot could be overtaken by
      if (HoodRehydrate.countsAsLive({ topic, event })) agent.liveSeq++;
      if (event === "phx_reply") {
        const w = this.waiting.get(ref);
        if (w) {
          this.waiting.delete(ref);
          const ms = now() - w.t0;
          (lat[w.event] ||= []).push(ms);
          if (ms > 1000) slowReplies.push({ event: w.event, topic, ms, at: now(), t0: w.t0 });
          w.res(payload);
        }
        return;
      }
      if (event === "phx_close" || event === "phx_error") {
        // the server ended this topic: pushes to it can't be answered now
        const j = { settled: true, p: Promise.resolve(false), done: () => {} };
        this.joins.set(topic, j);
      }
      if (event === "phx_close" || event === "phx_error") agent.trace(`${this.tag} ${topic} ${event}`);
      if (event === "session_moved") {
        this.sessionMoved++;
        agent.trace(`${this.tag} told session_moved`);
        // its user channel is over from here: what's sent to the account
        // now goes to the newer socket (counting this one as listening until
        // its socket closed blamed the server for the hand-over's gap)
        if (this.interval && this.interval.closedAt === null) this.interval.closedAt = now();
      }
      agent.onFrame(this, topic, event, payload);
    };
    this.hb = setInterval(() => this.send(null, "phoenix", "heartbeat", {}), 25000);
  }
  send(joinRef, topic, event, payload) {
    if (this.ws.readyState !== WebSocket.OPEN) return null;
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    return ref;
  }
  push(topic, event, payload = {}) {
    this.agent.lastSent = JSON.stringify({ topic, event, payload });
    return new Promise((res) => {
      const ref = this.send(this.joinRefs.get(topic) || null, topic, event, payload);
      if (!ref) return res({ status: "closed", response: {} });
      this.waiting.set(ref, { res, t0: now(), event });
      setTimeout(() => {
        if (this.waiting.delete(ref)) res({ status: "timeout", response: {} });
      }, 10000);
    });
  }
  cast(topic, event, payload = {}) {
    this.send(this.joinRefs.get(topic) || null, topic, event, payload);
  }
  // the join of `topic`: the one a push is waiting on, or a fresh one
  joinOf(topic) {
    let j = this.joins.get(topic);
    if (!j || j.settled) {
      j = { settled: false };
      j.p = new Promise((r) => (j.done = (ok) => ((j.settled = true), r(ok))));
      if (this.closed) j.done(false);
      this.joins.set(topic, j);
    }
    return j;
  }
  // → true once `topic` is joined; false if refused, closed or never joined
  whenJoined(topic) {
    const j = this.joins.get(topic) || this.joinOf(topic);
    return Promise.race([j.p, sleep(10000).then(() => false)]);
  }
  async join(topic) {
    const joinRef = String(this.ref + 1);
    this.joinRefs.set(topic, joinRef);
    const j = this.joinOf(topic);
    return new Promise((res0) => {
      const res = (r) => {
        j.done(r.status === "ok");
        res0(r);
      };
      const ref = this.send(joinRef, topic, "phx_join", {});
      if (!ref) return res({ status: "closed", response: {} });
      this.waiting.set(ref, { res, t0: now(), event: "phx_join" });
      setTimeout(() => {
        if (this.waiting.delete(ref)) res({ status: "timeout", response: {} });
      }, 10000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

// ---------- an agent: one person ----------
class Agent {
  constructor(i, user) {
    this.i = i;
    this.name = user.me.name;
    this.id = user.me.id;
    this.cookie = user.cookie;
    this.kind = i % 5 < 2 ? "driver" : "rider";
    this.home = somewhere();
    this.pos = { ...this.home };
    this.view = { ...this.home };
    this.zoomedOut = false;
    this.conn = null;
    this.online = false; // a driver on duty (wants to be on the map)
    this.carSent = false; // the server has (been told about) our car
    this.hand = false;
    this.ride = null; // {id, role, peer, joined, arrived, startedAt, endAt, target}
    this.request = null; // {to, at}
    this.contacts = new Set(); // people this agent has contacted this wave
    // when this ACCOUNT started new contacts: the server's 20/hour is per
    // account and outlives a wave (the same accounts play every wave)
    this.coldLog = user.coldLog ||= [];
    this.liveSeq = 0; // live frames that /api/state also covers (see reloadState)
    this.declinedBy = new Set();
    this.seen = new Map(); // id → {type, cell, spot}
    this.stateSince = now();
    this.spot = null;
    this.lastGeo = null;
    this.syncing = false;
    this.syncDirty = false;
    this.handingOver = null;
    this.alive = true;
    this.intervals = []; // when this agent's user channel was live
    this.rideJoins = []; // {ride, joinedAt, conn}: when it was on a ride channel
    this.traceLog = [];
    this.connSeq = 0;
    // like the app (session.js): this tab's stamp — null until the server
    // gives it one; every automatic connect carries it
    this.stamp = null;
    this.staleStamp = null; // the stamp of the last tab a second tab replaced
  }
  mark() {
    this.stateSince = now();
  }
  // an honest person stays well under the server's 20 new contacts an hour
  mayContactNew() {
    while (this.coldLog.length && now() - this.coldLog[0] > 3_600_000) this.coldLog.shift();
    return this.contacts.size < 4 && this.coldLog.length < 9;
  }
  noteContact(id) {
    if (this.contacts.has(id)) return;
    this.contacts.add(id);
    this.coldLog.push(now());
  }
  trace(e) {
    this.traceLog.push(`${(now() / 1000).toFixed(1)}s@${Date.now()} ${e}`);
    if (this.traceLog.length > 60) this.traceLog.shift();
    // every event, kept, for "what happened around time t" (L6 reports)
    (this.fullLog ||= []).push({ t: now(), e: `${(now() / 1000).toFixed(3)}s ${e}` });
  }
  traceText() {
    return " | trace: " + this.traceLog.join(" › ");
  }
  traceAround(t, ms = 5000) {
    return " | around: " + (this.fullLog || []).filter((x) => Math.abs(x.t - t) <= ms).map((x) => x.e).join(" › ");
  }
  stable() {
    return now() - this.stateSince > 3000;
  }
  expectedLayer() {
    if (this.ride) return "none";
    if (this.online && this.carSent) return "hands";
    return "cars";
  }

  // like HoodSession.connectParams
  params() {
    return this.stamp === null ? { takeover: "true" } : { stamp: String(this.stamp), takeover: "false" };
  }

  async token() {
    const r = await fetch(`${BASE}/api/socket_token`, { headers: { cookie: this.cookie } });
    return (await r.json()).token;
  }

  // sends go through the CURRENT connection, if any (a reload swaps it)
  async call(topic, event, payload) {
    const c = this.conn;
    const closed = { status: "closed", response: {} };
    if (!c || c.closed) return closed;
    // like the app's channel: a push waits for its topic's join
    if (!(await c.whenJoined(topic))) return closed; // refused, closed, or never joined
    return c.closed ? closed : c.push(topic, event, payload);
  }
  castTo(topic, event, payload) {
    const c = this.conn;
    if (c && !c.closed) c.cast(topic, event, payload);
  }
  // was this agent's user channel live (joined, not closed) all through [a, b]?
  liveThrough(a, b) {
    return this.intervals.some((iv) => iv.joinedAt <= a && (iv.closedAt === null || iv.closedAt >= b));
  }
  // …and was it on THIS ride's channel all through [a, b]? ("ended" is sent
  // only there; a reconnect rejoins it last, after /api/state)
  onRideThrough(rideId, a, b) {
    return this.rideJoins.some(
      (j) => j.ride === rideId && j.joinedAt <= a && (!j.conn.closed || (j.conn.closedAt || 0) >= b)
    );
  }

  // connect like the app: socket, user channel, map, ride if any — then,
  // like the app's reconnect = reload, rebuild from /api/state (anything
  // pushed while we were away, e.g. a ride starting, is learned there)
  async connect(kind = "connect") {
    // a first connect and a reload are page loads (a CHOICE: no stamp yet);
    // a blip or a reconnect is automatic and carries this tab's stamp
    if (kind === "connect" || kind === "reloads") this.stamp = null;
    const conn = new Conn(this, await this.token(), this.params());
    try {
      await conn.opened;
    } catch (_) {
      bump("connect_refused");
      await sleep(HoodSync.reconnectBackoff(1));
      return this.alive ? this.connect(kind) : null;
    }
    if (!this.alive && kind !== "connect") {
      conn.close(); // left while this (re)connect was in flight
      this.trace(`${kind}: opened after leaving → closed`);
      return null;
    }
    this.conn = conn;
    conn.tag = `c${++this.connSeq}`;
    this.trace(`${kind}: ${conn.tag} open`);
    bump(kind === "connect" ? "connects" : kind);
    const u = await this.joinChecked(conn, `user:${this.id}`);
    if (u && u.status === "ok") {
      if (u.response && u.response.stamp) this.stamp = u.response.stamp;
      conn.interval = { joinedAt: now(), closedAt: null, tag: conn.tag };
      this.trace(`user joined on ${conn.tag}`);
      this.intervals.push(conn.interval);
    }
    const w = await this.joinChecked(conn, "world");
    this.mark(); // a fresh map: the role it holds is re-derived
    if (w && w.status === "ok") this.syncSoon();
    await this.reloadState();
    if (this.ride) await this.joinRide();
    return conn;
  }

  async reloadState() {
    let st;
    const askedAt = now();
    try {
      // like the app: a snapshot that live news overtook is taken again
      st = await HoodRehydrate.freshState({
        // the app's reload: the chat list (light reload, 2026-11-08)
        fetchState: async () => (await fetch(`${BASE}/api/state?chats=list`, { headers: { cookie: this.cookie } })).json(),
        liveCount: () => this.liveSeq,
      });
    } catch (_) {
      return;
    }
    this.trace(`state asked at ${(askedAt / 1000).toFixed(1)}s says ride=${st.ride ? st.ride.id : "none"} (we think ${this.ride ? this.ride.id : "none"})`);
    if (st.ride && (!this.ride || this.ride.id !== st.ride.id)) {
      bump("rides_learned_from_state");
      this.rideStarted({ ride_id: st.ride.id, role: st.ride.role, peer: st.ride.peer }, "state");
    } else if (!st.ride && this.ride) {
      bump("ride_ends_learned_from_state");
      this.rideEnded(this.ride.id, "state");
    }
    if (!st.open_request) this.request = null;
    this.hand = !!st.hand;
  }
  async joinChecked(conn, topic) {
    for (let tries = 1; tries <= 6; tries++) {
      const r = await conn.join(topic);
      if (r.status === "ok") return r;
      const reason = r.response && r.response.reason;
      if (r.status === "closed") return r;
      if (reason === "rate_limited") {
        violate("L5", this, `join ${topic} rate_limited`);
        await sleep(HoodSync.reconnectBackoff(tries));
        continue;
      }
      if (topic.startsWith("ride:") && (reason === "gone" || reason === "not_yours")) return r;
      // only ever the agent's live, chosen tab connects here: refusing it
      // breaks "the device you chose last wins"
      if (reason === "session_moved") {
        violate("L4", this, `the chosen tab ${conn.tag} was refused ${topic}: session_moved${this.traceText()}`);
        return r;
      }
      violate("L7", this, `join ${topic} → ${JSON.stringify(r.response)}`);
      return r;
    }
  }

  // ----- the map: what this person is looking at -----
  wish() {
    if (this.ride) return { geo: [], agg: [] };
    if (this.kind === "driver" && !this.online) return { geo: [], agg: [] };
    const c = this.kind === "driver" ? this.pos : this.view;
    if (this.zoomedOut) return { geo: [], agg: h3.gridDisk(h3.latLngToCell(c.lat, c.lng, 7), 1) };
    return { geo: h3.gridDisk(h3.latLngToCell(c.lat, c.lng, 8), 1), agg: [] };
  }
  syncSoon() {
    if (this.syncing) {
      this.syncDirty = true;
      return;
    }
    setTimeout(() => this.doSync(), 250); // the app's settle window
  }
  async doSync() {
    if (!this.conn || this.conn.closed) return;
    this.syncing = true;
    this.syncDirty = false;
    const r = await this.call("world", "sync", this.wish());
    this.syncing = false;
    if (r.status === "ok") {
      bump("syncs");
      for (const snap of r.response.geo || []) {
        for (const layer of ["drivers", "hands"]) {
          for (const m of snap[layer] || []) {
            this.checkShape("snapshot", m);
            this.seen.set(m.id, { type: layer === "drivers" ? "car" : "hand", cell: m.cell, spot: m.spot });
          }
        }
      }
    } else this.refused("sync", r);
    if (this.syncDirty) this.syncSoon();
  }

  checkShape(event, p) {
    const keys = Object.keys(p).sort().join(",");
    const want = event.endsWith("_left") ? "id" : "cell,id,spot";
    if (keys !== want) violate("L2", this, `${event} carried {${keys}}: ${JSON.stringify(p)}`);
  }

  refused(event, r, rideId) {
    const reason = (r.response && r.response.reason) || r.status;
    if (r.status === "closed" || r.status === "timeout") return bump(`${event}_${r.status}`);
    if (reason === "unmatched topic" && rideId) {
      setTimeout(() => {
        const b = RIDES[rideId];
        if (b && b.ended.size > 0) bump(`${event}_raced_ride_end`);
        else violate("L7", this, `${event} on ride:${rideId} → unmatched topic, but the ride never ended`);
      }, 3000);
      return reason;
    }
    (refusals[reason] ||= 0), refusals[reason]++;
    if (reason === "rate_limited") violate("L5", this, `${event} rate_limited`);
    else if (reason === "too_many_new_chats") violate("L5", this, `${event} too_many_new_chats`);
    else if (!EXPECTED.has(reason)) violate("L7", this, `${event} → ${JSON.stringify(r.response)}${this.lastSent ? " (sent " + this.lastSent + ")" : ""}${this.traceText()}`);
    return reason;
  }

  // ----- every frame, checked -----
  onFrame(conn, topic, event, p) {
    // (L6 hunt) a frame the agent IGNORES because it came on an older socket
    if (conn !== this.conn && !topic.startsWith("world"))
      this.trace(`ignored ${topic} ${event} on ${conn.tag} (current ${this.conn ? this.conn.tag : "none"})`);
    if (conn !== this.conn && event !== "session_moved") return;
    // a map batch (WorldChannel :map_batch_ms): every item is judged by the
    // same laws as a single message, in order
    if (topic === "world" && event === "batch") {
      bump("map_batches");
      if (!p || !Array.isArray(p.items) || !p.items.every((i) => Array.isArray(i) && i.length === 2 && typeof i[0] === "string"))
        return violate("L2", this, `malformed batch ${JSON.stringify(p)}`);
      for (const [e, ip] of p.items) this.onFrame(conn, topic, e, ip);
      return;
    }
    if (topic === "world") {
      const layer =
        event === "driver_update" || event === "driver_left"
          ? "cars"
          : event === "hand_update" || event === "hand_left"
            ? "hands"
            : event === "agg_update"
              ? "drivers" in p
                ? "cars"
                : "hands"
              : null;
      if (layer) {
        bump("map_frames");
        const want = this.expectedLayer();
        if (this.stable() && layer !== want)
          violate("L1", this, `${want === "none" ? "in a ride" : "expects " + want} but got ${event} ${JSON.stringify(p)}`);
        if (event === "agg_update") {
          const sides = Object.keys(p).filter((k) => k !== "cell");
          if (sides.length !== 1) violate("L2", this, `agg_update with ${sides}`);
        } else this.checkShape(event, p);
        if (event.endsWith("_left")) this.seen.delete(p.id);
        else if (event === "driver_update" || event === "hand_update") this.seen.set(p.id, { type: layer === "cars" ? "car" : "hand", cell: p.cell, spot: p.spot });
      }
      if (event === "role") this.mark();
      return;
    }
    if (topic.startsWith("ride:")) {
      if (event === "peer_pos") {
        bump("ride_positions");
        if (!this.ride || topic !== `ride:${this.ride.id}`) violate("L3", this, `peer_pos on ${topic} while ${this.ride ? "in " + this.ride.id : "not in a ride"}${this.traceText()}`);
        else if (p.from !== this.ride.peer) violate("L3", this, `peer_pos from ${p.from}, partner is ${this.ride.peer}`);
        else {
          this.ride.target = { lat: p.lat, lng: p.lng };
          // the first position after a (re)join is the hand-over (age_ms)
          const w = this.ride.awaitHandover;
          if (w && w.conn === conn) {
            this.ride.awaitHandover = null;
            if (typeof p.age_ms === "number") bump("position_handovers");
            else violate("L3", this, `rejoined ride ${this.ride.id}: a live position came before the hand-over${this.traceText()}`);
          }
        }
      } else if (event === "pin" && this.ride && p.pin) this.ride.target = p.pin;
      else if (event === "arrived" && this.ride) this.ride.arrived = true;
      else if (event === "ended") this.rideEnded(topic.slice(5));
      return;
    }
    // the user channel
    if (event === "session_moved") {
      if (conn !== this.conn) {
        this.trace(`session_moved on stale ${conn.tag}`);
        return bump("stale_socket_handed_over");
      }
      if (!this.handingOver) violate("L4", this, `the LIVE connection ${conn.tag} was told session_moved without a second tab${this.traceText()}`);
      return;
    }
    if (event === "ride_started") return this.rideStarted(p);
    if (event === "request" && this.kind === "driver") return this.onRequest(p.from);
    if (event === "request_declined" || event === "request_expired") {
      if (this.request) this.declinedBy.add(this.request.to);
      this.request = null;
      bump(event);
      return;
    }
    if (event === "msg") return bump("msgs_received");
    if (event === "chat_closed") return bump("chats_closed");
  }

  onClose(conn) {
    if (conn !== this.conn) return;
    if (this.handingOver && conn === this.handingOver.old) return;
    if (this.alive && !this.reconnecting) {
      // closed by the server (it shouldn't, for a joined honest app)
      bump("unexpected_closes");
      violate("L7", this, "socket closed by the server");
      this.reconnecting = true;
      setTimeout(async () => {
        await this.connect("reconnects");
        this.reconnecting = false;
      }, HoodSync.reconnectBackoff(1));
    }
  }

  // ----- rides -----
  async onRequest(from) {
    bump("requests_received");
    await sleep(between(500, 2500));
    if (!this.conn || this.ride || !this.online) return;
    if (chance(0.75)) {
      // the server starts the ride between this send and its reply: the
      // window "was the other party listening when it started?" is judged on
      const sentAt = now();
      const r = await this.call(`user:${this.id}`, "accept_request", { rider_id: from.id });
      if (r.status === "ok") ACCEPTS.set(`${this.id}:${from.id}`, { sentAt, repliedAt: now() });
      if (r.status === "ok") bump("accepted");
      else this.refused("accept_request", r);
    } else {
      const r = await this.call(`user:${this.id}`, "decline_request", { rider_id: from.id });
      if (r.status === "ok") bump("declined");
      else this.refused("decline_request", r);
    }
  }
  rideStarted(p, via = "live") {
    bump(`ride_started_${p.role}`);
    const book = (RIDES[p.ride_id] ||= { started: new Map(), ended: new Map(), endAt: null, agents: new Map() });
    book.started.set(this.id, { via, at: now() });
    book.parties ||= new Set();
    book.parties.add(this.id);
    book.parties.add(p.peer.id);
    book.agents.set(this.id, this);
    this.ride = { id: p.ride_id, role: p.role, peer: p.peer.id, arrived: false, startedAt: now(), target: null };
    this.trace(`ride:${p.ride_id} started (${via})`);
    this.request = null;
    this.hand = false;
    this.online = false; // the server took us off the map
    this.carSent = false;
    this.seen.clear();
    this.mark();
    this.joinRide();
  }
  async joinRide() {
    if (!this.ride || !this.conn) return;
    const conn = this.conn;
    // like the app's startRealRide: never join the same ride twice on one
    // socket (Phoenix closes the first join: the phx_close in L6 traces)
    if (this.ride.joiningOn === conn || this.ride.joinedOn === conn) return;
    this.ride.joiningOn = conn;
    // the partner had already sent a position (with margin for it to be
    // stored): the server must hand it over at once, before anything live.
    // Expected BEFORE the join goes out — Node's WebSocket can deliver the
    // join reply and the hand-over back to back, before the code after an
    // awaited join runs (a browser runs it in between: separate tasks)
    const first = (RIDES[this.ride.id]?.posFirst || {})[this.ride.peer];
    if (first !== undefined && first < now() - 300) this.ride.awaitHandover = { conn, at: now() };
    const r = await this.joinChecked(conn, `ride:${this.ride.id}`);
    if (r && r.status === "ok" && this.ride) {
      this.ride.joinedOn = conn;
      this.rideJoins.push({ ride: this.ride.id, joinedAt: now(), conn });
      this.trace(`ride:${this.ride.id} joined on ${conn.tag}`);
    }
    if (r && r.status === "error") this.trace(`ride join → ${JSON.stringify(r.response)}`);
    if (r && r.status === "error" && ["gone", "not_yours"].includes(r.response.reason) && this.ride) this.rideEnded(this.ride.id);
  }
  rideEnded(id, via = "live") {
    const book = RIDES[id];
    if (book) book.ended.set(this.id, { via, at: now() });
    this.trace(`ride:${id} ended (${via})`);
    if (this.ride && this.ride.id === id) {
      bump(`ride_ended_${this.ride.role}`);
      this.ride = null;
      this.mark();
      this.syncSoon();
    }
  }

  // ----- the tick: what the app does every 1.5 s -----
  tick() {
    if (!this.conn || this.conn.closed) return;
    const w = this.ride && this.ride.awaitHandover;
    if (w && w.conn === this.conn && now() - w.at > 1500) {
      this.ride.awaitHandover = null;
      violate("L3", this, `rejoined ride ${this.ride.id} but wasn't handed the partner's last position within 1.5 s${this.traceText()}`);
    }
    if (this.ride && this.ride.joinedOn !== this.conn) return; // (re)joining: the app's channel buffers until joined
    if (this.ride) {
      if (this.ride.role === "driver") {
        const target = this.ride.target || this.home;
        this.pos = stepToward(this.pos, target, 15);
        if (!this.ride.arrived && F.metersBetween(this.pos, target) < 35) {
          this.ride.arrived = true;
          const rideId = this.ride.id;
          this.call(`ride:${rideId}`, "arrived").then((r) => {
            if (r.status !== "ok") this.refused("arrived", r, rideId);
            else bump("arrived");
          });
          this.ride.endAt = now() + between(3000, 9000);
        }
        if (this.ride.endAt && now() > this.ride.endAt) {
          RIDES[this.ride.id].endAt ||= now();
          this.castTo(`ride:${this.ride.id}`, "end_ride");
          this.ride.endAt = null;
        }
      } else if (now() - this.ride.startedAt > 120000) {
        // a driver that vanished: the rider ends it
        RIDES[this.ride.id].endAt ||= now();
        this.castTo(`ride:${this.ride.id}`, "end_ride");
      }
      // when each party first sent a position (the hand-over check below)
      const book = RIDES[this.ride.id];
      if (book) (book.posFirst ||= {})[this.id] ??= now();
      this.castTo(`ride:${this.ride.id}`, "pos", { lat: this.pos.lat, lng: this.pos.lng });
      return;
    }
    if (this.kind === "driver" && this.online) {
      if (!this.waypoint || F.metersBetween(this.pos, this.waypoint) < 20) {
        this.waypoint = chance(0.3) ? this.pos : somewhere(); // sometimes park
        this.parkedUntil = now() + between(0, 15000);
      }
      if (now() > (this.parkedUntil || 0)) this.pos = stepToward(this.pos, this.waypoint, 15);
      const spot = F.stickySpot(this.spot, { ...this.pos, accuracy: 10 }, h3, 9);
      const moved = spot !== this.spot;
      this.spot = spot;
      if (F.shouldSend(this.lastGeo, Date.now(), this.pos, spot, F.BROWSE_MIN_METERS)) {
        this.lastGeo = F.stamp(this.pos, spot, Date.now(), rnd);
        const { cell, parents } = F.cellsOf(spot, h3, 8, [7, 5]);
        this.castTo(`user:${this.id}`, "driver_update", { cell, spot, parents });
        if (!this.carSent) {
          this.carSent = true;
          this.mark();
        }
        bump("car_updates");
      }
      if (moved && h3.cellToParent(spot, 8) !== this.lastWishCell) {
        this.lastWishCell = h3.cellToParent(spot, 8);
        this.syncSoon(); // the driver's map follows the car
      }
    }
  }

  // ----- what a person decides to do next -----
  async act() {
    if (!this.conn || this.conn.closed || this.ride) return;
    const user = `user:${this.id}`;
    if (this.kind === "driver") {
      if (!this.online) {
        if (chance(0.7)) {
          this.online = true;
          this.lastGeo = null;
          this.spot = null;
          this.mark();
          this.syncSoon();
          bump("went_online");
        }
        return;
      }
      if (chance(0.08)) {
        this.castTo(user, "driver_offline");
        this.online = false;
        this.carSent = false;
        this.seen.clear();
        this.mark();
        this.syncSoon();
        bump("went_offline");
        return;
      }
      // message a ✋ we can see (cold contact, sparingly)
      const hands = [...this.seen].filter(([, m]) => m.type === "hand");
      if (hands.length && this.mayContactNew() && chance(0.25)) {
        const [id] = pick(hands);
        const rv = await this.call("world", "reveal", { id });
        rv.status === "ok" ? bump("reveals") : this.refused("reveal", rv);
        if (rv.status === "ok" && !this.contacts.has(id)) {
          this.noteContact(id);
          const r = await this.call(user, "send_msg", { to: id, text: "need a ride? 🚗" });
          r.status === "ok" ? bump("msgs_sent") : this.refused("send_msg", r);
        }
      }
      return;
    }

    // a rider
    if (chance(0.35)) {
      this.view = chance(0.5) ? offset(this.view, between(200, 700), rnd() * 360) : { ...this.home };
      this.zoomedOut = chance(0.15);
      bump("pans");
      this.syncSoon();
      return;
    }
    if (!this.hand && !this.request && chance(0.25)) {
      this.pos = { ...this.home };
      const spot = F.stickySpot(this.spot, { ...this.pos, accuracy: 10 }, h3, 9);
      this.spot = spot;
      const { cell, parents } = F.cellsOf(spot, h3, 8, [7, 5]);
      this.castTo(user, "hand_up", { cell, spot, parents });
      this.hand = true;
      this.mark();
      bump("hands_up");
      return;
    }
    if (this.hand && chance(0.1)) {
      this.castTo(user, "hand_down");
      this.hand = false;
      this.mark();
      bump("hands_down");
      return;
    }
    if (this.request) {
      if (now() - this.request.at > 20000) {
        const r = await this.call(user, "cancel_request");
        r.status === "ok" ? bump("cancelled") : this.refused("cancel_request", r);
        this.declinedBy.add(this.request.to);
        this.request = null;
      }
      return;
    }
    // tap a car we can see (a pile of several costs a reveal each)
    const cars = [...this.seen].filter(([id, m]) => m.type === "car" && !this.declinedBy.has(id));
    if (!cars.length || this.zoomedOut) return;
    const [id, car] = pick(cars);
    const pile = cars.filter(([, m]) => m.spot === car.spot);
    for (const [pid] of pile.slice(0, 4)) {
      const rv = await this.call("world", "reveal", { id: pid });
      rv.status === "ok" ? bump("reveals") : this.refused("reveal", rv);
    }
    if (!this.contacts.has(id) && !this.mayContactNew()) return;
    this.noteContact(id);
    if (chance(0.4)) {
      const r = await this.call(user, "send_msg", { to: id, text: "hey, free now?" });
      r.status === "ok" ? bump("msgs_sent") : this.refused("send_msg", r);
    }
    if (chance(0.7)) {
      const r = await this.call(user, "request_ride", { to: id });
      if (r.status === "ok") {
        this.request = { to: id, at: now() };
        bump("requests_sent");
      } else this.refused("request_ride", r);
    }
  }

  // ----- real life's mess -----
  async chaos() {
    if (!this.conn || this.conn.closed || this.reconnecting) return;
    const what = pick(["reload", "blip", "second_tab", "second_tab", "stale_return", "switch_mode"]);
    this.trace(`chaos ${what}${this.conn ? " on " + this.conn.tag : ""}`);
    if (what === "switch_mode" && (this.ride || this.request)) return;
    this.reconnecting = true;
    try {
      if (what === "reload" || what === "blip") {
        const old = this.conn;
        this.conn = null;
        old.close();
        await sleep(what === "blip" ? 300 : 1000);
        await this.connect(what === "blip" ? "blips" : "reloads");
        // a driver on duty: the app re-announces its car on the next tick
        this.lastGeo = null;
      } else if (what === "second_tab") {
        const old = this.conn;
        this.handingOver = { old };
        // a new tab: a page load, a choice
        const fresh = new Conn(this, await this.token(), { takeover: "true" });
        try {
          await fresh.opened;
        } catch (_) {
          bump("connect_refused");
          this.handingOver = null;
          return;
        }
        this.conn = fresh;
        fresh.tag = `c${++this.connSeq}`;
        this.trace(`second_tab: ${fresh.tag} open (old ${old.tag})`);
        const u = await this.joinChecked(fresh, `user:${this.id}`);
        if (u && u.status === "ok") {
          // the old tab's stamp, for a later "stale tab returns"
          this.staleStamp = this.stamp;
          if (u.response && u.response.stamp) this.stamp = u.response.stamp;
          fresh.interval = { joinedAt: now(), closedAt: null, tag: fresh.tag };
          this.trace(`user joined on ${fresh.tag}`);
          this.intervals.push(fresh.interval);
        }
        await this.joinChecked(fresh, "world");
        // like the app's new tab: listening now, so take the snapshot — a
        // ride that started while the old tab was being closed and this one
        // wasn't listening yet is only learned here
        await this.reloadState();
        if (this.ride) await this.joinRide();
        this.mark();
        this.syncSoon();
        this.lastGeo = null;
        // the old tab: told it moved, then closed by the server
        for (let i = 0; i < 30 && !old.closed; i++) await sleep(100);
        // the server sends "you moved" every time (proven at the socket write,
        // 2026-10-25); this Node client very rarely loses it with a 1006 drop.
        // Harmless since session stamps: that tab can't come back and take
        // over (checked by "stale_return"). Any OTHER miss is the server's.
        if (old.sessionMoved < 1 && old.closeCode === 1006) bump("old_tab_lost_moved_1006_client_side");
        else if (old.sessionMoved < 1) violate("L4", this, `user ${this.id}: the old tab ${old.tag} was never told session_moved (closed: ${old.closed}, code ${old.closeCode})${this.traceText()}`);
        if (!old.closed) violate("L4", this, `the old tab ${old.tag} is still open 3 s after the hand-over${this.traceText()}`);
        if (fresh.sessionMoved > 0) violate("L4", this, "the NEW tab was told session_moved (a kick loop)");
        bump("handovers");
        this.handingOver = null;
      } else if (what === "stale_return") {
        // the tab a second tab replaced never heard "you moved" (a tunnel; the
        // drop the hunt found below the server) and comes back BY ITSELF with
        // its old stamp. It must be refused; the live tab must not notice.
        if (!this.staleStamp || !this.conn || this.conn.closed) return;
        const live = this.conn;
        const movedBefore = live.sessionMoved;
        const stale = new Conn(this, await this.token(), { stamp: String(this.staleStamp), takeover: "false" });
        stale.tag = `stale-c${this.connSeq}`;
        try {
          await stale.opened;
        } catch (_) {
          bump("connect_refused");
          return;
        }
        this.trace(`stale tab returns: ${stale.tag}`);
        const r = await stale.join(`user:${this.id}`);
        for (let i = 0; i < 30 && !stale.closed; i++) await sleep(100);
        if (!(r.status === "error" && r.response && r.response.reason === "session_moved"))
          violate("L4", this, `a replaced tab came back by itself and was let in: ${JSON.stringify(r)}${this.traceText()}`);
        if (!stale.closed) violate("L4", this, `the returning stale tab is still open 3 s later${this.traceText()}`);
        stale.close();
        if (live.sessionMoved > movedBefore || (live.closed && this.conn === live))
          violate("L4", this, `the live tab ${live.tag} was disturbed by a stale tab returning${this.traceText()}`);
        bump("stale_returns_refused");
      } else {
        // Drive ↔ Ride: what the app's mode button does
        const user = `user:${this.id}`;
        if (this.kind === "driver") {
          if (this.online) this.castTo(user, "driver_offline");
          this.online = false;
          this.carSent = false;
          this.kind = "rider";
        } else {
          if (this.hand) this.castTo(user, "hand_down");
          this.hand = false;
          this.kind = "driver";
        }
        this.seen.clear();
        this.mark();
        this.syncSoon();
        bump("mode_switches");
      }
    } finally {
      this.reconnecting = false;
    }
  }

  async leave() {
    this.alive = false;
    for (let i = 0; i < 100 && this.reconnecting; i++) await sleep(100);
    this.trace(`leave on ${this.conn ? this.conn.tag + (this.conn.closed ? " (closed)" : "") : "no conn"}`);
    if (!this.conn || this.conn.closed) {
      const conn = new Conn(this, await this.token(), this.params());
      try {
        await conn.opened;
      } catch (_) {
        return;
      }
      conn.tag = `c${++this.connSeq}`;
      this.conn = conn;
      this.trace(`leave: ${conn.tag} opened just to turn off`);
      await conn.join(`user:${this.id}`);
    }
    const user = `user:${this.id}`;
    if (this.ride) {
      RIDES[this.ride.id].endAt ||= now();
      this.castTo(`ride:${this.ride.id}`, "end_ride");
      await sleep(500);
    }
    if (this.request) await this.call(user, "cancel_request");
    // off duty from here: the server makes us a viewer, and a viewer's map
    // gets the car layer — e.g. the driver_left of everyone else leaving at
    // a wave's end (L1 flagged exactly that while we still thought "online")
    this.online = false;
    this.carSent = false;
    this.mark();
    this.castTo(user, "driver_offline");
    this.castTo(user, "hand_down");
    await this.call(user, "__barrier__"); // the casts above are processed
    this.conn.close();
  }
}

function stepToward(p, target, m) {
  const d = F.metersBetween(p, target);
  if (d <= m) return { ...target };
  const t = m / d;
  return { lat: p.lat + (target.lat - p.lat) * t, lng: p.lng + (target.lng - p.lng) * t };
}

const RIDES = {};
// performance.now() → wall clock (to line up with the fixtures' accept log)
const WALL0 = Date.now() - performance.now();
const wall = (t) => Math.round(WALL0 + t);
// rides whose start time we can't see (a fixture accepted), learned from
// /api/state: dumped with the rider's live windows for the L6 cross-check
const unknownStarts = [];
// "driverId:riderId" → when the accept that started their ride was sent and answered
const ACCEPTS = new Map();

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

// a fresh pair of eyes: as a viewer, then as an online driver far away
async function observe() {
  const user = await login(`Monster-Observer-${SEED}`);
  const a = new Agent(-1, user);
  a.kind = "rider";
  a.alive = false; // no reconnecting
  const conn = new Conn(a, await a.token());
  a.conn = conn;
  await conn.opened;
  await conn.join(`user:${a.id}`);
  await conn.join("world");
  const cars = await conn.push("world", "sync", { geo: AREA, agg: [] });
  const carIds = (cars.response.geo || []).flatMap((s) => (s.drivers || []).map((d) => d.id));
  const carCount = carIds.length;
  // become an online driver far away, to be allowed to see hands
  const far = h3.latLngToCell(CENTER.lat + 1, CENTER.lng, 9);
  conn.cast(`user:${a.id}`, "driver_update", { cell: h3.cellToParent(far, 8), spot: far, parents: [] });
  await conn.push(`user:${a.id}`, "__barrier__");
  await sleep(500);
  const hands = await conn.push("world", "sync", { geo: AREA.slice(0, -1), agg: [] });
  const handIds = (hands.response.geo || []).flatMap((s) => (s.hands || []).map((h) => h.id));
  const handCount = handIds.length;
  conn.cast(`user:${a.id}`, "driver_offline");
  await conn.push(`user:${a.id}`, "__barrier__");
  conn.close();
  return { carCount, handCount, carIds, handIds };
}

async function report(t, agents) {
  const p95 = (e) => {
    const v = pct(lat[e], 95);
    return isNaN(v) ? "-" : `${v.toFixed(0)}`;
  };
  const live = agents.filter((a) => a.conn && !a.conn.closed).length;
  const mb = await serverMB();
  memory.push(mb);
  const c = (k) => counts[k] || 0;
  const v = Object.values(laws).reduce((n, xs) => n + xs.length, 0);
  console.log(
    `  t=${String(t).padStart(4)}s live ${live} · drivers online ${agents.filter((a) => a.online).length} · ` +
      `in rides ${agents.filter((a) => a.ride).length} · rides ${c("ride_started_driver")} started/${c("ride_ended_driver")} ended · ` +
      `msgs ${c("msgs_sent")} · reveals ${c("reveals")} · syncs ${c("syncs")} · map frames ${c("map_frames")} · ` +
      `reloads ${c("reloads") + c("blips")} · hand-overs ${c("handovers")} · p95 ms sync ${p95("sync")} reveal ${p95("reveal")} ` +
      `msg ${p95("send_msg")} join ${p95("phx_join")} · mem ${mb.toFixed(0)} MB · violations ${v}`
  );
}

// ================= self-test: do the laws bite? =================
// `node test_load/monster.mjs selftest` feeds each checker a frame that breaks its
// law and confirms it is flagged — a checker that never fails proves nothing.
if (process.argv[2] === "selftest") {
  const fake = { me: { id: 1, name: "Selftest" }, cookie: "" };
  const a = new Agent(1, fake); // a rider
  const conn = { closed: false };
  a.conn = conn;
  a.stateSince = now() - 10000; // settled
  const cases = [
    ["L1", () => a.onFrame(conn, "world", "hand_update", { id: 9, cell: "c", spot: "s" })],
    ["L2", () => a.onFrame(conn, "world", "driver_update", { id: 9, cell: "c", spot: "s", name: "Maria" })],
    ["L2", () => a.onFrame(conn, "world", "agg_update", { cell: "c", drivers: 1, hands: 2 })],
    // inside a batch, the same laws
    ["L1", () => a.onFrame(conn, "world", "batch", { items: [["driver_left", { id: 8 }], ["hand_update", { id: 9, cell: "c", spot: "s" }]] })],
    ["L2", () => a.onFrame(conn, "world", "batch", { items: [["driver_update", { id: 9, cell: "c", spot: "s", photo: "x" }]] })],
    ["L2", () => a.onFrame(conn, "world", "batch", { items: "nope" })],
    ["L3", () => a.onFrame(conn, "ride:r1", "peer_pos", { from: 9, lat: 1, lng: 2 })],
    ["L4", () => a.onFrame(conn, "user:1", "session_moved", {})],
    ["L1", () => {
      a.ride = { id: "r2", peer: 5 };
      a.onFrame(conn, "world", "driver_update", { id: 9, cell: "c", spot: "s" });
      a.ride = null;
    }],
    ["L5", () => a.refused("sync", { status: "error", response: { reason: "rate_limited" } })],
    ["L7", () => a.refused("send_msg", { status: "error", response: { reason: "bad_request" } })],
  ];
  let ok = 0;
  for (const [law, run] of cases) {
    const before = laws[law].length;
    run();
    const bit = laws[law].length > before;
    console.log(`  ${bit ? "BITES" : "MISSES"}  ${law}: ${laws[law][laws[law].length - 1] || "(nothing flagged)"}`);
    if (bit) ok++;
  }
  console.log(ok === cases.length ? "\nEVERY LAW BITES" : `\n${cases.length - ok} LAW(S) MISSED`);
  process.exit(ok === cases.length ? 0 : 1);
}

// ================= main =================
console.log(`THE MONSTER: ${N} people × ${WAVES} wave(s) × ${SECONDS} s · chaos ×${CHAOS} · seed ${SEED}\n`);
console.log("  logging in…");
const users = [];
const RUN = Date.now() % 1e6;
for (let i = 0; i < N; i++) users.push(await login(`Monster-${SEED}-${RUN}-${i}`));
const idleBefore = await serverMB();
console.log(`  server memory before: ${idleBefore.toFixed(1)} MB\n`);
const idleAfter = [];

for (let wave = 1; wave <= WAVES; wave++) {
  console.log(`  ── wave ${wave} ──`);
  const agents = users.map((u, i) => new Agent(i, u));
  // people arrive over ~10 s, not in one instant
  await Promise.all(
    agents.map(async (a) => {
      await sleep(rnd() * 10000);
      await a.connect();
    })
  );
  const t0 = now();
  const timers = [];
  for (const a of agents) {
    timers.push(setInterval(() => a.tick(), 1500));
    const life = async () => {
      while (a.alive && now() - t0 < SECONDS * 1000) {
        await sleep(between(2000, 8000));
        if (a.alive) await a.act().catch((e) => violate("L7", a, `crash in act: ${e.message}`));
      }
    };
    const mess = async () => {
      while (a.alive && now() - t0 < SECONDS * 1000) {
        await sleep(between(30000, 90000) / CHAOS);
        if (a.alive && now() - t0 < SECONDS * 1000) await a.chaos().catch((e) => violate("L7", a, `crash in chaos: ${e.message}`));
      }
    };
    life();
    mess();
  }
  const reporter = setInterval(() => report(Math.round((now() - t0) / 1000), agents), 30000);
  await sleep(SECONDS * 1000);
  const waveEnd = now();
  clearInterval(reporter);
  await report(Math.round((now() - t0) / 1000), agents);

  // everyone leaves; rides wind down first
  for (const t of timers) clearInterval(t);
  await Promise.all(agents.map((a) => a.leave().catch(() => {})));
  await sleep(3000);

  // L6: both people learn a ride started, and that it ended. Live, or —
  // if they were away at that moment — from /api/state on reconnect (the
  // app's reconnect = reload). Missing it while CONNECTED is a server bug.
  // "Connected" for "ended" means on the RIDE channel (the only place it's
  // sent): a reconnect rejoins that last, after /api/state, so an end in
  // that gap is learned from the state — like the app.
  const byId = new Map(agents.map((a) => [a.id, a]));
  // `at` null: the start time is unknown (the accepting driver is a fixture,
  // outside the test) — "was it connected then?" can't be judged fairly
  const judge = (id, what, heard, at, until = null) => {
    for (const pid of RIDES[id].parties) {
      const h = heard.get(pid);
      const ag = byId.get(pid);
      // the other party isn't one of ours (e.g. a browser fixture): the test
      // can't see what they heard — count it apart, judge only our side
      if (!ag) {
        bump(`${what}_party_outside_the_test`);
        continue;
      }
      if (h && h.via === "live") continue;
      // listening from just before it happened to a second after (with a
      // known start window: through ALL of it, so it surely covered the send)
      const to = (until ?? at) + 1000;
      const listening = (ag2) =>
        what === "ended" ? ag2.onRideThrough(id, at - 50, to) : ag2.liveThrough(at - 50, to);
      if (at === null) {
        if (h) bump(`${what}_learned_${h.via}_start_time_unknown`);
        if (h && h.via === "state")
          unknownStarts.push({
            ride: id,
            agent: ag.name,
            id: ag.id,
            learnedAt: wall(h.at),
            live: ag.intervals.map((iv) => [wall(iv.joinedAt), iv.closedAt === null ? null : wall(iv.closedAt)]),
          });
        else violate("L6", ag, `${id}: never learned of "${what}"${ag.traceText()}`);
        continue;
      }
      const connected = ag && listening(ag);
      if (h && h.via === "state") {
        if (connected) violate("L6", ag, `${id}: missed "${what}" while CONNECTED (learned it only from /api/state) — first party learned at ${(at / 1000).toFixed(3)}s, intervals ${JSON.stringify(ag.intervals.filter((iv) => iv.joinedAt <= at + 1000 && (iv.closedAt === null || iv.closedAt >= at - 50)).map((iv) => [+(iv.joinedAt / 1000).toFixed(3), iv.closedAt && +(iv.closedAt / 1000).toFixed(3), iv.tag]))}${ag.traceAround(at)}`);
        else if (what === "ended" && ag && ag.liveThrough(at - 50, at + 1000)) {
          bump("ended_missed_while_rejoining_ride_then_learned");
          console.log(`  note: ${ag.name} ${id}: "ended" fell in the reconnect gap (user channel up, ride channel not yet)${ag.traceText()}`);
        } else bump(`${what}_missed_while_away_then_learned`);
      } else if (connected) violate("L6", ag, `${id}: never heard "${what}" although connected the whole time${ag.traceText()}`);
      else violate("L6", ag, `${id}: never learned of "${what}" (away, and never reloaded)${ag ? ag.traceText() : ""}`);
    }
  };
  for (const [id, b] of Object.entries(RIDES)) {
    if (b.checked || !b.parties) continue;
    b.checked = true;
    // when did it START? The accept window, if one of ours accepted (the
    // server starts the ride between the accept's send and reply). It used
    // to be "the first moment a party heard": when every party we can see
    // was away and learned from /api/state after reconnecting, that time is
    // AFTER the reconnect, so they were judged "connected" at a start they
    // were away for — the L6 false positive the 2026-10-25 hunt caught (7
    // cases over two runs, each one a reload/blip spanning the start). With
    // a fixture driver the start time is unknown: judged apart.
    const ps = [...b.parties];
    const acc = ACCEPTS.get(`${ps[0]}:${ps[1]}`) || ACCEPTS.get(`${ps[1]}:${ps[0]}`);
    if (!acc) bump("ride_start_window_unknown_party_outside_the_test");
    judge(id, "ride_started", b.started, acc ? acc.sentAt : null, acc ? acc.repliedAt : null);
    // ends during the leave phase don't count: both are disconnecting on purpose
    const ends = [...b.ended.values()].map((x) => x.at);
    if (ends.length && Math.min(...ends) < waveEnd) judge(id, "ended", b.ended, Math.min(...ends));
  }

  // L8: a fresh observer sees an empty neighbourhood
  const seen = await observe();
  for (const id of seen.carIds) {
    const ag = agents.find((a) => a.id === id);
    if (ag) violate("L8", ag, `wave ${wave}: car left on the map${ag.traceText()}`);
    else bump("strangers_cars_seen_by_observer");
  }
  for (const id of seen.handIds) {
    const ag = agents.find((a) => a.id === id);
    if (ag) violate("L8", ag, `wave ${wave}: ✋ left on the map${ag.traceText()}`);
    else bump("strangers_hands_seen_by_observer");
  }
  await sleep(3000);
  idleAfter.push(await serverMB());
  console.log(
    `  after wave ${wave}: the map is ${seen.carCount + seen.handCount === 0 ? "empty" : "NOT empty"} · ` +
      `server memory idle ${idleAfter[idleAfter.length - 1].toFixed(1)} MB\n`
  );
  // the next wave: same people, fresh agents (their 20/hour cold budget carries over)
  for (const u of users) u.contacts = undefined;
}

// ================= verdict =================
console.log("  totals: " + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · "));
console.log("  refusals (the world moved on — expected): " + JSON.stringify(refusals));
console.log("\n  reply times (ms)  p50 / p95 / max:");
for (const [e, xs] of Object.entries(lat))
  console.log(`    ${e.padEnd(16)} ${pct(xs, 50).toFixed(1)} / ${pct(xs, 95).toFixed(1)} / ${Math.max(...xs).toFixed(1)}   (${xs.length})`);
{
  // was each slow reply the server, or this process frozen while it waited?
  const frozenDuring = (r) =>
    loopPauses.filter((p) => p.at >= r.t0 && p.at - p.ms <= r.at).reduce((s, p) => s + p.ms, 0);
  const serverSlow = slowReplies.filter((r) => r.ms - frozenDuring(r) > 1000);
  console.log(
    `\n  replies over 1 s: ${slowReplies.length} · of those, still over 1 s after taking out this process's own pauses: ${serverSlow.length}`
  );
  for (const r of serverSlow.slice(0, 10))
    console.log(`    ${r.event} on ${r.topic}: ${r.ms.toFixed(0)} ms (we were paused ${frozenDuring(r).toFixed(0)} ms of it)`);
  const worst = loopPauses.reduce((m, p) => Math.max(m, p.ms), 0);
  console.log(`  this process's own pauses over 250 ms: ${loopPauses.length} · worst ${worst.toFixed(0)} ms`);
}
console.log(`\n  server memory: before ${idleBefore.toFixed(1)} MB · idle after each wave ${idleAfter.map((m) => m.toFixed(1)).join(" → ")} MB · peak ${Math.max(...memory).toFixed(1)} MB`);

const names = {
  L1: "privacy: each role only its own layer",
  L2: "markers are {id, cell, spot} only",
  L3: "exact positions only from your ride partner",
  L4: "a second tab hands over cleanly; nobody else is kicked",
  L5: "honest use is never rate-limited",
  L6: "both people hear a ride start and end",
  L7: "no unexpected errors",
  L8: "the map is empty after everyone leaves",
};
// every violation, with its trace, for a full diagnosis
{
  const { tmpdir } = await import("node:os");
  const out = process.env.MONSTER_OUT || `${tmpdir()}/monster-${SEED}.json`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, JSON.stringify({ seed: SEED, agents: N, seconds: SECONDS, waves: WAVES, chaos: CHAOS, counts, laws, unknownStarts }, null, 1));
  console.log(`
  every violation (and the totals): ${out}`);
}
let bad = 0;
console.log("");
for (const [law, xs] of Object.entries(laws)) {
  if (xs.length === 0) console.log(`  PASS  ${law} ${names[law]}`);
  else {
    bad++;
    console.log(`  FAIL  ${law} ${names[law]} — ${xs.length} violation(s):`);
    for (const x of xs.slice(0, 50)) console.log(`          ${x}`);
    if (xs.length > 50) console.log(`          … ${xs.length - 50} more in the file below`);
  }
}
console.log(bad ? `\n${bad} LAW(S) BROKEN (seed ${SEED})` : `\nTHE MONSTER IS SATISFIED (seed ${SEED})`);
process.exit(bad ? 1 : 0);
