// Node tests for priv/static/session.js — the device you chose last wins.
// A connect is a CHOICE (takes over) only while the tab has no stamp yet:
// a page load, a refresh, "Use here". Once the server gave the tab its
// stamp, every later connect is automatic and carries it: it gets in only
// if no newer choice exists. Our silent update reload is never a choice:
// it hands the old stamp to the reloaded page through a one-time note.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { connectParams, noteQuietReload, takeQuietReload } = require("../priv/static/session.js");

// a stand-in for window.sessionStorage
function storage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    size: () => m.size,
  };
}

test("a page load (no stamp yet) is a choice: it takes over", () => {
  assert.deepEqual(connectParams(null), { takeover: "true" });
});

test("once the tab has its stamp, a reconnect is automatic and carries it", () => {
  assert.deepEqual(connectParams(1792937109245123), {
    stamp: "1792937109245123",
    takeover: "false",
  });
});

test("a quiet update reload hands the old stamp over: no takeover", () => {
  const s = storage();
  noteQuietReload(s, 1792937109245123);
  const stamp = takeQuietReload(s);
  assert.equal(stamp, 1792937109245123);
  assert.equal(connectParams(stamp).takeover, "false");
});

test("the note is read ONCE: the page after it (a refresh) is a choice again", () => {
  const s = storage();
  noteQuietReload(s, 77);
  takeQuietReload(s);
  assert.equal(takeQuietReload(s), null);
  assert.equal(s.size(), 0, "nothing left behind (a duplicated tab copies this storage)");
  assert.deepEqual(connectParams(takeQuietReload(s)), { takeover: "true" });
});

test("a quiet reload before the tab ever got a stamp is a plain page load", () => {
  const s = storage();
  noteQuietReload(s, null);
  assert.equal(s.size(), 0, "nothing noted");
  assert.equal(takeQuietReload(s), null);
});

test("storage that throws (private mode, blocked) never breaks the app", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => noteQuietReload(broken, 5));
  assert.equal(takeQuietReload(broken), null);
  assert.equal(takeQuietReload(undefined), null);
});

test("a note that isn't a stamp is ignored", () => {
  for (const junk of ["", "abc", "-4", "1e3", "12.5"]) {
    const s = storage();
    s.setItem("hoodride_quiet_reload_stamp", junk);
    assert.equal(takeQuietReload(s), null, `note ${JSON.stringify(junk)}`);
  }
});

// Sign-in: the Google button used to call /api/dev_login and, when that
// failed (prod), silently enter a FAKE demo profile — nobody could really
// sign in. Now: this machine (where dev_login works) uses dev_login;
// anywhere else goes to Google.
test("sign-in goes to Google anywhere but this machine", () => {
  const { loginRoute } = require("../priv/static/session.js");
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(loginRoute(h), "dev", h);
  for (const h of ["hoodride.app", "192.168.1.20", "abc.trycloudflare.com", "localhost.evil.com"])
    assert.equal(loginRoute(h), "google", h);
});
