// Browser journeys: a real browser drives the real app (owner, 2026-10-30).
// app.js is glue the Node tests can't load and the Elixir tests only read;
// these run it. No download: the Chrome-engine browser already on the
// machine (Microsoft Edge ships with Windows; BROWSER= picks another, e.g.
// Brave or Chrome), headless, in a throwaway profile, driven over its own
// debugging connection (the Chrome DevTools Protocol) with Node's built-in
// WebSocket. Run by test/browser/journeys_test.exs, which starts the app on
// its own port with the test database; BASE is that address.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE = process.env.BASE || "http://localhost:4100";
// the home cell's centre: the same block for everyone, so they see each other
export const HOME = { latitude: 40.7154, longitude: -74.0086 };

const CANDIDATES = [
  process.env.BROWSER,
  `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/microsoft-edge",
].filter(Boolean);

export function findBrowser() {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error(`no Chrome-engine browser found (set BROWSER=): ${CANDIDATES.join(", ")}`);
  return exe;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- asking the test that started us to do something on the server ----
// (e.g. "new_build": as if a new version were deployed). One line out
// ("@@server <what>"), one line back ("ok", or why not).
let stdinLines = null;
export async function server(what) {
  if (!stdinLines) {
    stdinLines = [];
    let buf = "";
    const waiting = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        waiting.length ? waiting.shift()(line) : stdinLines.push(line);
      }
    });
    stdinLines.next = () => (stdinLines.length ? Promise.resolve(stdinLines.shift()) : new Promise((r) => waiting.push(r)));
  }
  console.log(`@@server ${what}`);
  const reply = await stdinLines.next();
  if (reply !== "ok") throw new Error(`the server couldn't ${what}: ${reply}`);
}

