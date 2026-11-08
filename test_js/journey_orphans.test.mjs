// A journey script quits, and takes its browser along, when the test that
// started it is gone (owner, 2026-11-07): a crashed run's script and its
// headless browser kept running for hours, their pages reconnecting to every
// later test server. The test that starts a journey is on the other end of
// its stdin (test/browser/journeys_test.exs); here that end is closed.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../test_browser/cdp.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/hang_journey.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let browser = null;
try {
  browser = findBrowser();
} catch {}

test("cut off from the test that started it: the script and its browser quit", { skip: !browser && "no browser here", timeout: 40000 }, async () => {
  const child = spawn(process.execPath, [FIXTURE], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  try {
    for (let i = 0; i < 200 && !out.includes("PIDS "); i++) await sleep(100);
    const m = out.match(/PIDS (\[.*\])/);
    assert.ok(m, `the journey never started its browser: ${out}`);
    const pids = JSON.parse(m[1]);
    assert.ok(pids.length === 1 && alive(pids[0]), `its browser running: ${m[1]}`);

    child.stdin.end(); // the test is gone

    const code = await Promise.race([exited, sleep(5000).then(() => "still running")]);
    assert.equal(code, 1, "the script quit (a journey that didn't finish fails)");
    for (let i = 0; i < 50 && alive(pids[0]); i++) await sleep(100);
    assert.ok(!alive(pids[0]), "its browser quit too");
    assert.match(out, /the test that started this journey is gone: quitting/);
  } finally {
    if (alive(child.pid)) child.kill();
  }
});
