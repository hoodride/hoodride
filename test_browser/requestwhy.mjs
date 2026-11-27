// A request open to one driver, another driver's chat (owner, 2026-11-22):
// there used to be NO Request button there, and nothing said why. Now it's
// greyed — "You already requested a ride from {name}" — and can't be
// tapped; the request's own chat still says "Requested…"; once the request
// ends, the other chat's "Request ride" is back. On a narrow phone the
// sentence fits inside the chat's header, the name kept. Under it,
// "Cancel request to {name}" cancels that request from here (owner,
// 2026-11-24: Cancel request in the bottom buttons is behind the chat). A reload keeps
// it; blocking the driver you asked ends the request in your app too (the
// server withdrew it but told only the driver: review, 2026-11-24).
import { journey, step, check, HOME } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

const BUTTON = `(() => {
  const b = document.getElementById("btn-ride-action"), h = document.querySelector("#chat .chat-header");
  const br = b.getBoundingClientRect(), hr = h.getBoundingClientRect(), nr = document.getElementById("chat-name").getBoundingClientRect();
  return {
    shown: !b.classList.contains("hidden") && getComputedStyle(b).display !== "none",
    text: b.textContent, disabled: b.disabled, why: b.classList.contains("btn-why"),
    opacity: getComputedStyle(b).opacity, color: getComputedStyle(b).color,
    inside: br.left >= hr.left - 0.5 && br.right <= hr.right + 0.5,
    overflows: b.scrollWidth > b.clientWidth + 1,
    nameWidth: Math.round(nr.width),
    // "Cancel request to {name}" under it
    link: (() => {
      const l = document.getElementById("chat-cancel-other"), lr = l.getBoundingClientRect();
      return {
        shown: !l.classList.contains("hidden") && getComputedStyle(l).display !== "none", text: l.textContent,
        under: lr.top >= br.bottom - 0.5, inside: lr.left >= hr.left - 0.5 && lr.right <= hr.right + 0.5 && lr.bottom <= hr.bottom + 0.5,
      };
    })(),
  };
})()`;

