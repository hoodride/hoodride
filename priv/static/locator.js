// Your location: when to ask, when GPS runs, what each reading and error
// means. Shared by the browser (HoodLocator) and test_js/locator.test.mjs.
//
// web.dev "User Location": asked only on a tap (◎, GO ONLINE, ✋, Request
// ride, "Share your location") — never on open; a live watch only while
// rules.gpsNeeded says so, cleared otherwise (battery); every error
// handled. Only a GOOD reading (error ≤ one block, rules.readingQuality)
// is trusted for sending; any reading moves your blue dot.
//
// Everything outside is passed in — the browser's geolocation, the
// permission check, the clock, and `app`, the screen side:
//   state()            → { mode, online, ride, handRaised }
//   onReading(pos, { first, centre })   any reading: the blue dot
//   onGood(pos)        a trusted reading: your position, and the sends
//   onTrustLost()      blocked: nothing may be sent from the old reading
//   setOnline(on), setHand(up)          a waiting tap completing
//   message(text)      a message that stays up a while
//   redrawBanner()     the normal banner again
//   refresh()          the buttons
//   showShare(text), hideShare()        the one-tap "Share your location"
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodLocator = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { t } = I18n;
  const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 };

  function create({ geolocation, queryPermission, now, h3, rules, platform, browser = null, standalone, app }) {
    const s = {
      status: "idle", // idle | watching | denied | unavailable
      watchId: null,
      watchStartedAt: 0,
      askedAt: 0,
      best: null, // the latest reading of ANY quality
      quality: null,
      goodAt: 0,
      trusted: false, // a good reading since the last block
      wantsCentre: false,
      permission: "unknown", // the browser's answer so far
      reconciling: false,
      resuming: false, // inside resumeAtLoad: a shift/ride under way at page load
      // "blocked" said for what needs location now (a shift, a ride): once
      // each, not once ever — an earlier ◎ doesn't tell a rider about a ride
      toldBlocked: false,
    };
    // taps waiting for a good reading: they complete by themselves
    const pending = { online: false, hand: false };

    async function permission() {
      try {
        return await queryPermission();
      } catch (_) {
        return "unknown";
      }
    }
    function notePermission() {
      permission().then((p) => (s.permission = p));
    }

    // which tap or situation needs location (for the wording)
    function context() {
      if (pending.online) return "drive";
      if (pending.hand) return "hand";
      const a = app.state();
      if (a.ride) return "ride";
      if (a.mode === "driver" && a.online) return "drive";
      return "locate";
    }

    function message(fields) {
      return rules.locationMessage({ platform, app: browser, standalone, permission: s.permission, ...fields });
    }

    // a good reading from the CURRENT watch: what ride positions and
    // arrival may use (an older one can be minutes old — e.g. from ✋)
    function liveFix() {
      return s.trusted && s.watchId !== null && s.goodAt >= s.watchStartedAt;
    }

    function onFix(fix) {
      const pos = { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy };
      const quality = rules.readingQuality(pos.accuracy, h3);
      const first = !s.best;
      s.best = pos;
      s.quality = quality;
      if (s.status !== "watching") s.status = s.watchId !== null ? "watching" : "idle";
      const centre = s.wantsCentre;
      s.wantsCentre = false;
      // a reading means location is allowed: the Share button has done its job
      app.hideShare();
      app.onReading(pos, { first, centre });
      if (quality === "good") {
        s.trusted = true;
        s.goodAt = now();
        app.onGood(pos);
        completePending();
      }
      app.redrawBanner();
      app.refresh();
    }

    function onError(err, ctx = context()) {
      if (err.code === 1) {
        // blocked: nothing is ever coming. Trust is revoked (nothing is
        // sent: the server drops a silent car within 3 min), waiting taps
        // are cancelled, and the steps to allow it again are shown.
        s.status = "denied";
        s.trusted = false;
        app.onTrustLost();
        stop();
        // no tap can ask again: the "Share your location" button goes (it
        // stayed beside these steps in a ride — owner, 2026-10-30)
        app.hideShare();
        pending.online = pending.hand = false;
        if (needed()) s.toldBlocked = true;
        app.message(message({ status: "denied", context: ctx }));
      } else if (err.code === 2) {
        // location off for the whole device, or no signal at all
        s.status = "unavailable";
        if (pending.online || pending.hand || ctx !== "locate" || s.wantsCentre)
          app.message(message({ status: "unavailable", context: ctx }));
      }
      // 3 (timeout): no reading YET — a watch keeps trying by itself. (A
      // message shown above stays up: no redraw over it.)
      else app.redrawBanner();
      app.refresh();
    }

    function startWatch() {
      if (s.watchId !== null || !geolocation) return;
      s.status = "watching";
      s.watchStartedAt = now();
      s.askedAt = now();
      notePermission();
      s.watchId = geolocation.watchPosition(onFix, (e) => onError(e), WATCH_OPTIONS);
    }

    function stop() {
      if (s.watchId !== null) geolocation.clearWatch(s.watchId);
      s.watchId = null;
      if (s.status === "watching") s.status = "idle";
    }

    // a one-time lookup: ◎, and the check at "Request ride" (asks on the
    // tap, so a ride that starts later — a server message, not a tap —
    // finds location already allowed)
    function locateOnce(ctx, { quiet = false } = {}) {
      if (!geolocation) return;
      if (s.watchId !== null && s.best) return; // the live watch already knows
      s.askedAt = s.askedAt || now();
      geolocation.getCurrentPosition(
        (fix) => {
          onFix(fix);
          if (ctx !== "locate" && s.quality === "approximate")
            app.message(message({ status: "searching", quality: "approximate", context: ctx }));
        },
        (e) => {
          if (!quiet) onError(e, ctx);
          // the ◎ tap's OWN request failed (timed out, location off): the
          // tap is over — a reading coming later (✋ up, going online, a
          // watch) is not its answer, so it isn't centred as one (owner,
          // 2026-11-10). (The live watch timing out meanwhile — every 15 s
          // indoors — is not this tap failing: it keeps waiting.)
          if (ctx === "locate" && (e.code === 2 || e.code === 3)) s.wantsCentre = false;
        },
        { enableHighAccuracy: ctx !== "locate", maximumAge: 60000, timeout: 15000 }
      );
    }

    function needed() {
      const a = app.state();
      return rules.gpsNeeded({ mode: a.mode, online: a.online, ride: a.ride, pending });
    }

    // keep the live watch running exactly while something needs it. NOT a
    // tap, so it never prompts: if location isn't known to be allowed, it
    // offers the one-tap "Share your location" — except for a shift or ride
    // already under way when the page loaded (resumeAtLoad): that starts at
    // once, button too (iPhones forget an "allow" on reload; a browser may
    // still hold its question for a tap)
    async function reconcile() {
      // (a check already under way when resumeAtLoad comes: it takes the
      // resume with it — the flag lasts until a check DECIDES)
      if (s.reconciling) return;
      if (!needed()) {
        s.resuming = false;
        stop();
        app.hideShare();
        s.toldBlocked = false;
        return;
      }
      if (s.watchId !== null) return void (s.resuming = false);
      if (s.status === "denied") {
        s.resuming = false;
        return tellBlocked();
      }
      s.reconciling = true;
      const perm = await permission();
      s.reconciling = false;
      s.permission = perm;
      const resume = s.resuming;
      s.resuming = false;
      if (!needed() || s.watchId !== null) return; // moved on while asking
      if (perm === "granted" || perm === "unknown") startWatch();
      else if (perm === "denied") {
        s.status = "denied";
        tellBlocked();
      } else {
        if (resume) startWatch();
        app.showShare(
          app.state().ride ? t("📍 Share your location so your ride partner can find you") : t("📍 Share your location")
        );
      }
    }

    // blocked already (no tap can prompt again): say so once for what
    // needs location now
    function tellBlocked() {
      // no tap can ask again: the "Share your location" button goes — also
      // when a re-check finds it blocked in Settings (owner, 2026-10-30)
      app.hideShare();
      if (s.toldBlocked) return;
      s.toldBlocked = true;
      app.message(message({ status: "denied", context: context() }));
    }

    function completePending() {
      if (pending.online) {
        pending.online = false;
        app.setOnline(true);
      }
      if (pending.hand) {
        pending.hand = false;
        app.setHand(true);
      }
    }

    // GO ONLINE / ✋: the tap is the intent. With a good live reading it
    // happens now; otherwise location starts and the tap completes on the
    // first good reading. A second tap while waiting cancels; turning OFF
    // never waits.
    function tap(which) {
      const a = app.state();
      const on = which === "online" ? a.online : a.handRaised;
      const set = which === "online" ? app.setOnline : app.setHand;
      if (pending[which]) {
        pending[which] = false;
        app.redrawBanner();
        app.refresh();
        return;
      }
      if (on) return set(false);
      if (liveFix()) return set(true);
      pending[which] = true;
      // the tap retries: "watching" if a watch still runs (location off keeps
      // one going, to catch the signal coming back), else "idle" — found by a
      // mutation sweep: it said "idle" with GPS still on (owner, 2026-11-05)
      if (s.status === "denied" || s.status === "unavailable") s.status = s.watchId !== null ? "watching" : "idle";
      startWatch();
      app.redrawBanner();
      app.refresh();
    }

    return {
      // open: no prompt. A returning user who already allowed it is
      // centred quietly — no prompt can appear for an allowed permission.
      async start() {
        if ((await permission()) === "granted") locateOnce("locate", { quiet: true });
      },
      tapOnline: () => tap("online"),
      tapHand: () => tap("hand"),
      // ◎: → true if it could centre right away (else it centres when the
      // reading arrives)
      tapLocate() {
        const now_ = !!s.best;
        if (!now_) s.wantsCentre = true;
        // the tap retries: "watching" if a watch still runs (location off keeps
        // one going, to catch the signal coming back), else "idle" — found by a
        // mutation sweep: it said "idle" with GPS still on (owner, 2026-11-05)
        if (s.status === "denied" || s.status === "unavailable") s.status = s.watchId !== null ? "watching" : "idle";
        locateOnce("locate");
        return now_;
      },
      // the map moved by YOU (a drag, a pinch) since a ◎ tap still waiting:
      // its reading, when it comes, isn't centred as the tap's answer
      cancelCentre() {
        s.wantsCentre = false;
      },
      // at "Request ride": checks location on the tap, never holds it up
      requestCheck: () => locateOnce("request"),
      // a fresh ask INSIDE the tap: a watch started at page load may sit
      // unanswered where a browser holds its question for a tap
      shareTapped() {
        app.hideShare();
        stop();
        startWatch();
      },
      // the first load of the account's state after a page load: a shift
      // or ride already under way starts GPS at once (see reconcile)
      resumeAtLoad() {
        s.resuming = true;
        return reconcile();
      },
      cancelPending() {
        pending.online = pending.hand = false;
      },
      reconcile,
      // leaving the app while location is blocked: likely off to Settings
      onHidden() {
        s.reloadOnReturn = s.status === "denied";
      },
      // coming back to the app: if location was blocked/off and is
      // allowed now, it just works — a quiet retry, never a prompt.
      // Back from a trip away after "blocked": the browser keeps its "no"
      // for the open page even once Settings allow it (owner's iPhone,
      // 2026-10-29) — reload once, unless a message is half-typed.
      async onVisible() {
        if (s.reloadOnReturn) {
          s.reloadOnReturn = false;
          if (app.reload && !(app.typing && app.typing())) return app.reload();
        }
        if (s.status !== "denied" && s.status !== "unavailable") return;
        if ((await permission()) !== "granted") return;
        s.status = "idle";
        app.refresh();
      },
      // every app tick: keep a waiting tap's banner current (5 s / 15 s)
      tick() {
        if (!pending.online && !pending.hand) return;
        notePermission();
        app.redrawBanner();
      },
      // the banner while a tap waits, or null
      banner() {
        if (!pending.online && !pending.hand) return null;
        const status = s.status === "denied" || s.status === "unavailable" ? s.status : "searching";
        return (
          message({ status, quality: s.quality, waitedMs: now() - s.askedAt, context: pending.online ? "drive" : "hand" }) ||
          t("📍 Finding your location…")
        );
      },
      // on duty without a trusted reading: riders can't see you (and why)
      noFixBanner: (a) => rules.noFixBanner({ ...a, geoStatus: s.status, platform, app: browser, standalone }),
      liveFix,
      stop,
      pending,
      get best() {
        return s.best;
      },
      get status() {
        return s.status;
      },
    };
  }

  return { create, WATCH_OPTIONS };
});
