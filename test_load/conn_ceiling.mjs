// How many connections can be open AT ONCE? (owner, 2026-11-04)
//
// Over 127.0.0.1, every connection takes a temporary port from Linux's pool
// (net.ipv4.ip_local_port_range, by default 32768–60999: 28,232), so a proxy
// on the same machine tops out near 28k people. hoodride.app's tunnel
// reaches the app over a Unix socket instead, which uses no port numbers —
// this proves the difference, against the real app:
//
//   node test_load/conn_ceiling.mjs tcp:127.0.0.1:4400 40000    # the old way
//   node test_load/conn_ceiling.mjs unix:/path/app.sock 40000   # hoodride.app's way
//
// Each connection asks the app one small question (GET /api/me) and must get
// an HTTP answer — so it's the APP serving it, not just Linux — then stays
// open while the rest arrive, asking again every 30 s: the app closes a
// connection idle for 60 s, which would free its port and blur the count
// (the first run, 2026-11-04, crawled to ~27,900 open, then rose only as
// the oldest timed out). Linux only (Unix sockets); raise this
// shell's open-file limit first (`ulimit -n 1048576`), and run the app with
// the per-visitor budgets off (MIX_ENV=loadtest), or one machine is "one
// visitor" and gets limited long before any of this.
import net from "node:net";

const [target = "", countArg = "40000", rateArg = "2000"] = process.argv.slice(2);
const COUNT = Number(countArg);
const RATE = Number(rateArg); // new connections per second

const where = target.startsWith("unix:")
  ? { path: target.slice(5) }
  : target.startsWith("tcp:")
    ? (([host, port]) => ({ host, port: Number(port) }))(target.slice(4).split(":"))
    : null;
if (!where || !(COUNT > 0)) {
  console.error("usage: node test_load/conn_ceiling.mjs tcp:HOST:PORT|unix:PATH [count=40000] [per_second=2000]");
  process.exit(2);
}

const REQUEST = "GET /api/me HTTP/1.1\r\nHost: localhost\r\nx-forwarded-proto: https\r\nx-forwarded-for: 203.0.113.9\r\n\r\n";

let attempted = 0;
let connected = 0;
let answered = 0;
let open = 0;
let peakOpen = 0;
let closedEarly = 0;
const statuses = {};
const errors = {};
let firstError = null;
const sockets = [];

function one(n) {
  attempted++;
  const s = net.createConnection(where);
  let gotAnswer = false;
  s.setNoDelay(true);
  s.on("connect", () => {
    s.__connected = true;
    connected++;
    open++;
    if (open > peakOpen) peakOpen = open;
    s.write(REQUEST);
  });
  s.on("data", (buf) => {
    if (gotAnswer) return;
    const m = /^HTTP\/1\.1 (\d{3})/.exec(buf.toString("latin1", 0, 16));
    if (m) {
      gotAnswer = true;
      answered++;
      statuses[m[1]] = (statuses[m[1]] || 0) + 1;
      // keep it busy: never idle long enough for the app to close it
      s.__ping = setInterval(() => s.writable && s.write(REQUEST), 30000);
    }
  });
  s.on("error", (e) => {
    const code = e.code || e.message;
    errors[code] = (errors[code] || 0) + 1;
    if (!firstError) firstError = { at: n, code };
  });
  s.on("close", () => {
    clearInterval(s.__ping);
    if (s.__counted) return;
    s.__counted = true;
    // only one that WAS open can close (a refused one never opened)
    if (s.__connected) {
      open--;
      if (!finished) closedEarly++;
    }
  });
  sockets.push(s);
}

let finished = false;
const started = Date.now();
const perTick = Math.max(1, Math.round(RATE / 20)); // every 50 ms

function report(label) {
  const mem = process.memoryUsage().rss;
  console.log(
    JSON.stringify({
      label,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      attempted,
      connected,
      answered,
      openNow: open,
      peakOpen,
      closedEarly,
      statuses,
      errors,
      firstError,
      clientMB: Math.round(mem / 1048576),
    })
  );
}

const ticker = setInterval(() => {
  for (let i = 0; i < perTick && attempted < COUNT; i++) one(attempted + 1);
  if (attempted >= COUNT) {
    clearInterval(ticker);
    // let the last ones finish connecting and answering, then hold them all
    setTimeout(() => {
      report("held");
      finished = true;
      for (const s of sockets) s.destroy();
      setTimeout(() => process.exit(0), 500);
    }, 8000);
  }
}, 50);

// progress every 5 s (the runner can read the server's side meanwhile)
const progress = setInterval(() => report("progress"), 5000);
progress.unref();
