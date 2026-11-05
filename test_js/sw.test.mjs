// Node tests for priv/static/sw.js — the offline copy of the app. The real
// worker file runs here with a fake network and a fake cache.
// While the server is down Cloudflare answers for it with an error page
// (502/530): the phone is online, so "fall back when offline" never ran and
// people saw Cloudflare's page instead of the app — which says "Can't reach
// Hood Ride — retrying…" and comes back by itself (owner, 2026-10-30).
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../priv/static/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://hoodride.app";

const answer = (status, body = `status ${status}`) => ({
  status,
  ok: status >= 200 && status < 300,
  body,
  clone() {
    return answer(status, body);
  },
});

// the worker, loaded fresh: `network(url)` → an answer, or throws (no signal)
function worker({ network, saved = {} }) {
  const store = new Map(Object.entries(saved).map(([path, body]) => [ORIGIN + path, answer(200, body)]));
  const listeners = {};
  const cache = {
    put: async (req, res) => void store.set(req.url, res),
    addAll: async () => {},
  };
  const context = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => (listeners[type] = fn),
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => cache,
      match: async (req) => store.get(req.url),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (req) => network(req.url),
    Request: class {
      constructor(url) {
        this.url = url;
      }
    },
    URL,
    Promise,
  };
  vm.runInNewContext(SRC, context);

  // → the answer the page gets, or null (the worker left it to the browser)
  // `mode`: "navigate" for a page opened, as the browser marks it
  async function get(path, method = "GET", mode = "cors") {
    let responded = null;
    listeners.fetch({ request: { url: ORIGIN + path, method, mode }, respondWith: (p) => (responded = p) });
    if (!responded) return null;
    const res = await responded;
    await new Promise((r) => setImmediate(r)); // let a save finish
    return res;
  }
  const savedBody = (path) => store.get(ORIGIN + path)?.body;
  return { get, savedBody };
}

test("a good answer: shown, and saved as the offline copy", async () => {
  const w = worker({ network: () => answer(200, "new app") });
  assert.equal((await w.get("/")).body, "new app");
  assert.equal(w.savedBody("/"), "new app");
});

test("the server down (Cloudflare's 502/530, a 503): the saved app instead, kept", async () => {
  for (const status of [500, 502, 503, 504, 520, 522, 530]) {
    const w = worker({ network: () => answer(status, "cloudflare error page"), saved: { "/": "saved app" } });
    const res = await w.get("/");
    assert.equal(res.body, "saved app", `status ${status}`);
    assert.equal(w.savedBody("/"), "saved app", `status ${status}: never overwritten`);
  }
});

test("the server down and nothing saved yet: the error itself (nothing better to show)", async () => {
  const w = worker({ network: () => answer(502, "cloudflare error page") });
  const res = await w.get("/app.js");
  assert.equal(res.status, 502);
  assert.equal(w.savedBody("/app.js"), undefined, "an error is never saved");
});

// a 404 is a real answer (that file isn't there): not hidden behind an old copy
test("a 4xx is the server's real answer: passed on, not replaced, not saved", async () => {
  const w = worker({ network: () => answer(404, "not found"), saved: { "/old.js": "saved" } });
  assert.equal((await w.get("/old.js")).status, 404);
  assert.equal(w.savedBody("/old.js"), "saved");
});

test("no signal at all: the saved copy (as before)", async () => {
  const w = worker({
    network: () => {
      throw new TypeError("Failed to fetch");
    },
    saved: { "/": "saved app" },
  });
  assert.equal((await w.get("/")).body, "saved app");
});

test("/api/, /auth/, /avatars/ and non-GETs are left to the browser (never saved)", async () => {
  const w = worker({ network: () => answer(502) });
  for (const path of ["/api/state", "/auth/google", "/avatars/1.jpg"]) assert.equal(await w.get(path), null, path);
  assert.equal(await w.get("/", "POST"), null);
});

// ----- each language's own home (owner, 2026-11-05): "/" can be a redirect
// to /ja — a saved redirect can't be shown offline (browsers refuse it), so
// "/" isn't saved at install; the home the person opens is kept as "/" -----
const redirect = () => ({ status: 0, ok: false, type: "opaqueredirect", body: "", clone() { return redirect(); } });
const offline = () => {
  throw new TypeError("Failed to fetch");
};

test("the offline list doesn't download / (it can be a redirect); index.html, the English page, it does", () => {
  const list = SRC.match(/const ASSETS = \[([\s\S]*?)\];/)[1];
  assert.ok(!/"\.\/"/.test(list), "./ in the install list");
  assert.ok(/"index\.html"/.test(list));
});

test("/ answered by a redirect to the visitor's language: passed on, never saved", async () => {
  const w = worker({ network: () => redirect() });
  assert.equal((await w.get("/", "GET", "navigate")).type, "opaqueredirect");
  assert.equal(w.savedBody("/"), undefined);
});

test("a language's home opened: saved as itself and as / (the installed app's start)", async () => {
  const w = worker({ network: () => answer(200, "the app in Japanese") });
  await w.get("/ja", "GET", "navigate");
  assert.equal(w.savedBody("/ja"), "the app in Japanese");
  assert.equal(w.savedBody("/"), "the app in Japanese");
  // other pages: only as themselves
  const v = worker({ network: () => answer(200, "the terms") });
  await v.get("/ja/terms", "GET", "navigate");
  await v.get("/terms", "GET", "navigate");
  assert.equal(v.savedBody("/"), undefined, "a legal page never becomes the home page");
});

test("offline, / opens the home the person last used, in their language", async () => {
  const w = worker({ network: offline, saved: { "/": "the app in Japanese", "/index.html": "English" } });
  assert.equal((await w.get("/", "GET", "navigate")).body, "the app in Japanese");
  // a language's home never opened: that same saved home
  assert.equal((await w.get("/es", "GET", "navigate")).body, "the app in Japanese");
});

test("offline and no home saved yet: the English page (index.html)", async () => {
  const w = worker({ network: offline, saved: { "/index.html": "English" } });
  assert.equal((await w.get("/", "GET", "navigate")).body, "English");
  // a file isn't a page: never answered with the page
  assert.equal(await w.get("/app.js?vsn=1", "GET", "cors"), undefined);
});
