// Offline right after a deploy (U1, owner 2026-11-11): a new version's
// worker takes over and wipes the old offline copy — the copy it builds
// itself must still open the app in the person's language, with its
// pictures, with no signal.
import { journey, step, check, BASE, server } from "./cdp.mjs";

// what the page shows: its language, the catalog loaded, every picture on
// screen loaded (a broken one has no size)
const LOOK = `({
  lang: document.documentElement.lang,
  catalog: typeof HoodI18n !== "undefined" && HoodI18n.lang(),
  login: !!document.getElementById("screen-login"),
  broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).map((i) => i.getAttribute("src")),
})`;

await journey("offline right after a deploy: the app still opens, in the person's language", async (browser) => {
  step("Oto, in Japanese: the app opened and kept for offline");
  const oto = await browser.visitor("BT-Oto");
  await oto.phone(390, 780, 2);
  await oto.goto(`${BASE}/`);
  await oto.eval(`(document.cookie = "hoodride_lang=ja; path=/; SameSite=Lax", true)`);
  await oto.goto(`${BASE}/`);
  await oto.waitFor(`navigator.serviceWorker.ready.then(() => true)`, "the offline copy installed", 20000);
  await oto.goto(`${BASE}/ja`);
  await oto.waitFor(`!!navigator.serviceWorker.controller`, "the worker in charge", 20000);
  await oto.waitFor(`caches.match("/").then((r) => r ? r.text() : "").then((t) => t.includes('<html lang="ja">'))`, "the Japanese home saved", 20000);
  const firstCache = await oto.eval(`caches.keys().then((k) => k.join(","))`);
  // (before any deploy: offline, it opens in Japanese)
  await oto.offline(true);
  await oto.goto(`${BASE}/`);
  await oto.waitFor(`document.readyState === "complete"`, "the page");
  const before = await oto.eval(LOOK);
  check(before.login && before.lang === "ja" && before.catalog === "ja" && before.broken.length === 0, "offline before a deploy: in Japanese", before);
  await oto.offline(false);
  await oto.goto(`${BASE}/ja`);

  step("a new version is deployed; his app picks up its worker (the old offline copy wiped)");
  await server("new_build");
  await oto.eval(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
  await oto.waitFor(
    `caches.keys().then((k) => k.length === 1 && k[0] !== ${JSON.stringify(firstCache)})`,
    "the new version's offline copy (only)",
    30000
  );

  step("no signal, he opens the app: it opens — in Japanese, every picture there");
  // (only the offline copy to go on: the browser's own cache can be gone)
  await oto.clearHttpCache();
  await oto.offline(true);
  // (the worker's OWN requests offline too? an address it never saved, through it)
  const probe = await oto.eval(`fetch("/privacy?probe=" + Date.now()).then((r) => "reached: " + r.status, (e) => "failed: " + e.message)`);
  check(probe.startsWith("failed"), "(the worker's own requests fail too: really offline)", probe);
  await oto.goto(`${BASE}/`);
  await oto.waitFor(`document.readyState === "complete"`, "the page");
  const off = await oto.eval(LOOK);
  check(off.login, "the app opened (not the browser's offline page)", off);
  check(off.lang === "ja" && off.catalog === "ja", "in Japanese", off);
  check(off.broken.length === 0, "no broken pictures", off);
  await oto.offline(false);
  await oto.close();
});
