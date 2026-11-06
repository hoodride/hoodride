// Every language, every label each button can show, beside its real
// neighbours on the real screens: nothing spills out or is cut off (split
// from languages.mjs, owner 2026-11-05).
import { readdirSync } from "node:fs";
import { journey, step, check, BASE } from "./cdp.mjs";
import { FITS_ALL } from "./langcheck.mjs";

await journey("language labels: every label fits, in every language", async (browser) => {
  // EVERY language, every label each button can show, in a copy of that
  // button: nothing spills (quick; the walk below covers whole screens for
  // the longest and widest)
  step("every language: every screen's labels fit, beside each other");
  const langs = readdirSync(new URL("../priv/static/", import.meta.url))
    .map((f) => (f.match(/^i18n-(.+)\.js$/) || [])[1])
    .filter((l) => l && l !== "en-XA");
  check(langs.length >= 42, "all the languages", langs.length);
  const pf = await browser.visitor("BT-Fit");
  await pf.phone(390, 780, 2);
  await pf.goto(`${BASE}/?demo=1`);
  await pf.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map`, "the demo");
  const spilled = await pf.eval(FITS_ALL(langs));
  check(spilled.length === 0, "every label fits, in every language", spilled);
  check(pf.errors.length === 0, "no page errors", pf.errors);
  await pf.close();
});
