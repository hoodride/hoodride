// Using the app keeps you signed in (owner, 2026-11-08: "as long as we use
// the app within 30 days"). A sign-in is valid 30 days; opening the app
// replaces a week-old one, so someone who opens it every few weeks is never
// asked to sign in again — signed out only after 30 days without opening it.
import { journey, step, check, server } from "./cdp.mjs";

const signInShown = `document.getElementById("screen-login").classList.contains("active")`;
const connected = `typeof liveNow === "function" && liveNow() && !!state.realUser`;

await journey("staysignedin: opened every few weeks, never signed out; 30 days unused, signed out", async (browser) => {
  step("Stan signs in");
  const stan = await browser.person("BT-Stan");
  const id = await stan.id();

  step("8 days later he opens the app: still signed in (and his sign-in renewed)");
  await server(`age_sign_ins ${id} 8`);
  await stan.open();
  check(await stan.eval(connected), "connected");

  step("25 days after that — 33 since he signed in — he opens it again: still signed in");
  await server(`age_sign_ins ${id} 25`);
  await stan.open();
  check(await stan.eval(connected), "still connected, 33 days after signing in");
  check(!(await stan.eval(signInShown)), "no sign-in screen");

  step("then 31 days without opening it: the sign-in screen");
  await server(`age_sign_ins ${id} 31`);
  await stan.goto(`${process.env.BASE || "http://localhost:4100"}/`);
  await stan.waitFor(signInShown, "the sign-in screen", 15000);
});
