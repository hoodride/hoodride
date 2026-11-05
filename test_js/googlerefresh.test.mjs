// "Refresh from Google" (owner, 2026-10-29): Hood Ride keeps its own copy of
// the name and photo, made at sign-in. After "Change ↗" (Google's Personal
// info page), the next time the person is back the app refreshes once,
// silently (a Google round trip, /auth/google?refresh=silent) — unless
// something is in progress (HoodUpdate.isBusy: the same rule as app
// updates). The button stays as the backup.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../priv/static/googlerefresh.js");

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    size: () => m.size,
  };
}

// (the "Refresh from Google" button lives in the Change box now, always —
// owner, 2026-10-29: nothing to "offer" any more, only "due")
test("tapping Change on Google: a refresh is due", () => {
  const s = memStorage();
  assert.equal(R.isDue(s), false);
  R.changeTapped(s);
  assert.equal(R.isDue(s), true);
  assert.equal(R.isOffered, undefined, "the offer is gone");
});

test("taking the refresh clears 'due' FIRST (a failure can't loop)", () => {
  const s = memStorage();
  R.changeTapped(s);
  R.take(s);
  assert.equal(R.isDue(s), false);
});

test("refresh only when due, a Google account, back from away, and not busy", () => {
  const ok = { due: true, google: true, away: true, busy: false };
  assert.equal(R.shouldRefresh(ok), true);
  assert.equal(R.shouldRefresh({ ...ok, due: false }), false, "nothing changed at Google");
  assert.equal(R.shouldRefresh({ ...ok, google: false }), false, "not a Google sign-in");
  assert.equal(R.shouldRefresh({ ...ok, away: false }), false, "never left the page");
  assert.equal(R.shouldRefresh({ ...ok, busy: true }), false, "a ride, a shift, a draft: wait");
});

test("what the server says back: a short message, or nothing", () => {
  // the steps as the screen shows them — no screen says "Settings" (2026-11-04)
  assert.match(R.outcome("?refresh=failed"), /tap your profile picture at the top left, then Change, then Refresh from Google/);
  assert.doesNotMatch(R.outcome("?refresh=failed"), /Settings/);
  assert.match(R.outcome("?refresh=ride"), /after your ride/);
  assert.match(R.outcome("?refresh=limit"), /try again in a few minutes/);
  assert.match(R.outcome("?refresh=blocked"), /Couldn't refresh right now/);
  assert.equal(R.outcome("?demo=1"), null);
  assert.equal(R.outcome(""), null);
  assert.equal(R.outcome("?refresh=<script>"), null, "only the known answers");
});

test("the outcome is taken out of the address, other parameters kept", () => {
  assert.equal(R.withoutOutcome("?refresh=failed"), "");
  assert.equal(R.withoutOutcome("?demo=1&refresh=ride"), "?demo=1");
  assert.equal(R.withoutOutcome(""), "", "no address part at all");
  assert.equal(R.withoutOutcome(undefined), "");
});

test("signing out forgets it all; no storage (private mode) never throws", () => {
  const s = memStorage();
  R.changeTapped(s);
  // a phone that ran the earlier version still has its old "offer" key
  s.setItem("hoodride_google_refresh_offer", "1");
  R.forget(s);
  assert.equal(s.size(), 0, "the old key goes too");
  for (const f of [R.changeTapped, R.take, R.forget]) assert.doesNotThrow(() => f(null));
  assert.equal(R.isDue(null), false);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => R.changeTapped(broken));
  assert.doesNotThrow(() => R.take(broken), "removing, too");
  assert.doesNotThrow(() => R.forget(broken));
  assert.equal(R.isDue(broken), false);
});