await journey("requestwhy: a request open to one driver — another driver's chat says why there's no Request (greyed), and it's back once the request ends", async (browser) => {
  step("Rita (rider, a narrow phone), Dan and Eve (drivers, online)");
  const rita = await browser.person("BT-WhyRita");
  const dan = await browser.person("BT-WhyDan", { latitude: HOME.latitude + 0.004, longitude: HOME.longitude });
  const eve = await browser.person("BT-WhyEve", { latitude: HOME.latitude - 0.004, longitude: HOME.longitude });
  await goOnline(dan);
  await goOnline(eve);
  const [danId, eveId] = [await dan.id(), await eve.id()];
  await rita.phone(320, 640);
  await sees(rita, danId, "(Dan's car)");
  await sees(rita, eveId, "(Eve's car)");

  step("Rita asks Dan: his chat says Requested…");
  await openChatWith(rita, danId);
  await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, "Request ride in Dan's chat");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested"`, "requested");
  const inDans = await rita.eval(BUTTON);
  check(inDans.shown && inDans.text === "Requested…" && inDans.disabled && !inDans.why && !inDans.link.shown, "Dan's chat: Requested… (not the greyed sentence, no cancel link)", inDans);
  const danName = await rita.eval(`state.ride.peer.name`);
  await rita.eval(`closeChat(), true`);

  step("Eve's chat: the greyed sentence with Dan's name — can't be tapped, fits the header, the name kept");
  await openChatWith(rita, eveId);
  const greyed = async (name, what) => {
    const want = `You already requested a ride from ${name}`;
    await rita.waitFor(`document.getElementById("btn-ride-action").textContent === ${JSON.stringify(want)}`, `the greyed sentence ${what}`);
    const b = await rita.eval(BUTTON);
    // (disabled: a tap is never even delivered — HTML's disabled buttons)
    check(b.shown && b.disabled && b.why, `${what}: shown, greyed, can't be tapped`, b);
    check(b.opacity === "1" && b.color === "rgb(154, 154, 154)", `${what}: readable — not half-faded, the muted grey`, b);
    check(b.inside && !b.overflows, `${what}: inside the header, nothing cut off (320 px wide)`, b);
    check(b.nameWidth >= 100, `${what}: the chat's name still has its room`, b);
    check(b.link.shown && b.link.text === `Cancel request to ${name}` && b.link.under && b.link.inside, `${what}: "Cancel request to ${name}" under it, inside the header`, b.link);
  };
  await greyed(danName, "in Eve's chat");

  step("a reload with the request still open: Eve's chat says it again");
  await rita.eval(`closeChat(), true`);
  await rita.eval(`softReload(), true`);
  await rita.waitFor(`hydrated && !reloading && state.ride && state.ride.status === "requested" && state.ride.peer.id === ${danId}`, "the request back after the reload");
  await openChatWith(rita, eveId);
  await greyed(danName, "after the reload");

  step("Rita cancels Dan's request from Eve's chat (the link): Request ride for Eve, right there");
  const tappable = async (what) => {
    await rita.waitFor(`document.getElementById("btn-ride-action").textContent === "Request ride"`, `Request ride back ${what}`);
    const b = await rita.eval(BUTTON);
    check(b.shown && !b.disabled && !b.why && !b.link.shown, `${what}: Request ride shown, tappable, not greyed, no cancel link`, b);
  };
  await rita.click("chat-cancel-other");
  await rita.waitFor(`!state.ride`, "the request cancelled");
  check(await rita.eval(`state.chatPeer && state.chatPeer.id === ${eveId} && !document.getElementById("chat").classList.contains("hidden")`), "still in Eve's chat");
  await tappable("in Eve's chat");

  step("Rita asks Eve, then blocks her: Dan's chat offers Request ride (the block withdrew the request)");
  await rita.click("btn-ride-action");
  await rita.waitFor(`state.ride && state.ride.status === "requested" && state.ride.peer.id === ${eveId}`, "requested from Eve");
  const eveName = await rita.eval(`state.ride.peer.name`);
  const ritaId = await rita.id();
  await eve.waitFor(`realPeersById.has(${ritaId}) && realPeersById.get(${ritaId}).pending === true`, "Eve has Rita's request");
  await rita.eval(`closeChat(), true`);
  await openChatWith(rita, danId);
  await greyed(eveName, "in Dan's chat");
  await rita.eval(`closeChat(), true`);
  await openChatWith(rita, eveId);
  await rita.waitFor(`!document.getElementById("chat-block").classList.contains("hidden")`, "Block in Eve's chat");
  // (Eve's app hears the withdrawal itself — not just forgets Rita)
  await eve.eval(`(window.__withdrawn = 0, userChannel.on("request_cancelled", ({ from_id }) => from_id === ${ritaId} && window.__withdrawn++), true)`);
  await rita.eval(`(window.__told = [], userChannel.on("request_withdrawn", (m) => window.__told.push(m.driver_id)), true)`);
  await rita.click("chat-block");
  await rita.waitFor(`!document.getElementById("block-sheet").classList.contains("hidden")`, "asked first");
  await rita.click("block-yes");
  await rita.waitFor(`!state.ride`, "Rita's request gone with the block");
  // (and on the server: Eve's screen drops it — request_cancelled)
  await eve.waitFor(`window.__withdrawn === 1`, "Eve: Rita's request withdrawn (request_cancelled)");
  // (her app told by the server too — a late block answer can't leave it)
  check(JSON.stringify(await rita.eval(`window.__told`)) === JSON.stringify([eveId]), "Rita's app told: request_withdrawn (Eve)", await rita.eval(`window.__told`));
  // (the banner under the "Blocked." note: no longer waiting)
  check(!(await rita.eval(`String(contextBanner()).includes("Waiting for the driver")`)), "Rita's banner no longer waiting", await rita.eval(`String(contextBanner())`));
  await openChatWith(rita, danId);
  await tappable("in Dan's chat, after the block");
  check(rita.errors.length === 0, "no page errors", rita.errors);
});
