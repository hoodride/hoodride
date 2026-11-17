// The chat over the keyboard (owner, 2026-11-17: on an iPhone the chat was
// squished with the keyboard up). Typing with the keyboard up, the chat
// fills what's visible above it (the visual viewport); not typing, it's back
// to half the screen. Chrome can't open a phone's keyboard here, so the page
// is handed what an iPhone reports with it up: a visual viewport shorter
// than the page — then also scrolled down by Safari to the text box.
import { journey, step, check } from "./cdp.mjs";
import { goOnline, sees, openChatWith } from "./app.mjs";

const W = 390, H = 844, KB = 336; // an iPhone 14's screen and keyboard
const rect = (p) =>
  p.eval(`(() => { const r = document.getElementById("chat").getBoundingClientRect(); const m = document.getElementById("chat-messages").getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom), msgs: Math.round(m.height), kb: document.getElementById("chat").classList.contains("kb") }; })()`);
// the keyboard "up": a visual viewport `h` tall, its top `top` px down the page
const keyboard = (p, h, top = 0) =>
  p.eval(`(() => {
    const fake = Object.assign(new EventTarget(), { width: ${W}, height: ${h}, offsetTop: ${top}, offsetLeft: 0, pageTop: ${top}, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    fitChatToKeyboard();
    return true;
  })()`);

await journey("chatkeyboard: typing with the keyboard up, the chat fills what's visible above it; not typing, half the screen again", async (browser) => {
  step("Rita (a phone) opens a chat with Dan's car: half the screen");
  const dan = await browser.person("BT-KbDan");
  const rita = await browser.person("BT-KbRita");
  await rita.phone(W, H);
  const danId = await dan.id();
  await goOnline(dan);
  await sees(rita, danId);
  await openChatWith(rita, danId);
  const before = await rect(rita);
  check(!before.kb && before.bottom === H && before.h <= 420, "half the screen, at the bottom", before);

  step("she taps the text box, the keyboard comes up: the chat fills what's visible above it");
  await rita.eval(`document.getElementById("chat-input").focus(), true`);
  await keyboard(rita, H - KB);
  const up = await rect(rita);
  check(up.kb && up.top === 8 && up.bottom === H - KB, "from just under the top to the keyboard", up);
  check(up.msgs > 200, "the messages keep real room — not squished", up);

  step("Safari scrolls the page 120 px to the text box: the chat follows into view");
  await keyboard(rita, H - KB, 120);
  check((await rita.eval(`document.getElementById("chat").style.top`)) === "128px", "placed by the visible area's place in the page");

  step("a short shrink (a toolbar, not a keyboard): left as it is");
  await keyboard(rita, H - 50);
  check(!(await rect(rita)).kb, "not taken for a keyboard");

  step("the keyboard up again, then she taps away: half the screen again — a leftover keyboard area ignored");
  await keyboard(rita, H - KB, 24);
  check((await rect(rita)).kb, "fitted");
  await rita.eval(`document.getElementById("chat-input").blur(), true`);
  await rita.waitFor(`!document.getElementById("chat").classList.contains("kb")`, "back");
  const after = await rect(rita);
  check(after.bottom === H && after.h === before.h && after.top === before.top, "exactly as before", { before, after });
});
