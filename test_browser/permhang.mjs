// A browser whose "is location allowed?" check never answers (leftovers
// review, 2026-11-13; reported on some iPhones). The app waited for it for
// ever — and skipped every later check meanwhile: a shift (or ride) resumed
// after a reload never started GPS. Now the check gets a couple of seconds,
// then GPS starts as when a browser has no check at all
// (test_js/locator.test.mjs: the rule itself).
import { journey, step, check } from "./cdp.mjs";
import { goOnline } from "./app.mjs";

await journey("permhang: a permission check that never answers — a resumed shift still starts GPS", async (browser) => {
  step("Dan (driver) goes online");
  const dan = await browser.person("BT-Dan");
  await goOnline(dan);

  step("his browser's permission check stops answering; he reloads: his shift resumes WITH GPS");
  await dan.onEveryPage(`(() => {
    if (navigator.permissions) navigator.permissions.query = () => new Promise(() => {});
    const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (...a) => ((window.__watching = (window.__watching || 0) + 1), watch(...a));
  })()`);
  await dan.reload();
  await dan.waitFor(`typeof state !== "undefined" && state.online === true`, "the shift resumed", 15000);
  await dan.waitFor(`window.__watching > 0`, "GPS started (within a few seconds)", 8000);
  check(await dan.eval(`state.online === true`), "still online");
});
