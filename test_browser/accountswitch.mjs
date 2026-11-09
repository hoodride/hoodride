// One account per tab (owner, 2026-11-08). Every tab of a browser shares one
// sign-in: here tab 1 shows Ada, then tab 2 of the SAME browser signs in as
// Bo and is the one in use. Tab 1 used to act on Bo — save the car to Bo,
// draw Bo's data as Ada's, loop on "Connection problem — retrying". Now its
// requests say "this tab shows Ada" and are refused (HoodrideWeb.SameUser):
// tab 1 steps aside under the "Use here" cover IN PLACE — no reload, so it
// never takes the session from tab 2 — and nothing is done to either
// account. "Use here" then reloads tab 1 as Bo (the person's own choice).
import { journey, step, check, server, BASE } from "./cdp.mjs";

const cover = `!!document.getElementById("btn-use-here")`;
const inUse = `!document.getElementById("session-moved") && typeof liveNow === "function" && liveNow()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tab 1 (the page given) watches itself: never Bo's account, never Bo's
// chat, and the same page throughout (a reload would clear the mark)
const watch = (aId) => `(() => {
  window.__wrong = [];
  window.__mark = "same page";
  window.__retrying = false;
  setInterval(() => {
    if (state.realUser && state.realUser.id !== ${aId}) window.__wrong.push("account " + state.realUser.id);
    for (const p of chats.keys()) if (p.name === "BT-Quiet") window.__wrong.push("Bo's chat");
    const b = document.getElementById("banner");
    if (b && b.textContent.includes("retrying")) window.__retrying = true;
  }, 20);
  return true;
})()`;

// tab 2 of the same browser signs in as Bo and opens the app: in use
async function boInTab2(ada, name) {
  const bo = await ada.openSameProfileTab(name);
  await bo.signIn();
  await bo.waitFor(inUse, `${name}: in use`, 15000);
  const boId = await bo.id();
  // Bo has a chat — drawn under Ada's name, it would show
  await server(`quiet_chat ${boId}`);
  return { bo, boId };
}

async function steppedAside(ada, bo, what) {
  await ada.waitFor(cover, `${ada.name}: the "Use here" cover (${what})`, 15000);
  // a moment for anything wrong to happen
  await sleep(1500);
  const seen = await ada.eval(`({ wrong: window.__wrong, mark: window.__mark, retrying: window.__retrying })`);
  check(seen.mark === "same page", `${ada.name}: stepped aside in place, no reload (${what})`, seen);
  check(seen.wrong.length === 0, `${ada.name}: never Bo's account or chat (${what})`, seen.wrong);
  check(!seen.retrying, `${ada.name}: never "retrying" (${what})`);
  check(await bo.eval(inUse), `${bo.name}: still in use, not kicked (${what})`);
}

await journey("accountswitch: a tab showing another account steps aside, nothing done", async (browser) => {
  step("save the car in Ada's tab after the browser became Bo: refused, nothing saved, Bo's tab untouched");
  {
    const ada = await browser.person("BT-AdaA");
    const adaId = await ada.id();
    const { bo, boId } = await boInTab2(ada, "BT-BoA");
    await ada.eval(watch(adaId));
    await ada.eval(`(() => {
      openCarSheet();
      document.getElementById("car-color").value = "Gray";
      document.getElementById("car-make").value = "Honda";
      document.getElementById("car-model").value = "Civic";
      document.getElementById("car-sheet").requestSubmit();
      return true;
    })()`);
    await steppedAside(ada, bo, "car");
    await server(`no_car ${adaId}`);
    await server(`no_car ${boId}`);
    await ada.close();
  }

  step("a reconnect that needs a new pass: refused, the cover — never 'retrying' forever");
  {
    const ada = await browser.person("BT-AdaB");
    const adaId = await ada.id();
    const { bo } = await boInTab2(ada, "BT-BoB");
    await ada.eval(watch(adaId));
    // no pass any more (the next connect is refused and asks for one at once)
    await ada.eval(`(socketToken = null, socketTokenAt = -Infinity, failsSinceOpen = 0, true)`);
    await ada.drop();
    await ada.restore();
    await steppedAside(ada, bo, "new pass");
    await ada.close();
  }

  step("agree to the Terms in Ada's tab (not yet connected): refused, the cover");
  {
    const ada = await browser.visitor("BT-AdaC");
    await ada.goto(`${BASE}/privacy`);
    const ok = await ada.eval(
      `fetch("/api/dev_login", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: "BT-AdaC"})}).then(r => r.ok)`
    );
    check(ok, "Ada's dev sign-in");
    await ada.goto(`${BASE}/`);
    await ada.waitFor(`document.getElementById("screen-terms").classList.contains("active") && !!state.realUser`, "Ada: the Terms", 15000);
    const adaId = await ada.eval("state.realUser.id");
    const { bo } = await boInTab2(ada, "BT-BoC");
    await ada.eval(watch(adaId));
    await ada.click("btn-agree");
    await steppedAside(ada, bo, "Terms");
    await ada.close();
  }

  step("a plain reconnect (Ada's pass still good): its fresh state refused — Bo's chat never drawn as Ada's");
  const ada = await browser.person("BT-AdaD");
  const adaId = await ada.id();
  const { bo, boId } = await boInTab2(ada, "BT-BoD");
  await ada.eval(watch(adaId));
  await ada.drop();
  await ada.restore();
  await steppedAside(ada, bo, "reconnect");

  step("under the cover an update doesn't reload it (it would take the session from Bo's tab)");
  await ada.eval(`(() => {
    serverBuild = "journey-other-build";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    checkForUpdate();
    document.dispatchEvent(new Event("visibilitychange"));
    return true;
  })()`);
  await sleep(2000);
  check((await ada.eval(`window.__mark`)) === "same page", "no update reload under the cover");
  check(await bo.eval(inUse), "Bo's tab still in use");

  step("'Use here' in tab 1: it reloads as Bo (the account really signed in); tab 2 gets the cover");
  await ada.eval(`(delete document.visibilityState, true)`);
  await ada.click("btn-use-here");
  await ada.waitFor(`typeof state === "object" && !!state.realUser && state.realUser.id === ${boId} && liveNow()`, "tab 1 is Bo, connected", 15000);
  await bo.waitFor(cover, "tab 2: the cover (opened elsewhere)", 15000);
});
