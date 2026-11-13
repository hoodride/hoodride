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
  // the GitHub mark between Sign out and the legal links, at least 24 px
  // from each (WCAG 2.2's spacing for small targets) — Delete account stays
  // last and alone (owner, 2026-11-04), on a small phone and a usual one
  for (const width of [360, 390]) {
    await dan.phone(width, 740);
    const gaps = await dan.eval(`(() => {
      const box = (e) => e.getBoundingClientRect();
      const gap = (a, b) => Math.round(Math.max(b.top - a.bottom, a.top - b.bottom, b.left - a.right, a.left - b.right));
      const [cat, dc] = [...document.querySelectorAll(".drawer-source img")].map(box), out = box(document.getElementById("btn-logout")), del = box(document.getElementById("btn-delete"));
      return { signOut: Math.min(gap(out, cat), gap(out, dc)), delete: Math.min(gap(cat, del), gap(dc, del)), apart: gap(cat, dc), deleteLast: del.top > Math.max(cat.bottom, dc.bottom), oneLine: Math.round(box(document.querySelector(".drawer-legal")).height) < 30 };
    })()`);
    check(gaps.signOut >= 24 && gaps.delete >= 24 && gaps.apart >= 24 && gaps.deleteLast && gaps.oneLine, `${width} px: GitHub and Discord ≥ 24 px from Sign out, Delete and each other; Delete last, on one line`, gaps);
  }
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

  // owner, 2026-11-13: "Your car" and "Navigation app" open OVER Settings,
  // as the language list does — the drawer never slides away under them,
  // and closing them is back in Settings, not on the map
  step("Your car and Navigation app open over Settings; closing them is back in Settings");
  // the drawer all the way open, and still so a few frames on (a slide
  // away would have moved it by then: 0.2 s)
  const drawerStays = async (what) => {
    await dan.eval(`new Promise((ok) => setTimeout(() => ok(true), 300))`);
    const d = await dan.eval(`({ open: settingsOpen(), left: Math.round(document.getElementById("settings-sheet").getBoundingClientRect().left) })`);
    check(d.open && d.left === 0, `${what}: Settings still open under it, not sliding away`, d);
  };
  await dan.waitFor(`Math.abs(document.getElementById("settings-sheet").getBoundingClientRect().left) < 0.5`, "Settings all the way open");
  await dan.click("btn-car");
  await dan.waitFor(`carSheetOpen()`, "the car form, from Settings");
  await drawerStays("the car form open");
  await dan.click("car-cancel");
  await dan.waitFor(`!carSheetOpen()`, "the car form cancelled");
  await drawerStays("the car form cancelled");
  await dan.click("btn-car");
  await dan.waitFor(`carSheetOpen()`, "the car form again");
  await dan.eval(`(document.getElementById("car-model").value = "Accord", document.getElementById("car-sheet").requestSubmit(), true)`);
  await dan.waitFor(`!carSheetOpen()`, "saved");
  await dan.waitFor(`document.getElementById("car-note").textContent === "Honda Accord"`, "Settings shows the new car");
  await drawerStays("the car saved");
  await dan.click("btn-navapp");
  await dan.waitFor(`!document.getElementById("nav-sheet").classList.contains("hidden")`, "the map-app box, from Settings");
  await drawerStays("the map-app box open");
  const pick = await dan.eval(`(() => { const a = [...document.querySelectorAll(".nav-choice")].find((x) => !x.classList.contains("hidden")); a.click(); return a.textContent.trim(); })()`);
  await dan.waitFor(`document.getElementById("nav-sheet").classList.contains("hidden")`, "an app picked");
  await dan.waitFor(`document.getElementById("navapp-note").textContent === ${JSON.stringify(pick)}`, "Settings shows the app picked");
  await drawerStays("an app picked");
  await dan.click("btn-navapp");
  await dan.waitFor(`!document.getElementById("nav-sheet").classList.contains("hidden")`, "the map-app box again");
  await dan.click("nav-cancel");
  await dan.waitFor(`document.getElementById("nav-sheet").classList.contains("hidden")`, "the map-app box cancelled");
  await drawerStays("the map-app box cancelled");
  await dan.eval(`closeSettings(), true`);

  step("Rita taps Dan's car: 'Honda Accord'");
  const danId = await dan.id();
  await sees(rita, danId);
  await rita.eval(`openMarkerCard(realPeersById.get(${danId}), "driver"), true`);
  await rita.waitFor(`document.getElementById("peer-card").textContent.includes("BT-Dan")`, "the card, named");
  const card = await rita.eval(`document.getElementById("peer-card").textContent`);
  check(card.includes("Honda Accord") && !card.includes("Other"), "the card says Honda Accord", card);
});
