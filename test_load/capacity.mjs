// CAPACITY: how many people one server carries before it slows down — and
// what runs out first. Steps the crowd up (1k, 2k, 5k…), everyone ON real
// websockets and acting like the app: 20% drivers moving and sending their
// spot through the app's own send filter (a new spot, or the jittered 20 s
// heartbeat; PARKED of them wait in place), 80% riders panning every
// 30-90 s, everyone watching what the app's own planner picks for a phone
// screen at their zoom (ZOOMS, CAP), all heartbeating every 30 s, spread over
// a city (RADIUS_M). Car updates are timed send → receive (car delay). Each step: the
// newcomers arrive all at once (join times), then a hold measuring the
// server's replies (every sync), memory and CPU. After the last step that
// holds: a reconnect storm of everyone (every phone after a deploy).
//
// A step FAILS (and the ramp stops) on: > 0.5% of arrivals failing, arrival
// p99 > 5 s, sync reply p99 > 1 s during the hold, connections dropped, or
// server memory > MAX_MB.
//
// The crowd is split over SHARDS Node processes (one process tops out at a
// few thousand sockets). Meant for the loadtest build (config/loadtest.exs:
// prod + dev_login + no per-IP budgets) on Linux:
//
//   SERVER_PID=<beam pid> node test_load/capacity.mjs \
//     [steps=1000,2000,5000] [shards=4] [hold_s=30]
//
// Server memory/CPU come from /proc/SERVER_PID (Linux); without it, they're
// skipped. HOOD_BASE overrides http://127.0.0.1:4000.
import { execSync, fork } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const h3 = require("../priv/static/h3-js.umd.js");
const F = require("../priv/static/sendfilter.js");
// the app's own reconnect backoff (full jitter, 1 s doubling to 10 s)
const HoodSync = require("../priv/static/sync.js");