// ---- the steps, printed as they go: a failure shows where ----
let stepNo = 0;
export function step(text) {
  console.log(`  ${++stepNo}. ${text}`);
}
export function check(ok, what, got) {
  if (!ok) throw new Error(`FAILED: ${what}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
}

// ---- one debugging connection to the browser; pages are sessions on it ----
function connect(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && waiting.has(msg.id)) {
      const { resolve, reject, method } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("couldn't connect to the browser"));
  });
  return {
    opened,
    send(method, params = {}, sessionId) {
      const id = ++next;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => waiting.set(id, { resolve, reject, method }));
    },
    on: (f) => listeners.add(f),
    close: () => ws.close(),
  };
}

export async function launch() {
  const exe = findBrowser();
  const dir = mkdtempSync(join(tmpdir(), "hoodride-browser-"));
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--window-size=1280,900",
      // several people's pages share this browser, and only one is "in
      // front": Chrome slows the others — timers, drawing (a pulse's clock
      // stood at 0 ms for 3 s), the whole page under load. A real phone runs
      // the app in front. These four, as Puppeteer's launcher sets by default
      // (ChromeLauncher.ts defaultArgs), keep every page running (2026-11-02)
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-ipc-flooding-protection",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  // the browser writes its debugging port here once it listens
  const portFile = join(dir, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    // (Windows: the file can be locked while it's being written — try again)
    try {
      if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || null;
    } catch (_) {}
  }
  if (!port) throw new Error(`the browser didn't start: ${exe}`);
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = connect(webSocketDebuggerUrl);
  await cdp.opened;

  const people = [];
  return {
    // a person: their own browser profile (cookies, storage), signed in by
    // name, located at `at` (the browser's location, allowed; null: no
    // GPS signal yet)
    async person(name, at = HOME) {
      const p = await this.visitor(name, at);
      await p.signIn();
      return p;
    },
    // someone not signed in (yet): their own profile, located, on a blank page
    async visitor(name, at = HOME) {
      const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const p = page(cdp, sessionId, name);
      // the location permission for this person: "granted", "prompt" (asks:
      // a headless browser answers its own question "blocked"), "denied"
      p.locationPermission = (setting) =>
        cdp.send("Browser.setPermission", { permission: { name: "geolocation" }, setting, origin: BASE, browserContextId });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: BASE, browserContextId });
      if (at) await p.locate(at);
      else await p.noSignal();
      // done with this person: their page and profile closed (a slow machine
      // with five pages open timed out — owner, 2026-10-31); their page
      // errors so far still count
      p.close = async () => {
        await cdp.send("Target.disposeBrowserContext", { browserContextId });
        const { targetInfos } = await cdp.send("Target.getTargets");
        if (targetInfos.some((t) => t.targetId === targetId)) throw new Error(`${name}: the page didn't close`);
      };
      people.push(p);
      return p;
    },
    async close() {
      try {
        await cdp.send("Browser.close");
      } catch (_) {}
      cdp.close();
      proc.kill();
      await sleep(300);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    },
    // page errors anywhere (uncaught exceptions, console.error)
    errors: () => people.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`)),
  };
}

// a wait that ran out says where this person's app stood: its screen and
// its live connection (intermittent failures at the start, 2026-11-01)
const WHY = `(() => ({
  screen: [...document.querySelectorAll(".screen.active")].map((s) => s.id),
  realUser: typeof state === "object" ? (state.realUser ? state.realUser.id : false) : "no state",
  live: typeof liveNow === "function" ? liveNow() : "no liveNow",
  socket: typeof socket === "object" && socket ? socket.connectionState() : "no socket",
  channel: typeof userChannel === "object" && userChannel ? userChannel.state : "no channel",
  // a join stuck "joining" (2026-11-02): how often it tried, its last answer
  joinTries: typeof userChannel === "object" && userChannel && userChannel.rejoinTimer ? userChannel.rejoinTimer.tries : null,
  joinReply: typeof userChannel === "object" && userChannel && userChannel.joinPush ? userChannel.joinPush.receivedResp : null,
  world: typeof worldChannel === "object" && worldChannel ? worldChannel.state : "no world",
  pageMs: Math.round(performance.now()),
  banner: document.getElementById("banner")?.textContent || "",
  moved: !!document.getElementById("session-moved"),
}))()`;

function page(cdp, sessionId, name) {
  const errors = [];
  let loads = 0;
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Page.loadEventFired") loads++;
    // (where it came from too: a bare "Error" alone can't be traced)
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      const what = d.exception?.description || d.text;
      const at = d.url ? ` @ ${d.url.replace(/^https?:\/\/[^/]+/, "")}:${d.lineNumber}:${d.columnNumber}` : "";
      const top = (d.stackTrace?.callFrames || []).slice(0, 4).map((f) => `${f.functionName || "?"} ${f.url.replace(/^https?:\/\/[^/]+/, "")}:${f.lineNumber}`).join(" < ");
      errors.push(`${what} [${d.text}]${at}${top ? " :: " + top : ""}`);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const f = msg.params.stackTrace?.callFrames?.[0];
      const at = f ? ` @ ${f.url.replace(/^https?:\/\/[^/]+/, "")}:${f.lineNumber}` : "";
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" ") + at);
    }
  });
  const send = (m, p) => cdp.send(m, p, sessionId);

  const p = {
    name,
    errors,
    // run JS in the page (awaits a promise); the value comes back
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  in: ${expression}`);
      return r.result.value;
    },
    // until `expression` is truthy (checked every 100 ms) → its value
    async waitFor(expression, what, ms = 10000) {
      const until = Date.now() + ms;
      let last;
      for (;;) {
        try {
          last = await p.eval(expression);
          if (last) return last;
        } catch (e) {
          last = String(e.message).split("\n")[0];
        }
        if (Date.now() > until) {
          const why = await p.eval(WHY).catch((x) => String(x.message).split("\n")[0]);
          throw new Error(`FAILED (${name}, ${ms} ms): ${what} — last: ${JSON.stringify(last)}\n  why: ${JSON.stringify(why)}`);
        }
        await sleep(100);
      }
    },
    async goto(url) {
      const before = loads;
      await send("Page.navigate", { url });
      await p.waitForLoad(before);
    },
    // a phone-sized view (CSS pixels, drawn at `scale`) — for the README's
    // picture (test_browser/screenshot.mjs)
    async phone(width, height, scale = 2) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: true });
    },
    // hold back every request whose address matches `urlPattern` (Chrome's
    // wildcards: *) for `ms`, then let it through — to see what a slow
    // network does (e.g. the map server's fonts)
    async delayRequests(urlPattern, ms) {
      await send("Fetch.enable", { patterns: [{ urlPattern }] });
      cdp.on((msg) => {
        if (msg.sessionId !== sessionId || msg.method !== "Fetch.requestPaused") return;
        setTimeout(() => send("Fetch.continueRequest", { requestId: msg.params.requestId }).catch(() => {}), ms);
      });
    },
    // run `source` in every page this person opens from now on, before the
    // page's own scripts (e.g. a language loaded as the app will load one)
    async beforeScripts(source) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source });
    },
    // the page as a PNG (bytes)
    async screenshot() {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    },
    async reload() {
      const before = loads;
      await send("Page.reload", {});
      await p.waitForLoad(before);
    },
    async waitForLoad(before) {
      const until = Date.now() + 15000;
      while (loads === before) {
        if (Date.now() > until) {
          // slow or stuck? how far it got, and what it still waits for
          // (2 in 10 runs under load, 2026-11-02)
          const how = await p
            .eval(`JSON.stringify({ url: location.pathname, state: document.readyState, pageMs: Math.round(performance.now()), files: performance.getEntriesByType("resource").length, unfinished: performance.getEntriesByType("resource").filter((r) => !r.responseEnd).map((r) => r.name.split("/").pop()) })`)
            .catch((x) => "no answer: " + String(x.message).split("\n")[0]);
          throw new Error(`${name}: the page didn't load — ${how}`);
        }
        await sleep(50);
      }
    },
    async locate({ latitude, longitude }) {
      await send("Emulation.setGeolocationOverride", { latitude, longitude, accuracy: 10 });
    },
    // no position (no GPS signal: "position unavailable") — a waiting tap
    // keeps waiting until locate() gives one again
    async noSignal() {
      await send("Emulation.setGeolocationOverride", {});
    },
    // the phone's "Reduce motion" setting on / off
    async reduceMotion(on) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] });
    },
    // the dev sign-in (local only), then the app, connected
    async signIn() {
      await p.goto(`${BASE}/privacy`);
      const ok = await p.eval(
        `fetch("/api/dev_login", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: ${JSON.stringify(name)}})}).then(r => r.ok)`
      );
      check(ok, `${name}: dev sign-in`);
      // a new account: the Terms first ("I agree"), then the map
      await p.goto(`${BASE}/`);
      await p.waitFor(
        `document.getElementById("screen-terms").classList.contains("active") || (typeof liveNow === "function" && liveNow() && !!state.realUser)`,
        "the Terms or the app",
        15000
      );
      if (await p.eval(`document.getElementById("screen-terms").classList.contains("active")`)) {
        await p.click("btn-agree");
      }
      // straight on, as a quick refresh: the page just left may still be
      // joining as this one joins — the newer must win, never both told
      // "opened on another device" (2026-11-01, HoodrideWeb.UserChannel)
      await p.open();
    },
    // open the app and wait until it's connected
    async open() {
      await p.goto(`${BASE}/`);
      // the journeys run the minified app (what production runs)
      if (!(await p.eval(`fetch(document.querySelector("script[src^=\\"app.js\\"]").src).then((r) => r.headers.get("x-minified") === "1")`)))
        throw new Error(`${name}: app.js isn't the minified one`);
      // …and its stylesheet too (comments out, as at deploy — owner, 2026-11-02)
      if (!(await p.eval(`fetch(document.querySelector("link[href^=\\"styles.css\\"]").href).then((r) => r.headers.get("x-minified") === "1")`)))
        throw new Error(`${name}: styles.css isn't the minified one`);
      await p.waitFor(`typeof liveNow === "function" && liveNow() && !!state.realUser`, "the app connected", 15000);
    },
    // this person's account id
    id: () => p.eval("state.realUser.id"),
    // (an icon picture reads as its emoji — app.mjs SHOWN)
    banner: () => p.eval(`(() => { const b = document.getElementById("banner"); return b.classList.contains("hidden") ? "" : [...b.childNodes].map((n) => n.nodeType === 3 ? n.textContent : n.dataset && n.dataset.emoji ? n.dataset.emoji + " " : "").join(""); })()`),
    click: (id) => p.eval(`document.getElementById(${JSON.stringify(id)}).click(), true`),
    // a real mouse click at a point on the page (e.g. on the map)
    // a real mouse drag from one point to another (as a finger drags the map)
    async drag(x1, y1, x2, y2) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        const x = x1 + ((x2 - x1) * i) / 8, y = y1 + ((y2 - y1) * i) / 8;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
    },
    async tapAt(x, y) {
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    // the live connection: drop it (Phoenix doesn't retry after this) / back
    drop: () => p.eval("socket.disconnect(), true"),
    restore: () => p.eval("socket.connect(), true"),
    // no network at all (every request fails) / back
    async offline(on) {
      await send("Network.enable");
      await send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      // Chrome can answer before the switch has taken effect — a tap right
      // after then still reached the server offline, or failed back online
      // (the terms journey, ~1 run in 12 under load, 2026-11-01). Wait until
      // a request really fails / really arrives (any answer will do; /api/
      // so the service worker never answers it from its cache).
      const reached = `fetch("/api/net-check", { method: "HEAD", cache: "no-store" }).then(() => true, () => false)`;
      const t0 = Date.now();
      let tries = 0;
      while ((await p.eval(reached)) === on) {
        if (++tries > 100) throw new Error(`FAILED (${name}): the network never went ${on ? "off" : "back on"}`);
        await sleep(50);
      }
      if (tries > 0) console.log(`  (the network took ${Date.now() - t0} ms to go ${on ? "off" : "on"})`);
    },
  };
  return p;
}

// run a journey: the steps, then the page errors check; exit code = verdict
export async function journey(title, body) {
  console.log(`journey: ${title}`);
  let browser;
  try {
    browser = await launch();
    await body(browser);
    const errs = browser.errors();
    check(errs.length === 0, "no page errors", errs);
    console.log("  ok");
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.log(`  ${e.message}`);
    if (browser) await browser.close();
    process.exit(1);
  }
}
