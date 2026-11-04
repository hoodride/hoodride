// Settings and your car (owner, 2026-10-30): the drawer shows your name and
// asks for a car; Go online without one asks first; the car saved, riders
// see it — "Other" as just make and model.
import { journey, step, check } from "./cdp.mjs";
import { sees } from "./app.mjs";

await journey("settings: the drawer, your car, Go online without one", async (browser) => {
  step("Dan, new, opens Settings: his name; no car yet; no 'Change' (not a Google account)");
  const dan = await browser.person("BT-Dan");
  const rita = await browser.person("BT-Rita");
  await dan.click("btn-account");
  await dan.waitFor(`settingsOpen()`, "Settings open");
  check((await dan.eval(`document.getElementById("settings-name").textContent`)) === "BT-Dan", "his name");
  await dan.waitFor(`document.getElementById("car-note").textContent === "Add it before you drive"`, "no car yet");
  check(await dan.eval(`document.getElementById("settings-change").classList.contains("hidden")`), "no Change box for a dev account");
  check((await dan.eval(`document.getElementById("logout-note").textContent`)) === "On all your devices", "sign out: on all devices");
  await dan.eval(`closeSettings(), true`);

  step("Go online with no car: the car form opens first");
  await dan.click("btn-mode");
  await dan.waitFor(`state.mode === "driver"`, "driver mode");
  await dan.click("btn-online");
  await dan.waitFor(`carSheetOpen()`, "the car form");
  check(await dan.eval(`!state.online`), "not online yet");

  step("a blank form: each field named; then Other, Honda, Civic: saved, and online");
  await dan.eval(`document.getElementById("car-sheet").requestSubmit(), true`);
  await dan.waitFor(`document.getElementById("car-error").textContent === "Check the color, make, model (up to 24 letters each)."`, "the error names the fields");
  await dan.eval(`(() => {
    document.getElementById("car-color").value = "Other";
    document.getElementById("car-make").value = "Honda";
    document.getElementById("car-model").value = "Civic";
    document.getElementById("car-sheet").requestSubmit();
    return true;
  })()`);
  await dan.waitFor(`!carSheetOpen()`, "the form closed");
  await dan.waitFor(`state.online`, "online", 15000);

  step("Settings: the car, as riders read it — no 'Other'");
  await dan.click("btn-account");
  await dan.waitFor(`document.getElementById("car-note").textContent === "Honda Civic"`, "Honda Civic");
  await dan.eval(`closeSettings(), true`);

  step("Rita taps Dan's car: 'Honda Civic'");
  const danId = await dan.id();
  await sees(rita, danId);
  await rita.eval(`openMarkerCard(realPeersById.get(${danId}), "driver"), true`);
  await rita.waitFor(`document.getElementById("peer-card").textContent.includes("BT-Dan")`, "the card, named");
  const card = await rita.eval(`document.getElementById("peer-card").textContent`);
  check(card.includes("Honda Civic") && !card.includes("Other"), "the card says Honda Civic", card);
});
