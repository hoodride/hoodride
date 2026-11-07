// The world-sync scheduler: keeps the server watching exactly the cells the
// app wants. All the rules live here; app.js only wires it to the real
// Phoenix channel, real timers and the map ("Humble Object" — Meszaros,
// xUnit Test Patterns), so test_js/sync.test.mjs can drive it with a fake
// channel, a manual clock and a controlled random source.
//
// LEVEL-TRIGGERED: every sync sends the COMPLETE wanted sets and the server
// reconciles, so any refused, timed-out or lost sync is healed by simply
// sending again — the next one carries the whole truth. (The first version
// sent diffs and tracked what the server held; one refused sync left the
// map blank until reload.) Rules:
//   - a change waits SETTLE_MS for the map to settle (a burst → one sync)
//   - one sync in flight; changes meanwhile mark it dirty and the reply
//     triggers ONE follow-up carrying the latest wish
//   - rate_limited → retry no earlier than the server's retry_ms
//   - timeout / unknown error → jittered exponential backoff, reset on success
//   - PERMANENT refusals (the same wish can never succeed) → not retried
//     until the wish changes or the channel rejoins
//   - (re)join → sync immediately; ~every SAFETY_RESYNC_MS → full resync
//   - replies for cells no longer wanted are ignored
//
// RETRY POLICY sources: AWS "Exponential Backoff And Jitter" (full jitter;
// no-jitter backoff "the clear loser"), Google SRE book ch. 22 ("always use
// randomized exponential backoff", "don't retry permanent errors", don't
// retry at multiple layers — our layers are sequential, not nested: a sync
// only retries while joined, a channel only rejoins while connected).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SETTLE_MS = 250;
  const SAFETY_RESYNC_MS = 60000;
  const PERIODIC_JITTER = 0.2; // ±20% on periodic timers
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_MAX_MS = 30000;
  // retry_ms is the server's exact wait — honoured as a minimum. The slack
  // covers clock skew and transit; the random part spreads clients that
  // were given the same wait (cf. 250–500 ms jitter on Retry-After).
  const RETRY_SLACK_MS = 50;
  const RETRY_JITTER_MS = 250;
  // refusals that will refuse the same wish every time
  const PERMANENT = new Set(["watch_limit", "read_only"]);

  // Full jitter (AWS): a uniformly random wait between 0 and the capped
  // exponential. `attempt` counts from 1, as Phoenix's Timer passes it.
  function jitteredBackoff(attempt, baseMs, capMs, random) {
    return random() * Math.min(capMs, baseMs * 2 ** (attempt - 1));
  }

  // Socket reconnect / channel rejoin, passed to Phoenix as reconnectAfterMs
  // and rejoinAfterMs. Phoenix's defaults are fixed tables with no jitter,
  // so after a deploy every phone would retry in lockstep. Capped at 10 s:
  // that is the wait a person sees after an outage ends.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 10000;
  function reconnectBackoff(attempt, random = Math.random) {
    return jitteredBackoff(attempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS, random);
  }

  // A PLANNED restart: the server said "restarting" with a window {min, max}
  // (ms) before going. The first reconnect lands at a random moment inside
  // it — not the growing backoff, which left phones in 8 s waits after the
  // server was back. Still down then (or no/odd notice): the normal backoff.
  // Capped, so a bad window can't park phones for minutes.
  const RESTART_MAX_MS = 30000;
  function restartWait(attempt, notice, random = Math.random) {
    const ok =
      attempt === 1 &&
      notice &&
      Number.isFinite(notice.min) &&
      Number.isFinite(notice.max) &&
      notice.min >= 0 &&
      notice.max >= notice.min;
    if (!ok) return reconnectBackoff(attempt, random);
    return Math.min(RESTART_MAX_MS, notice.min + random() * (notice.max - notice.min));
  }

  // The live connection as the person sees it: "lost" only once it has been
  // down LOST_AFTER_MS — a reload's hand-over or a one-second blip never
  // flashes "Reconnecting…". Phoenix reports every failed retry (down
  // again and again): one change each way. onChange(lost).
  const LOST_AFTER_MS = 2000;
  function createConnWatch({ onChange, setTimer, clearTimer }) {
    let lost = false;
    let timer = null;
    return {
      down() {
        if (lost || timer) return;
        timer = setTimer(() => {
          timer = null;
          lost = true;
          onChange(true);
        }, LOST_AFTER_MS);
      },
      up() {
        if (timer) clearTimer(timer);
        timer = null;
        if (!lost) return;
        lost = false;
        onChange(false);
      },
      lost: () => lost,
    };
  }

  // a period spread ±fraction, so clients that (re)started together drift apart
  function jittered(ms, fraction, random) {
    return ms * (1 + (random() * 2 - 1) * fraction);
  }

  // deps: {push(event, payload) → {receive(status, cb)}, setTimeout,
  //        clearTimeout, random?,
  //        onDropGeo(cell), onDropAgg(cell),   // the server let a cell go
  //        onSnapshot({geo, agg})}             // only cells still wanted
  //
  // A cell's markers are dropped only when the SERVER has let it go — the
  // ok reply to a sync that left it out — and it isn't wanted again by then.
  // Markers and counts are announced only when they change, so a cell
  // dropped locally while the server still holds it is never resent: a wish
  // that blinked inside one settle window (Drive → straight back) sent no
  // sync at all, and that cell's parked cars stayed invisible for good.
  // Until the server lets go, its updates are live and still accepted.
  function createWorldSync(deps) {
    const random = deps.random || Math.random;
    const wantedGeo = new Set();
    const wantedAgg = new Set();
    // what the server holds for us, as of its last ok reply
    let heldGeo = new Set();
    let heldAgg = new Set();
    let joined = false;
    let inFlight = false;
    let dirty = false;
    let settleTimer = null;
    let retryTimer = null;
    let retryPending = false;
    let failures = 0; // consecutive retriable failures → backoff attempt
    let rejectedWish = null; // key of a wish the server permanently refused

    const same = (want, have) => want.size === have.size && [...want].every((c) => have.has(c));
    const wishKey = () => [...wantedGeo].sort().join(",") + "|" + [...wantedAgg].sort().join(",");

    // Declare what we want. Returns false (and sends nothing) when nothing
    // changed — e.g. every pan mid-ride or at the zoom floor.
    function setWanted(geo, agg) {
      if (same(geo, wantedGeo) && same(agg, wantedAgg)) return false;
      wantedGeo.clear();
      wantedAgg.clear();
      geo.forEach((cell) => wantedGeo.add(cell));
      agg.forEach((cell) => wantedAgg.add(cell));
      deps.clearTimeout(settleTimer);
      settleTimer = deps.setTimeout(flush, SETTLE_MS);
      return true;
    }

    function retryIn(ms) {
      deps.clearTimeout(retryTimer);
      retryPending = true;
      retryTimer = deps.setTimeout(flush, ms);
    }

    function backOff() {
      failures++;
      retryIn(jitteredBackoff(failures, BACKOFF_BASE_MS, BACKOFF_MAX_MS, random));
    }

    function flush() {
      if (!joined) return; // the join will flush
      if (inFlight) {
        dirty = true;
        return;
      }
      // this sync carries the latest wish, so pending timers are redundant
      deps.clearTimeout(retryTimer);
      deps.clearTimeout(settleTimer);
      retryPending = false;
      const key = wishKey();
      if (key === rejectedWish) return; // refused for good; wait for a change
      inFlight = true;
      dirty = false;
      const sentGeo = new Set(wantedGeo);
      const sentAgg = new Set(wantedAgg);

      deps
        .push("sync", { geo: [...sentGeo], agg: [...sentAgg] })
        .receive("ok", (snap) => {
          inFlight = false;
          failures = 0;
          // the server now holds exactly what we sent: anything it let go
          // (and we don't want back meanwhile) is gone for us too
          dropReleased(sentGeo, sentAgg);
          // the view may have moved on while this sync was in flight
          deps.onSnapshot({
            geo: ((snap && snap.geo) || []).filter((s) => wantedGeo.has(s.cell)),
            agg: ((snap && snap.agg) || []).filter((c) => wantedAgg.has(c.cell)),
          });
          if (dirty) flush();
        })
        .receive("error", (e) => {
          inFlight = false;
          const reason = e && e.reason;
          if (reason === "rate_limited" && e.retry_ms) {
            retryIn(e.retry_ms + RETRY_SLACK_MS + random() * RETRY_JITTER_MS);
          } else if (PERMANENT.has(reason)) {
            rejectedWish = key;
            if (dirty) flush(); // the wish already moved on: send that
          } else {
            backOff();
          }
        })
        .receive("timeout", () => {
          inFlight = false;
          backOff();
        });
    }

    // A (re)joined channel holds nothing server-side: send the whole wish
    // now. A rejoin may be a new server version, so a refusal is retried
    // once per connection rather than remembered forever.
    function onJoined() {
      joined = true;
      inFlight = false;
      failures = 0;
      rejectedWish = null;
      // a fresh channel holds nothing: whatever we no longer want is gone
      // (what we still want is resent, with snapshots, by this flush)
      dropReleased(new Set(), new Set());
      flush();
    }

    // the server holds `geo`/`agg` now: drop the cells it released that we
    // don't want (any more), then record what it holds
    function dropReleased(geo, agg) {
      heldGeo.forEach((cell) => {
        if (!geo.has(cell) && !wantedGeo.has(cell)) deps.onDropGeo(cell);
      });
      heldAgg.forEach((cell) => {
        if (!agg.has(cell) && !wantedAgg.has(cell)) deps.onDropAgg(cell);
      });
      heldGeo = geo;
      heldAgg = agg;
    }

    function onLeft() {
      joined = false;
    }

    // ~every 60 s (±20%), but not while a retry is scheduled: a send is
    // already coming, and firing early would undercut its backoff
    function scheduleSafetyResync() {
      deps.setTimeout(() => {
        if (joined && !inFlight && !retryPending) flush();
        scheduleSafetyResync();
      }, jittered(SAFETY_RESYNC_MS, PERIODIC_JITTER, random));
    }
    scheduleSafetyResync();

    // The server said our role changed: it dropped the layer we may no
    // longer see and subscribes the new one only when asked. The wish (the
    // cells) is the same, so setWanted would see no change and send
    // nothing — send it again as it is. In flight → one follow-up.
    function resync() {
      if (joined) flush();
    }

    return {
      setWanted,
      resync,
      onJoined,
      onLeft,
      // live updates are accepted for what we want AND for what the server
      // still sends (its markers stay up until it lets go)
      wantsGeo: (cell) => wantedGeo.has(cell) || heldGeo.has(cell),
      wantsAgg: (cell) => wantedAgg.has(cell) || heldAgg.has(cell),
      wantedGeoSize: () => wantedGeo.size,
      wantedAggSize: () => wantedAgg.size,
      // the server has answered for what we want, and nothing is on its
      // way: the map shows all there is in view (find the nearest — nearby.js
      // — waits for this before it decides "nobody nearby yet")
      settled: () =>
        joined && !inFlight && !dirty && !retryPending && same(wantedGeo, heldGeo) && same(wantedAgg, heldAgg),
    };
  }

  return {
    createWorldSync,
    jitteredBackoff,
    reconnectBackoff,
    restartWait,
    RESTART_MAX_MS,
    createConnWatch,
    LOST_AFTER_MS,
    jittered,
    RECONNECT_MAX_MS,
    SETTLE_MS,
    SAFETY_RESYNC_MS,
    PERIODIC_JITTER,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    RETRY_SLACK_MS,
    RETRY_JITTER_MS,
  };
});
