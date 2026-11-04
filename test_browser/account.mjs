// The account (owner, 2026-10-30): one live session per account ("opened
// on another device" → Use here), a new version while the app is open
// ("Update available — tap to reload"), and deleting the account (gone,
// signed out, the other person's chat closed).
import { journey, step, check, server } from "./cdp.mjs";
import { goOnline, sees, openChatWith, typeText, send } from "./app.mjs";

const moved = (p) => p.eval(`!!document.getElementById("session-moved")`);

await journey("account: another device, a new version, deleting the account", async (browser) => {
  step("Rita (rider, on her phone) messages Dan (driver, online)");
  const phone = await browser.person("BT-Rita");
  const dan = await browser.person("BT-Dan");
  await goOnline(dan);
  const [ritaId, danId] = [await phone.id(), await dan.id()];
  await sees(phone, danId);
  await openChatWith(phone, danId);
  await typeText(phone, "hi Dan");
  await send(phone);
  await dan.waitFor(`chats.has(realPeersById.get(${ritaId}))`, "Dan has Rita's chat");
  await phone.eval(`closeChat(), true`);

  step("Rita opens Hood Ride on her laptop: the phone says so; the laptop is live");
  const laptop = await browser.person("BT-Rita");
  check((await laptop.id()) === ritaId, "the same account");
  await phone.waitFor(`!!document.getElementById("session-moved")`, "the phone: 'opened on another device'");
  check(await laptop.eval("liveNow()"), "the laptop is live");

  step("'Use here' on the phone: the phone is live again, the laptop says so");
  await phone.click("btn-use-here");
  await phone.waitFor(`typeof liveNow === "function" && liveNow() && !document.getElementById("session-moved")`, "the phone live again", 15000);
  await laptop.waitFor(`!!document.getElementById("session-moved")`, "the laptop: 'opened on another device'");
  check(!(await moved(phone)), "no notice on the phone");

  step("a new version is deployed: the open app offers 'Update available — tap to reload'");
  const loaded = await phone.eval(`LOADED_BUILD`);
  await server("new_build");
  await phone.drop();
  await phone.restore();
  await phone.waitFor(`(() => { const b = document.getElementById("update-available"); return !!b && b.textContent === "Update available — tap to reload"; })()`, "the update button", 15000);

  step("tapped: the app reloads into the new version, the button gone");
  await phone.click("update-available");
  await phone.waitFor(`typeof LOADED_BUILD !== "undefined" && LOADED_BUILD === "journey-new-build" && liveNow()`, "running the new version", 15000);
  check(!(await phone.eval(`!!document.getElementById("update-available")`)), "no update button now");
  check(loaded !== "journey-new-build", "it was another version before", loaded);

  step("Rita deletes her account: confirmed, signed out, gone; Dan's chat with her closes");
  await phone.click("btn-account");
  await phone.waitFor(`settingsOpen()`, "Settings open");
  await phone.click("btn-delete");
  // (shown, not just there: it lives in the drawer, hidden until asked)
  await phone.waitFor(`document.getElementById("settings-sheet").classList.contains("confirming") && document.getElementById("delete-yes").offsetParent !== null`, "the confirm step, shown");
  await phone.click("delete-yes");
  await phone.waitFor(`typeof state !== "undefined" && !state.realUser && !document.getElementById("auth-buttons").classList.contains("hidden")`, "signed out", 15000);
  const me = await phone.eval(`fetch("/api/me").then((r) => r.json())`);
  check(me.user === null, "the server: nobody signed in", me);
  await dan.waitFor(`!chats.has(realPeersById.get(${ritaId}))`, "Dan's chat with Rita closed");
});
