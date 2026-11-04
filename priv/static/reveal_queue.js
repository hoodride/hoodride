// The pile list's names: who is behind each 🚗 / ✋ row. Shared by the
// browser (HoodRevealQueue) and test_js/reveal_queue.test.mjs.
//
// Standard practice for a list that fetches per-row data under a rate limit:
//   - fetch only the rows on screen (lazy loading: IntersectionObserver)
//   - coalesce the lookups of one moment into ONE request (the DataLoader
//     pattern: collect the ids asked for in this tick, send them together)
//   - when the server says "not yet", wait exactly the time it gives — one
//     queue, one timer, never every row retrying on its own clock
// Before this, every row asked for itself, the rows over the budget all
// retried together on a flat 2 s timer, most were refused again, and a
// crowded pile filled in two names at a time.
//
// The server still charges one allowance PER NAME (a batch must not make
// scraping names cheaper); a batch saves messages and gives one answer:
// {users, unavailable, later, retry_ms}.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodRevealQueue = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the most ids in one request — the server's sync burst (WorldChannel
  // @sync_burst; test/hoodride_web/channels/reveal_batch_test.exs checks they match)
  const MAX = 20;

  // send(ids, reply): ask the server; reply(answer) with the server's
  //   {users, unavailable, later, retry_ms}, or reply(null) on no answer
  // wanted(id): still on screen and still nameless?
  // onUser(user) / onGone(id): one result each; onChange(): after an answer
  function create({ send, wanted, onUser, onGone, onChange, defer, setTimer }) {
    defer = defer || ((f) => Promise.resolve().then(f));
    setTimer = setTimer || ((f, ms) => setTimeout(f, ms));
    let pending = new Set(); // asked for, not sent yet (in order)
    const inFlight = new Set();
    let scheduled = false;
    let waiting = false; // the server said "not yet": its timer is running

    function want(id) {
      if (inFlight.has(id) || pending.has(id)) return;
      pending.add(id);
      schedule();
    }

    // scrolled away (or the list closed): don't spend a name on it
    function drop(id) {
      pending.delete(id);
    }

    function schedule() {
      if (scheduled || waiting || inFlight.size) return;
      scheduled = true;
      defer(flush); // everything asked for in this moment goes together
    }

    // only ever run by schedule(): never while a request or a wait is on
    function flush() {
      scheduled = false;
      for (const id of pending) if (!wanted(id)) pending.delete(id);
      const ids = [...pending].slice(0, MAX);
      if (!ids.length) return;
      ids.forEach((id) => {
        pending.delete(id);
        inFlight.add(id);
      });
      send(ids, (answer) => settle(ids, answer));
    }

    function settle(ids, answer) {
      ids.forEach((id) => inFlight.delete(id));
      if (!answer) {
        // no answer (offline, or the server is down): no retry loop — the
        // next look at the list (a re-render, a scroll, a reconnect) asks
        // again. Nothing changed, so no redraw: a redraw IS such a look (it
        // re-observes the rows), and offline that would ask, fail, redraw…
        return;
      }
      (answer.users || []).forEach(onUser);
      (answer.unavailable || []).forEach(onGone);
      const later = answer.later || [];
      if (later.length) {
        // first in line next time, after exactly the wait the server gave
        pending = new Set([...later, ...pending]);
        waiting = true;
        setTimer(() => {
          waiting = false;
          schedule();
        }, Math.max(answer.retry_ms || 0, 1));
      } else if (pending.size) {
        schedule();
      }
      onChange();
    }

    return { want, drop };
  }

  return { MAX, create };
});