const BASE = process.env.HOOD_BASE || "http://127.0.0.1:4000";
const WS = BASE.replace(/^http/, "ws") + "/socket/websocket?vsn=2.0.0";
const CENTER = { lat: 40.7154, lng: -74.0086 };
const RADIUS_M = Number(process.env.RADIUS_M || 4000);
const MAX_MB = Number(process.env.MAX_MB || 12000);
const DRIVER_SHARE = 0.2;
// how far people look: "zoom:share,..." (the app opens at 14 and follows a
// driver at 15+). Each person watches what the app's own planner
// (viewport.js planWatch) picks for a 390×844 px phone screen at that zoom,
// within the app's watch budget CAP (MAX_WATCHED_CELLS in app.js).
// ZOOMS=ring: the old fixed view, a cell and its ring (7 cells).
const ZOOMS = process.env.ZOOMS || "15:0.5,14:0.3,13:0.2";
const CAP = Number(process.env.CAP || 110);
// the share of drivers parked, waiting for a ride (send only the heartbeat)
const PARKED = Number(process.env.PARKED ?? 0.5);
// car delay: 1 in DELAY_EVERY drivers' updates are timed from the driver's
// send to each watcher's receipt (one clock: every shard runs on this machine)
const DELAY_EVERY = 10;
const timed = (id) => id % DELAY_EVERY === 0;
const wall = () => performance.timeOrigin + performance.now();
const HoodViewport = require("../priv/static/viewport.js");
const ZOOM_MIX = ZOOMS === "ring" ? [] : ZOOMS.split(",").map((z) => z.split(":").map(Number));
const pickZoom = () => {
  let r = Math.random() * ZOOM_MIX.reduce((a, [, w]) => a + w, 0);
  for (const [z, w] of ZOOM_MIX) if ((r -= w) <= 0) return z;
  return ZOOM_MIX.length ? ZOOM_MIX[ZOOM_MIX.length - 1][0] : null;
};
// a phone screen (390×844 CSS px) at `zoom` around `c`, as the app's map
// reports it (MapLibre: 512 px tiles, so 78,271.5 m per pixel at zoom 0)
const screenRect = (c, zoom) => {
  const mpp = (78271.517 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** zoom;
  const dLat = (422 * mpp) / 111320;
  const dLng = (195 * mpp) / (111320 * Math.cos((c.lat * Math.PI) / 180));
  return { n: c.lat + dLat, s: c.lat - dLat, e: c.lng + dLng, w: c.lng - dLng };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const offset = (p, m, deg) => {
  const r = (deg * Math.PI) / 180;
  return {
    lat: p.lat + (m * Math.cos(r)) / 111195,
    lng: p.lng + (m * Math.sin(r)) / (111195 * Math.cos((p.lat * Math.PI) / 180)),
  };
};
const somewhere = () => offset(CENTER, Math.sqrt(Math.random()) * RADIUS_M, Math.random() * 360);

// A minimal WebSocket client on Node's stable http module. Node's built-in
// WebSocket (undici; experimental in Node 20) lost 790 of 3,000 connections
// opened at once even from one process, while plain HTTP upgrades to the
// same server all got 101 (6 × 500 at once too) — the test must stress the
// server, not its own client. Text frames (with continuation), ping → pong,
// close; client frames masked (RFC 6455 §5.3). Same surface as WebSocket:
// readyState, send, close, onopen/onmessage/onerror/onclose.
class MiniWS {
  constructor(url) {
    this.readyState = 0;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    const req = http.request(url.replace(/^ws/, "http"), {
      agent: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      },
    });
    req.setTimeout(30000, () => req.destroy(new Error("handshake timeout 30 s")));
    req.on("upgrade", (_res, socket, head) => {
      req.setTimeout(0);
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on("data", (d) => this.feed(d));
      socket.on("close", () => this.ended());
      socket.on("error", () => {});
      this.readyState = 1;
      if (head.length) this.feed(head);
      this.onopen?.();
    });
    req.on("response", (r) => {
      r.resume();
      this.fail(`HTTP ${r.statusCode}`);
    });
    req.on("error", (e) => this.fail(e.code || e.message));
    req.end();
  }
  fail(why) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onerror?.({ message: why });
    this.onclose?.({ code: 1006 });
  }
  ended() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  feed(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      let len = this.buf[1] & 127;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf[1] & 128) off += 4; // (a server never masks)
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      const op = b0 & 15;
      if (op === 1 || op === 0) {
        this.frag = this.frag ? Buffer.concat([this.frag, payload]) : payload;
        if (b0 & 128) {
          const data = this.frag.toString();
          this.frag = null;
          this.onmessage?.({ data });
        }
      } else if (op === 9) this.frame(10, payload);
      else if (op === 8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.frame(8, payload.subarray(0, 2));
        this.socket.end();
        this.ended();
      }
    }
  }
  frame(op, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const len = payload.length;
    let h;
    if (len < 126) {
      h = Buffer.alloc(6);
      h[1] = 0x80 | len;
    } else if (len < 65536) {
      h = Buffer.alloc(8);
      h[1] = 0x80 | 126;
      h.writeUInt16BE(len, 2);
    } else {
      h = Buffer.alloc(14);
      h[1] = 0x80 | 127;
      h.writeBigUInt64BE(BigInt(len), 2);
    }
    h[0] = 0x80 | op;
    const mask = crypto.randomBytes(4);
    mask.copy(h, h.length - 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([h, out]));
  }
  send(text) {
    if (this.readyState === 1) this.frame(1, Buffer.from(text));
  }
  close() {
    if (this.readyState === 1) {
      this.frame(8, Buffer.from([0x03, 0xe8]));
      this.socket.end();
    }
    this.readyState = 3;
  }
}

