// The banner after ✋ tapped several times in a row (owner, 2026-11-17: "Nearby
// drivers can see you need a ride" kept getting a new line). The banner's
// box is fitted to its lines each time its text changes (fitBanner) — the
// same text must come out the same size every time, however often it's
// shown, never a line more.
import { journey, step, check } from "./cdp.mjs";

const settled = (p) =>
  p.waitFor(`!document.getElementById("banner").classList.contains("fitting")`, `${p.name}: the banner fitted`, 5000);
const size = (p) =>
  p.eval(`(() => { const b = document.getElementById("banner"); const r = b.getBoundingClientRect(); return { text: b.textContent, h: Math.round(r.height), w: Math.round(r.width), styleW: b.style.width }; })()`);
const frames = (p, k) => p.eval(`new Promise((ok) => { let i = 0; const f = () => (++i >= ${k} ? ok(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);

await journey("bannerwrap: ✋ tapped again and again — the same banner, the same size every time", async (browser) => {
  step("Ann asks for a ride (✋), lowers it, raises it — five times, a moment apart");
  const ann = await browser.person("BT-WrapAnn");
  // (a phone's width: the line wraps there — on a desktop it fits on one)
  await ann.phone(390, 844);
  await ann.waitFor(`!document.getElementById("btn-hand").classList.contains("hidden")`, "✋ shown");
  // its size the first time, settled
  await ann.click("btn-hand");
  await ann.waitFor(`state.handRaised === true`, "✋ up", 15000);
  await frames(ann, 6);
  await settled(ann);
  const seen = [await size(ann)];
  // then quickly, as a person tapping: down, up — each a few frames apart
  for (let i = 0; i < 4; i++) {
    await ann.click("btn-hand");
    await frames(ann, 2);
    await ann.click("btn-hand");
    await ann.waitFor(`state.handRaised === true`, "✋ up again", 15000);
    await frames(ann, 6);
    await settled(ann);
    seen.push(await size(ann));
  }
  const up = seen.filter((s) => s.text.startsWith("✋ Nearby drivers can see you need a ride") || s.text.includes("Nearby drivers can see you need a ride"));
  check(up.length === 5, "the ✋ banner each time", seen.map((s) => s.text));
  const heights = up.map((s) => s.h);
  check(
    heights.every((h) => h === heights[0]),
    "the same height every time — never a line more",
    up.map((s) => ({ h: s.h, w: s.w, styleW: s.styleW }))
  );
});
