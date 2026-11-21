// The banner after ✋ tapped several times in a row (owner, 2026-11-17: "Nearby
// drivers can see you need a ride" kept getting a new line). The banner's
// box is fitted to its lines each time its text changes (fitBanner) — the
// same text must come out the same size every time, however often it's
// shown, never a line more.
import { journey, step, check, HOME, BASE } from "./cdp.mjs";
import { goOnline } from "./app.mjs";

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

  // (owner, 2026-11-19: "does it apply also for driver?") the same banner
  // code (setBanner, fitBanner) — the driver's line: "🟢 You're online",
  // and "· nobody nearby yet" added and taken away; a narrow phone, so the
  // long one wraps
  step("Dan, a driver alone on a very narrow screen, online: 'nobody nearby yet' added and taken away five times — each the same size every time");
  // (far from Ann, whose ✋ he would find: alone — "nobody nearby yet")
  const dan = await browser.person("BT-WrapDan", { latitude: HOME.latitude + 0.5, longitude: HOME.longitude + 0.5 });
  // (260 px: on 320 — the narrowest common phone — his long line still
  // fits on one; this narrow it wraps, as with a larger text setting)
  await dan.phone(260, 640);
  await goOnline(dan);
  await dan.waitFor(`state.online && state.haveFix && !nearLooking && !map.isMoving() && nobodyNear`, "Dan online, his search over: nobody near", 30000);
  await frames(dan, 6);
  await settled(dan);
  const longs = [await size(dan)];
  const shorts = [];
  for (let i = 0; i < 5; i++) {
    await dan.eval(`(setNobodyNear(false), true)`);
    await frames(dan, 6);
    await settled(dan);
    shorts.push(await size(dan));
    await dan.eval(`(setNobodyNear(true), true)`);
    await frames(dan, 6);
    await settled(dan);
    longs.push(await size(dan));
  }
  check(longs.every((s) => s.text.includes("You're online") && s.text.includes("nobody nearby yet")), "the long line each time", longs.map((s) => s.text));
  check(shorts.every((s) => s.text.includes("You're online") && !s.text.includes("nobody")), "the short line each time", shorts.map((s) => s.text));
  check(longs[0].h > shorts[0].h, "(on this phone the long line wraps)", { long: longs[0], short: shorts[0] });
  const same = (list) => list.every((s) => s.h === list[0].h && s.w === list[0].w);
  check(same(longs), "'· nobody nearby yet': the same size every time — never a line more", longs.map((s) => ({ h: s.h, w: s.w, styleW: s.styleW })));
  check(same(shorts), "taken away: back to the short line's own size every time", shorts.map((s) => ({ h: s.h, w: s.w, styleW: s.styleW })));

  step("…and offline, online again — five times: the same banner, the same size");
  const again = [];
  for (let i = 0; i < 5; i++) {
    await dan.click("btn-online");
    await dan.waitFor(`!state.online`, "offline");
    await frames(dan, 2);
    await dan.click("btn-online");
    await dan.waitFor(`state.online && !nearLooking && !map.isMoving() && nobodyNear`, "online again, nobody near", 30000);
    await frames(dan, 6);
    await settled(dan);
    again.push(await size(dan));
  }
  check(again.every((s) => s.text === longs[0].text), "the long line each time", again.map((s) => s.text));
  check(again.every((s) => s.h === longs[0].h && s.w === longs[0].w), "the same size as before, every time", again.map((s) => ({ h: s.h, w: s.w })));

  // (owner, 2026-11-20, Brave on an iPhone: "in demo mode, press Need a
  // ride, cancel it, press it again — the banner adds a newline", fast or
  // slow) the demo shows the very same text again (the real app says
  // "Finding your location…" first: a new text, measured afresh): the box
  // kept the width fitted to it the time before, never measured again —
  // and iPhones' engine, laying it out anew at that tight width, wrapped a
  // word more. Shown again, it's measured afresh — every time
  step("the demo on a narrow phone: Need a ride, cancel, again — measured afresh each time, the same size every time");
  const dee = await browser.visitor("BT-WrapDee");
  // (narrow: the line wraps — on a 390 px screen it fits on one, and a
  // one-line box is never narrowed)
  await dee.phone(300, 640);
  await dee.goto(`${BASE}/?demo`);
  await dee.waitFor(`typeof DEMO !== "undefined" && DEMO && !!map && !document.getElementById("btn-hand").classList.contains("hidden")`, "the demo, ✋ shown", 15000);
  // every measuring of the banner, and whether the box was still as fitted
  // before (a width already set: not measured afresh)
  await dee.eval(`(() => {
    const fit = fitBanner;
    window.__fits = [];
    fitBanner = (b, text) => {
      if (!b.classList.contains("hidden") && b.dataset.text === text) window.__fits.push(b.style.width);
      return fit(b, text);
    };
    return true;
  })()`);
  const raise = async (p, gap) => {
    const before = await p.eval(`window.__fits.length`);
    if (gap === null) await p.click("btn-hand");
    else
      // (taps from the page itself, `gap` frames apart: the harness's own
      // clicks come slower than a fast thumb) — up, down, up
      await p.eval(`new Promise((ok) => {
        const btn = document.getElementById("btn-hand");
        const after = (n, f) => (n <= 0 ? f() : requestAnimationFrame(() => after(n - 1, f)));
        btn.click();
        after(${gap}, () => { btn.click(); after(${gap}, () => { btn.click(); ok(true); }); });
      })`);
    await p.waitFor(`state.handRaised === true`, "✋ up");
    await frames(p, 8);
    await settled(p);
    const fits = await p.eval(`window.__fits.slice(${before})`);
    const s = await size(p);
    await p.click("btn-hand");
    await p.waitFor(`state.handRaised === false`, "✋ down");
    await frames(p, 6);
    await settled(p);
    return { ...s, fits };
  };
  const slow = [];
  for (let i = 0; i < 5; i++) slow.push(await raise(dee, null));
  check(slow.every((s) => s.text.includes("Nearby drivers can see you need a ride")), "the ✋ banner each time", slow.map((s) => s.text));
  check(slow[0].h > 30 && slow[0].styleW !== "", "(on this phone it wraps: the box fitted to its lines)", slow[0]);
  check(
    slow.every((s) => s.fits.length > 0 && s.fits[0] === ""),
    "shown again: measured afresh every time — never the width it was fitted to before",
    slow.map((s) => s.fits)
  );
  check(
    slow.every((s) => s.h === slow[0].h && s.w === slow[0].w),
    "the same size every time — never a line more",
    slow.map((s) => ({ h: s.h, w: s.w, styleW: s.styleW }))
  );

  step("…and tapped fast (up, down, up, a frame or two apart): the same, every time");
  const fast = [];
  for (let i = 0; i < 6; i++) fast.push(await raise(dee, i % 3));
  check(
    fast.every((s) => s.fits.length > 0 && s.fits[0] === ""),
    "measured afresh every time",
    fast.map((s) => s.fits)
  );
  check(
    fast.every((s) => s.h === slow[0].h && s.w === slow[0].w),
    "the same size as tapped slowly, every time",
    fast.map((s) => ({ h: s.h, w: s.w, styleW: s.styleW }))
  );
});