// =====================================================================
// SHARD: holds part of the crowd, on the coordinator's commands
// =====================================================================
if (process.argv[2] === "shard") {
  const shardId = Number(process.argv[3]);
  const pending = []; // logged in, not yet connected
  const live = []; // connected people
  let samples = []; // sync reply times (ms) since the last report
  let dropped = 0;
  // why each unexpected close happened: "<close code> after <last event>, silent <s>"
  let dropReasons = {};
  let frames = 0;
  // by event: sent = into the server, got = out of it (a reply counts as its request's event)
  let sentBy = {};
  let gotBy = {};
  const bump = (m, k) => (m[k] = (m[k] || 0) + 1);
  // car delay: sends {"id:spot": [times]}, receipts [["id:spot", time]]
  let delaySends = {};
  let delayGot = [];
  // what people watch: cells of cars / of counts, summed over syncs
  let watched = { geo: 0, agg: 0, syncs: 0 };
  let seq = 0;
  // the deploy: dropped people reconnect as the app does
  let auto = false;
  let retries = 0;
  // the app's HTTP calls around a reconnect (/api/socket_token, /api/state):
  // answers by status, so a database that can't keep up shows as 5xx
  let httpBy = {};
  const retryErrors = new Map();

  async function login(name) {
    const r = await fetch(`${BASE}/api/dev_login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agree_terms: true, name }),
    });
    if (!r.ok) throw new Error(`dev_login ${r.status}`);
    const cookie = r.headers.get("set-cookie").split(";")[0];
    // going online needs a car on file (the server checks, step 5)
    await fetch(`${BASE}/api/car`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ color: "Blue", make: "Toyota", model: "Camry" }),
    });
    const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
    const { token } = await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json();
    return { me, token, cookie, kind: Math.random() < DRIVER_SHARE ? "driver" : "rider" };
  }

  class Person {
    constructor(user) {
      this.user = user;
      this.ref = 0;
      this.waiting = new Map();
      this.pos = somewhere();
      this.view = this.pos;
      this.spot = null;
      this.lastGeo = null;
      this.timers = [];
      this.zoom = pickZoom();
      this.parked = user.kind === "driver" && Math.random() < PARKED;
      this.closedByUs = false;
      this.attempt = 0;
    }
    // like the app: wait HoodSync.reconnectBackoff(attempt), try, repeat
    retry() {
      this.attempt++;
      retries++;
      setTimeout(async () => {
        // like the app: a fresh token first (refreshSocketToken), and after
        // the joins the whole state again (softReload)
        await this.http("/api/socket_token");
        this.connect()
          .then(() => {
            this.attempt = 0;
            this.notice = null;
            return this.http("/api/state?chats=list"); // the app's reload: the chat list
          })
          .catch((e) => {
            retryErrors.set(e.message, (retryErrors.get(e.message) || 0) + 1);
            try {
              this.ws.close(); // half-open (joined nothing): drop it quietly
            } catch {}
            this.retry();
          });
      }, HoodSync.restartWait(this.attempt, this.notice));
    }
    async http(path) {
      try {
        const r = await fetch(`${BASE}${path}`, { headers: { cookie: this.user.cookie } });
        await r.arrayBuffer();
        httpBy[`${path} ${r.status}`] = (httpBy[`${path} ${r.status}`] || 0) + 1;
      } catch (e) {
        httpBy[`${path} no answer`] = (httpBy[`${path} no answer`] || 0) + 1;
      }
    }
    push(topic, event, payload, joinRef) {
      return new Promise((res, rej) => {
        const r = String(++this.ref);
        const t = setTimeout(() => {
          this.waiting.delete(r);
          rej(new Error(`no reply to ${event}`));
        }, 10000);
        this.waiting.set(r, (p) => {
          clearTimeout(t);
          res(p);
        });
        bump(sentBy, event);
        this.lastSentAt = performance.now();
        this.ws.send(JSON.stringify([joinRef, r, topic, event, payload]));
      });
    }
    cast(topic, event, payload, joinRef) {
      if (this.ws.readyState === 1) {
        bump(sentBy, event);
        this.lastSentAt = performance.now();
        this.ws.send(JSON.stringify([joinRef, String(++this.ref), topic, event, payload]));
      }
    }
    wish() {
      const w = this.plan();
      watched.geo += w.geo.length;
      watched.agg += w.agg.length;
      watched.syncs++;
      return w;
    }
    plan() {
      if (this.zoom === null) return { geo: h3.gridDisk(h3.latLngToCell(this.view.lat, this.view.lng, 8), 1), agg: [] };
      const plan = HoodViewport.planWatch(h3, screenRect(this.view, this.zoom), [8, 7, 5], CAP);
      if (!plan) return { geo: [], agg: [] };
      return plan.res === 8 ? { geo: [...plan.cells], agg: [] } : { geo: [], agg: [...plan.cells] };
    }
    got(event, payload) {
      if (event === "driver_update" && payload && timed(payload.id)) delayGot.push([`${payload.id}:${payload.spot}`, wall()]);
    }
    async sync() {
      const t0 = performance.now();
      const r = await this.push("world", "sync", this.wish(), "2");
      if (r.status !== "ok") throw new Error(`sync: ${JSON.stringify(r.response)}`);
      samples.push(performance.now() - t0);
    }
    connect() {
      const t0 = performance.now();
      this.closedByUs = false;
      const ws = new MiniWS(`${WS}&token=${encodeURIComponent(this.user.token)}`);
      this.ws = ws;
      this.ws.onmessage = (e) => {
        frames++;
        this.lastAt = performance.now();
        const [, r, , event, payload] = JSON.parse(e.data);
        bump(gotBy, event === "phx_reply" ? "reply" : event);
        this.lastEvent = event;
        // a map batch (WorldChannel :map_batch_ms): its items count as themselves
        if (event === "batch") for (const [ie, ip] of payload.items) bump(gotBy, ie), this.got(ie, ip);
        else this.got(event, payload);
        // like the app: a planned restart -> reconnect inside its window
        if (event === "restarting") this.notice = { min: payload.min_ms, max: payload.max_ms };
        if (event === "phx_reply" && this.waiting.has(r)) {
          const f = this.waiting.get(r);
          this.waiting.delete(r);
          f(payload);
        }
      };
      let opened = false;
      this.ws.onclose = () => {
        // an old socket closing after a reconnect must not stop the new one
        if (this.ws !== ws) return;
        this.stop();
        // a handshake that failed is an arrival error, not a drop
        if (opened && !this.closedByUs) {
          dropped++;
          const code = ws.closeCode ?? "no close frame";
          const silent = this.lastAt ? Math.round((performance.now() - this.lastAt) / 1000) : "?";
          const quiet = this.lastSentAt ? Math.round((performance.now() - this.lastSentAt) / 1000) : "?";
          bump(dropReasons, `${code} after ${this.lastEvent || "nothing"}, silent ${silent}s, sent nothing for ${quiet}s (${this.user.kind})`);
          if (auto) this.retry();
        }
      };
      return (async () => {
        await new Promise((res, rej) => {
          this.ws.onopen = () => {
            opened = true;
            res();
          };
          // MiniWS says why: an HTTP status, or the socket error's code
          this.ws.onerror = (e) => rej(new Error(`connect failed: ${e.message}`));
        });
        const u = await this.push(`user:${this.user.me.id}`, "phx_join", {}, "1");
        if (u.status !== "ok") throw new Error(`user join: ${JSON.stringify(u.response)}`);
        const w = await this.push("world", "phx_join", {}, "2");
        if (w.status !== "ok") throw new Error(`map join: ${JSON.stringify(w.response)}`);
        await this.sync();
        const took = performance.now() - t0;
        this.live();
        return took;
      })();
    }
    // what the app does while open
    live() {
      const every = (ms, f) => this.timers.push(setInterval(f, ms));
      const after = (ms, f) => this.timers.push(setTimeout(f, ms));
      // like the app: a heartbeat every 30 s (the first at a random point of
      // the first 30 s — the server closes a connection silent for 60 s)
      const beat = () => this.cast("phoenix", "heartbeat", {}, null);
      after(Math.random() * 30000, () => {
        beat();
        every(30000, beat);
      });
      if (this.user.kind === "driver") {
        let waypoint = somewhere();
        // the app's 1.5 s tick: drive, send the spot when the filter says so
        every(1500, () => {
          if (this.parked) waypoint = this.pos;
          else if (F.metersBetween(this.pos, waypoint) < 20) waypoint = Math.random() < 0.3 ? this.pos : somewhere();
          const d = F.metersBetween(this.pos, waypoint);
          if (d > 0) {
            const k = Math.min(1, 15 / d);
            this.pos = { lat: this.pos.lat + (waypoint.lat - this.pos.lat) * k, lng: this.pos.lng + (waypoint.lng - this.pos.lng) * k };
          }
          const spot = F.stickySpot(this.spot, { ...this.pos, accuracy: 10 }, h3, 9);
          this.spot = spot;
          if (F.shouldSend(this.lastGeo, Date.now(), this.pos, spot, F.BROWSE_MIN_METERS)) {
            this.lastGeo = F.stamp(this.pos, spot, Date.now(), Math.random);
            if (timed(this.user.me.id)) (delaySends[`${this.user.me.id}:${spot}`] ||= []).push(wall());
            this.cast(`user:${this.user.me.id}`, "driver_update", { spot }, "1");
          }
          this.view = this.pos; // the driver's map follows the car
        });
        every(20000, () => this.sync().catch(() => {}));
      } else {
        const pan = () => {
          after(30000 + Math.random() * 60000, () => {
            this.view = offset(this.view, 200 + Math.random() * 600, Math.random() * 360);
            this.sync().catch(() => {});
            pan();
          });
        };
        pan();
      }
    }
    stop() {
      for (const t of this.timers) clearInterval(t), clearTimeout(t);
      this.timers = [];
    }
    close() {
      this.closedByUs = true;
      this.stop();
      try {
        this.ws.close();
      } catch {}
    }
  }

  async function inBatches(items, n, f) {
    const out = [];
    for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(f))));
    return out;
  }

  async function arrive(people) {
    const res = await Promise.allSettled(people.map((p) => p.connect()));
    const times = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const errors = res.filter((r) => r.status === "rejected").map((r) => r.reason.message);
    return { times, errors };
  }

  process.on("message", async (m) => {
    try {
      if (m.cmd === "login") {
        const names = Array.from({ length: m.count }, () => `Cap-${shardId}-${++seq}-${Date.now() % 1e6}`);
        const users = await inBatches(names, 32, login);
        pending.push(...users.map((u) => new Person(u)));
        process.send({ ok: true });
      } else if (m.cmd === "connect") {
        const people = pending.splice(0);
        const r = await arrive(people);
        live.push(...people);
        samples = [];
        process.send({ ok: true, ...r });
      } else if (m.cmd === "report") {
        const open = live.filter((p) => p.ws.readyState === 1).length;
        process.send({ ok: true, samples, open, dropped, frames, sentBy, gotBy, dropReasons, delaySends, delayGot, watched });
        delaySends = {};
        delayGot = [];
        watched = { geo: 0, agg: 0, syncs: 0 };
        samples = [];
        frames = 0;
        sentBy = {};
        gotBy = {};
      } else if (m.cmd === "storm") {
        for (const p of live) p.close();
        await sleep(1000);
        dropped = 0;
        const r = await arrive(live);
        process.send({ ok: true, ...r });
      } else if (m.cmd === "auto") {
        auto = true;
        retries = 0;
        retryErrors.clear();
        httpBy = {};
        process.send({ ok: true });
      } else if (m.cmd === "count") {
        const open = live.filter((p) => p.ws.readyState === 1 && p.attempt === 0).length;
        process.send({ ok: true, open, retries, errors: Object.fromEntries(retryErrors), httpBy });
      } else if (m.cmd === "quit") {
        for (const p of live) p.close();
        await sleep(500);
        process.exit(0);
      }
    } catch (e) {
      process.send({ ok: false, error: String(e && e.message) });
    }
  });
  process.send({ ready: true });
} else {
  // =====================================================================
  // COORDINATOR
  // =====================================================================
  const STEPS = (process.argv[2] || "1000,2000,5000").split(",").map(Number);
  const SHARDS = Number(process.argv[3] || 4);
  const HOLD_S = Number(process.argv[4] || 30);
  const PID = process.env.SERVER_PID;

  const procRead = (f) => {
    try {
      return readFileSync(`/proc/${PID}/${f}`, "utf8");
    } catch {
      return null;
    }
  };
  const serverMB = () => {
    const s = PID && procRead("status");
    const m = s && s.match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) / 1024 : NaN;
  };
  // CPU ticks used by the server so far (utime + stime; 100 per second)
  const serverTicks = () => {
    const s = PID && procRead("stat");
    if (!s) return NaN;
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return Number(f[11]) + Number(f[12]);
  };

  // every timed car send so far, from every shard: {"id:spot": [times]}
  const allSends = {};
  const keepSends = (rep) => {
    for (const r of rep) for (const [k, ts] of Object.entries(r.delaySends || {})) (allSends[k] ||= []).push(...ts);
  };

  const shards = [];
  for (let i = 0; i < SHARDS; i++) {
    const child = fork(new URL(import.meta.url).pathname, ["shard", String(i)]);
    const queue = [];
    child.on("message", (m) => {
      if (m.ready) return;
      queue.shift()?.(m);
    });
    shards.push({
      child,
      ask: (msg) =>
        new Promise((res, rej) => {
          queue.push((m) => (m.ok ? res(m) : rej(new Error(m.error))));
          child.send(msg);
        }),
    });
  }
  const all = (msg) => Promise.all(shards.map((s) => s.ask(msg)));
  const split = (n) => shards.map((_, i) => Math.floor(n / SHARDS) + (i < n % SHARDS ? 1 : 0));

  console.log(
    `capacity: steps ${STEPS.join(" → ")} · ${SHARDS} shards · hold ${HOLD_S} s · ` +
      `${Math.round(DRIVER_SHARE * 100)}% drivers (${Math.round(PARKED * 100)}% parked) · radius ${RADIUS_M} m · ` +
      `zooms ${ZOOMS} · cap ${CAP} · map batch ${process.env.MAP_BATCH_MS || 0} ms\n`
  );
  console.log(`  server memory idle: ${serverMB().toFixed(0)} MB\n`);
  const table = [];
  let have = 0;
  let lastGood = 0;

  for (const target of STEPS) {
    const add = target - have;
    if (add <= 0) continue;
    process.stdout.write(`  ${target.toLocaleString()} people: logging in ${add}… `);
    await Promise.all(shards.map((s, i) => s.ask({ cmd: "login", count: split(add)[i] })));
    process.stdout.write("arriving… ");
    const arr = await all({ cmd: "connect" });
    have = target;
    const times = arr.flatMap((r) => r.times);
    const errors = arr.flatMap((r) => r.errors);

    // the hold: sample the server each second
    keepSends(await all({ cmd: "report" })); // reset the counters
    const mbs = [];
    const t0 = serverTicks();
    const w0 = performance.now();
    for (let s = 0; s < HOLD_S; s++) {
      await sleep(1000);
      mbs.push(serverMB());
    }
    const cpu = ((serverTicks() - t0) / ((performance.now() - w0) / 1000)) | 0; // % of one core
    const rep = await all({ cmd: "report" });
    keepSends(rep);
    const syncs = rep.flatMap((r) => r.samples);
    // each receipt against the latest send of that car+spot before it
    const delays = [];
    for (const r of rep)
      for (const [key, at] of r.delayGot) {
        const ts = allSends[key];
        if (!ts) continue;
        let best = null;
        for (const t of ts) if (t <= at && (best === null || t > best)) best = t;
        if (best !== null) delays.push(at - best);
      }
    const w = rep.reduce((a, r) => ({ geo: a.geo + r.watched.geo, agg: a.agg + r.watched.agg, syncs: a.syncs + r.watched.syncs }), { geo: 0, agg: 0, syncs: 0 });
    const open = rep.reduce((a, r) => a + r.open, 0);
    const dropped = rep.reduce((a, r) => a + r.dropped, 0);
    const reasons = {};
    for (const r of rep) for (const [k, v] of Object.entries(r.dropReasons || {})) reasons[k] = (reasons[k] || 0) + v;
    if (Object.keys(reasons).length) console.log(`      dropped: ${JSON.stringify(reasons)}`);
    const fps = Math.round(rep.reduce((a, r) => a + r.frames, 0) / HOLD_S);
    const mb = Math.max(...mbs);

    const row = {
      people: target,
      arrived: `${times.length}/${add}`,
      arr_p50: pct(times, 50),
      arr_p99: pct(times, 99),
      sync_p50: pct(syncs, 50),
      sync_p99: pct(syncs, 99),
      syncs: syncs.length,
      cpu,
      mb,
      fps,
      open,
      dropped,
      delay_p50: pct(delays, 50),
      delay_p99: pct(delays, 99),
    };
    table.push(row);
    const why = [];
    if (errors.length > add * 0.005) why.push(`${errors.length} arrivals failed (${[...new Set(errors)].slice(0, 2).join(" | ")})`);
    if (row.arr_p99 > 5000) why.push(`arrival p99 ${row.arr_p99.toFixed(0)} ms`);
    if (row.sync_p99 > 1000) why.push(`sync p99 ${row.sync_p99.toFixed(0)} ms`);
    if (open < target || dropped) why.push(`${target - open} not open, ${dropped} dropped`);
    if (mb > MAX_MB) why.push(`memory ${mb.toFixed(0)} MB`);
    console.log(
      `arrival p50/p99 ${row.arr_p50.toFixed(0)}/${row.arr_p99.toFixed(0)} ms · ` +
        `sync p50/p99 ${row.sync_p50.toFixed(0)}/${row.sync_p99.toFixed(0)} ms (${syncs.length}) · ` +
        `CPU ${cpu}% · ${mb.toFixed(0)} MB · ${fps.toLocaleString()} frames/s out · ${why.length ? "FAIL: " + why.join("; ") : "ok"}`
    );
    // per type, per second, over the hold
    const sum = (key) => {
      const t = {};
      for (const r of rep) for (const [k, v] of Object.entries(r[key] || {})) t[k] = (t[k] || 0) + v;
      return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v / HOLD_S).toLocaleString()}`).join(" · ");
    };
    console.log(
      `      car delay p50/p99 ${row.delay_p50.toFixed(0)}/${row.delay_p99.toFixed(0)} ms (${delays.length}) · ` +
        `watching per sync: ${(w.geo / (w.syncs || 1)).toFixed(1)} car cells, ${(w.agg / (w.syncs || 1)).toFixed(1)} count cells`
    );
    console.log(`      in  /s: ${sum("sentBy")}`);
    console.log(`      out /s: ${sum("gotBy")}`);
    // KEEP_GOING=1: run the remaining steps anyway (to see a later step's
    // behaviour even if an earlier one missed a threshold)
    if (why.length && !process.env.KEEP_GOING) break;
    lastGood = target;
  }

  // PROFILE_HOLD=<s>: everyone stays connected and active that long after
  // the ramp, for a profiler to measure the server under load (it watches
  // for the PROFILE_READY line)
  if (lastGood && process.env.PROFILE_HOLD) {
    console.log(`\n  PROFILE_READY ${have} people connected — holding ${process.env.PROFILE_HOLD} s`);
    await sleep(Number(process.env.PROFILE_HOLD) * 1000);
    console.log("  PROFILE_DONE");
  }

  if (lastGood && !process.env.SKIP_STORMS) {
    process.stdout.write(`\n  reconnect storm: all ${have.toLocaleString()} drop and come back at once… `);
    const st = await all({ cmd: "storm" });
    const times = st.flatMap((r) => r.times);
    const errors = st.flatMap((r) => r.errors);
    console.log(
      `${times.length}/${have} back · p50/p99 ${pct(times, 50).toFixed(0)}/${pct(times, 99).toFixed(0)} ms` +
        (errors.length ? ` · errors: ${[...new Set(errors)].slice(0, 2).join(" | ")} (${errors.length})` : "")
    );
  }

  // THE DEPLOY: restart the server with everyone connected (RESTART_CMD stops
  // it and starts the new one); each person reconnects with the app's own
  // backoff. How long until all are back, and what did the retries meet?
  if (lastGood && process.env.RESTART_CMD && !process.env.SKIP_STORMS) {
    await all({ cmd: "auto" });
    process.stdout.write(`
  deploy: restart with ${have.toLocaleString()} connected, everyone reconnects with the app's backoff… `);
    const t0 = performance.now();
    execSync(process.env.RESTART_CMD, { stdio: "ignore" });
    const upAt = (performance.now() - t0) / 1000;
    let back = 0;
    let rep = [];
    let allBackAt = NaN;
    const curve = [];
    for (let s = 0; s < 180; s++) {
      await sleep(1000);
      rep = await all({ cmd: "count" });
      back = rep.reduce((a, r) => a + r.open, 0);
      curve.push({ t: (performance.now() - t0) / 1000, back });
      if (back >= have) {
        allBackAt = (performance.now() - t0) / 1000;
        break;
      }
    }
    const retries = rep.reduce((a, r) => a + r.retries, 0);
    const errors = {};
    for (const r of rep) for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] || 0) + v;
    // seconds from the restart's start
    const at = (n) => curve.find((c) => c.back >= n)?.t.toFixed(1) ?? "—";
    console.log(
      `server back up after ${upAt.toFixed(1)} s · ` +
        (Number.isNaN(allBackAt) ? `NOT all back in 180 s (${back}/${have})` : `all ${have.toLocaleString()} back after ${allBackAt.toFixed(1)} s`) +
        ` · half back at ${at(have / 2)} s, 99% at ${at(have * 0.99)} s · ${retries.toLocaleString()} attempts` +
        (Object.keys(errors).length ? ` · failed attempts: ${JSON.stringify(errors)}` : " · no failed attempt")
    );
    // the app's HTTP calls around those reconnects (state reloads finish
    // just after the joins), by answer: 5xx = the server couldn't keep up
    await sleep(5000);
    const http = {};
    for (const r of await all({ cmd: "count" }))
      for (const [k, v] of Object.entries(r.httpBy || {})) http[k] = (http[k] || 0) + v;
    console.log(`  app HTTP calls during the deploy: ${JSON.stringify(http)}`);
  }

  const perUser = table.length > 1 ? ((table[table.length - 1].mb - table[0].mb) * 1024) / (table[table.length - 1].people - table[0].people) : NaN;
  console.log(`\n  memory per connected person (between the first and last step): ≈ ${perUser.toFixed(0)} KB`);
  console.log(`  last step that held: ${lastGood.toLocaleString()} people`);
  console.log("\n  " + JSON.stringify(table));
  // shards exit on "quit" without answering
  for (const s of shards) s.child.send({ cmd: "quit" });
  await sleep(1500);
  process.exit(0);
}
