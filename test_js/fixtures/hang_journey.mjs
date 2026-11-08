// A journey that hangs, as a crashed run's did — for
// journey_orphans.test.mjs (kept out of test_browser/, so it's never run as
// a journey itself). It says which browser it started, then waits forever.
import { journey, browserPids } from "../../test_browser/cdp.mjs";

await journey("hang", async () => {
  console.log("PIDS " + JSON.stringify(browserPids()));
  await new Promise(() => {});
});
