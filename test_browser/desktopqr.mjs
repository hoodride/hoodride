// Phones and tablets only (owner, 2026-11-14 — HoodDevice). A desktop gets
// "Hood Ride works on your phone" and a QR code instead of the sign-in, and
// the app never starts there: no state asked, no connection. The privacy
// policy and Terms open on any device (Google's review reads them). A
// phone, and an iPad that says it's a Mac, get the app as always.
import { journey, step, check, BASE, server } from "./cdp.mjs";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// what the page asked the server for, by path
const asked = (p) => p.eval(`performance.getEntriesByType("resource").map((r) => new URL(r.name).pathname)`);
const shown = (p, id) => p.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && e.offsetParent !== null; })()`);

await journey("desktopqr: a desktop gets the QR code, a phone or tablet the app", async (browser) => {
  await server("any_device_off");
  try {
    step("A Windows desktop opens hoodride.app: the QR screen, nothing else starts");
    const dee = await browser.visitor("BT-Desk");
    await dee.asDevice({ userAgent: WINDOWS });
    await dee.goto(`${BASE}/`);
    await dee.waitFor(`document.documentElement.classList.contains("desktop")`, "the desktop screen");
    check(await shown(dee, "desktop-box"), "the QR box shows");
    check(!(await shown(dee, "auth-buttons")), "no sign-in buttons");
    check(await dee.eval(`document.querySelector(".desktop-qr").complete && document.querySelector(".desktop-qr").naturalWidth > 0`), "the QR code drawn");
    check(
      (await dee.eval(`document.querySelector(".desktop-title").textContent`)) === "Hood Ride works on your phone",
      "says so"
    );
    check(await dee.eval(`!!document.querySelector(".brand .about") && document.querySelector(".brand .about").offsetParent !== null`), "what Hood Ride is, still there (Google's home page)");
    // give the app a moment — it would have asked by now
    await new Promise((r) => setTimeout(r, 1500));
    const paths = await asked(dee);
    check(!paths.some((x) => x.startsWith("/api/")), "the app never asked the server anything", paths.filter((x) => x.startsWith("/api")));
    check(await dee.eval(`typeof map === "undefined" || !map`), "no map made");

    step("…the privacy policy and Terms open on it");
    const privacy = await dee.eval(`fetch("/privacy").then((r) => r.status)`);
    const terms = await dee.eval(`fetch("/terms").then((r) => r.status)`);
    check(privacy === 200 && terms === 200, "both open", { privacy, terms });
    check((await dee.eval(`[...document.querySelectorAll(".desktop-links a")].map((a) => a.getAttribute("href"))`)).join() === "/terms,/privacy", "linked from the screen");
    await dee.close();

    step("An iPhone gets the app");
    const pho = await browser.visitor("BT-Pho");
    await pho.asDevice({ userAgent: IPHONE, touchPoints: 5 });
    await pho.goto(`${BASE}/`);
    await pho.waitFor(`!document.getElementById("btn-google").closest(".hidden")`, "the sign-in", 15000);
    check(!(await pho.eval(`document.documentElement.classList.contains("desktop")`)), "not the desktop screen");
    check(!(await shown(pho, "desktop-box")), "no QR box");
    await pho.close();

    step("An iPad that says it's a Mac (iPadOS Safari): its touchscreen — the app");
    const pad = await browser.visitor("BT-Pad");
    await pad.asDevice({ userAgent: IPAD_AS_MAC, touchPoints: 5 });
    await pad.goto(`${BASE}/`);
    await pad.waitFor(`!document.getElementById("btn-google").closest(".hidden")`, "the sign-in", 15000);
    check(!(await shown(pad, "desktop-box")), "no QR box");
    await pad.close();

    step("…and a real Mac (no touchscreen): the QR screen");
    const mac = await browser.visitor("BT-Mac");
    await mac.asDevice({ userAgent: IPAD_AS_MAC });
    await mac.goto(`${BASE}/`);
    await mac.waitFor(`document.documentElement.classList.contains("desktop")`, "the desktop screen");
    await mac.close();
  } finally {
    await server("any_device_on");
  }
});
