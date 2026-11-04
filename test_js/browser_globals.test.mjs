// The shared app files run in two places (owner, 2026-10-29): in Node for
// these tests (`module.exports`) and in the browser as a global the app uses
// (`root.HoodX = factory()`). Every other test takes the Node branch, so the
// browser line was never run: rename a global and the tests stay green
// while the app breaks. Here each file runs as the PAGE runs it — no
// `module`, `self` is the page — in index.html's order (ridepos.js needs
// HoodSendFilter first), and must register under the name app.js uses.
// Run: node --test "test_js/*.test.mjs"   (part of `mix precommit`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "../priv/static");
const read = (f) => readFileSync(join(STATIC, f), "utf8");

const html = read("index.html");
const app = read("app.js");

// the page's own scripts, in order, that register a Hood… global
const shared = [...html.matchAll(/<script src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((f) => !f.includes(":") && f !== "app.js")
  .map((file) => ({ file, src: read(file) }))
  .flatMap(({ file, src }) => {
    const m = src.match(/root\.(Hood[A-Za-z]+) = factory\(/);
    return m ? [{ file, name: m[1], src }] : [];
  });

// one page: every file shares it, as on the real page
function page() {
  const sandbox = {};
  sandbox.self = sandbox;
  return vm.createContext(sandbox);
}

test("every shared file is found (none silently skipped)", () => {
  const all = shared.map((s) => s.file);
  for (const f of ["googlerefresh.js", "chatlist.js", "navlink.js", "ridepos.js", "sendfilter.js", "update.js"])
    assert.ok(all.includes(f), `${f} not found among the page's shared scripts`);
  assert.ok(shared.length >= 22, `found ${shared.length}`);
});

test("in the browser, each registers its global — the name app.js uses", () => {
  const ctx = page();
  for (const { file, name, src } of shared) {
    vm.runInContext(src, ctx, { filename: join(STATIC, file) });
    const g = ctx[name];
    assert.ok(g && (typeof g === "object" || typeof g === "function"), `${file}: no ${name} on the page`);
    assert.ok(Object.keys(g).length > 0, `${file}: ${name} is empty`);
    assert.ok(app.includes(name + "."), `${file}: app.js never uses ${name}`);
  }
});

test("the browser copy is the same API as the Node copy the other tests check", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const ctx = page();
  for (const { file, name, src } of shared) {
    vm.runInContext(src, ctx, { filename: join(STATIC, file) });
    const node = require(join(STATIC, file));
    assert.deepEqual(Object.keys(ctx[name]).sort(), Object.keys(node).sort(), `${file}: browser and Node differ`);
  }
});

test("Refresh from Google, in the browser: the functions app.js calls", () => {
  const ctx = page();
  vm.runInContext(read("googlerefresh.js"), ctx, { filename: join(STATIC, "googlerefresh.js") });
  for (const fn of ["changeTapped", "take", "forget", "isDue", "shouldRefresh", "outcome", "withoutOutcome"])
    assert.equal(typeof ctx.HoodGoogleRefresh[fn], "function", fn);
});
