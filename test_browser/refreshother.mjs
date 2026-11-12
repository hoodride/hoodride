// A2 (2026-11-11): "Refresh from Google" that comes back as ANOTHER Google
// account (someone signed into two picks the other one at Google's picker).
// The server signs no one in and sends the app back with ?refresh=other
// (test/hoodride_web/sign_in_refresh_test.exs proves that half — Google
// itself can't be driven here); this journey proves the app's half: the
// person is told, in their language, still signed in as themselves, and
// the note is taken out of the address so a reload doesn't show it again.
import { journey, step, check, BASE } from "./cdp.mjs";
import { bannerIs } from "./app.mjs";

const connected = `typeof liveNow === "function" && liveNow() && !!state.realUser`;
const NOTE = "That's a different Google account — sign out first to use it";
const NOTE_ES = "Esa es otra cuenta de Google. Cierra sesión primero para usarla";

await journey("refreshother: a refresh back as another Google account — told, still signed in as before", async (browser) => {
  step("Rhea signs in");
  const rhea = await browser.person("BT-Rhea");
  const id = await rhea.id();

  step("back from Google as another account: the note, still Rhea, the address cleaned");
  await rhea.goto(`${BASE}/?refresh=other`);
  await rhea.waitFor(connected, "connected");
  await bannerIs(rhea, NOTE);
  check((await rhea.eval(`state.realUser && state.realUser.id`)) === id, "still Rhea");
  check((await rhea.eval(`location.search`)) === "", "the note taken out of the address");

  step("a reload doesn't show it again");
  await rhea.goto(`${BASE}/`);
  await rhea.waitFor(connected, "connected again");
  check((await rhea.eval(`document.getElementById("banner").textContent`)) !== NOTE, "not shown again");

  step("in Spanish: the note in Spanish");
  await rhea.eval(`(document.cookie = "hoodride_lang=es; path=/; SameSite=Lax", true)`);
  await rhea.goto(`${BASE}/?refresh=other`);
  await rhea.waitFor(connected, "connected (es)");
  await bannerIs(rhea, NOTE_ES);
});
