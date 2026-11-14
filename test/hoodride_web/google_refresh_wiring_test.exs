defmodule HoodrideWeb.GoogleRefreshWiringTest do
  @moduledoc """
  "Refresh from Google" in the app (owner, 2026-10-29): the decisions are in
  googlerefresh.js (test_js/googlerefresh.test.mjs); this checks app.js
  wires them up — app.js is glue the Node tests can't load, so this reads
  the files. The server side: HoodrideWeb.SignInRefreshTest.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @sw File.read!("priv/static/sw.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "googlerefresh.js loads before app.js, is cached offline, and served" do
    {mod, _} = :binary.match(@html, ~s(src="googlerefresh.js"))
    {app, _} = :binary.match(@html, ~s(src="app.js"))
    assert mod < app
    assert @sw =~ ~s("googlerefresh.js")
    assert "googlerefresh.js" in HoodrideWeb.static_paths()
  end

  # (owner, 2026-10-29) a small "Change" under your name opens a box with
  # everything about your name and photo — the W3C disclosure pattern: a
  # real button with aria-expanded/aria-controls, the box `hidden` when shut
  test "a Change button under your name opens a box (disclosure: aria-expanded, hidden box)" do
    [me] = Regex.run(~r/<div class="drawer-me">.*?<\/div>\s*<\/div>/s, @html)

    assert me =~
             ~s(<button id="settings-change" type="button" class="drawer-change hidden" aria-expanded="false" aria-controls="settings-change-box" data-t>Change</button>)

    {name, _} = :binary.match(me, ~s(id="settings-name"))
    {change, _} = :binary.match(me, ~s(id="settings-change"))
    assert name < change, "under the name"

    assert @html =~ ~r/<div id="settings-change-box" class="drawer-box" hidden>/
  end

  test "in the box, in order: where it comes from, Change on Google ↗, then Refresh from Google" do
    [box] = Regex.run(~r/<div id="settings-change-box".*?<!-- \/settings-change-box -->/s, @html)
    {src, _} = :binary.match(box, ~s(id="settings-source"))
    {link, _} = :binary.match(box, ~s(id="settings-source-link"))
    {refresh, _} = :binary.match(box, ~s(id="settings-refresh-link"))
    assert src < link and link < refresh
    assert box =~ ~s(href="/auth/google?refresh=1" data-t>Refresh from Google</a>)

    # no closing periods — like the drawer's other short notes ("Add it
    # before you drive", "On all your devices"); owner, 2026-10-29
    assert box =~
             ~s(<p id="settings-refresh-later" class="muted hidden" data-t>You can refresh after your ride</p>)

    assert box =~
             ~s(<p class="muted settings-refresh-note" data-t>Google can take a little while</p>)

    assert body("renderSource") =~
             ~s[t("Your name and photo come from {provider}", { provider: p.label });]

    assert body("renderSource") =~
             ~s[link.textContent = t("Change on {provider} ↗", { provider: p.label });]
  end

  test "Change opens and closes the box, and says so; the drawer always opens with it shut" do
    [toggle] =
      Regex.run(~r/\$\("settings-change"\)\.addEventListener\("click".*?\n}\);/s, @app)

    assert toggle =~ ~s[setAttribute("aria-expanded", String(open))]
    assert toggle =~ "box.hidden = !open;"
    assert body("openSettings") =~ "setChangeBox(false);"
  end

  test "Change only for a known sign-in (none in the demo or a dev account)" do
    b = body("renderSource")
    assert b =~ ~s[$("settings-change").classList.toggle("hidden", !p);]
  end

  test "tapping Change on Google marks a refresh due" do
    assert @app =~
             ~r/\$\("settings-source-link"\)\.addEventListener\("click", \(\) => \{\s*HoodGoogleRefresh\.changeTapped\(storageOrNull\(\)\);/
  end

  # the tap itself isn't "back": only leaving (to Google's page) and
  # returning is — else focus right after the tap would refresh at once
  test "tapping Change resets 'away'" do
    [handler] =
      Regex.run(~r/\$\("settings-source-link"\)\.addEventListener\("click".*?\n}\);/s, @app)

    assert handler =~ "awayFromApp = false;"
  end

  # in the box it's always there (opening the box says you came for this) —
  # for Google only; in a ride a note instead (the round trip reloads)
  test "Refresh: in the box for a Google account; in a ride, 'after your ride' instead" do
    b = body("renderSource")
    assert b =~ ~s[const google = !!state.realUser && state.realUser.provider === "google";]
    assert b =~ ~s[$("settings-refresh").classList.toggle("hidden", !google || !!state.ride);]

    assert b =~
             ~s[$("settings-refresh-later").classList.toggle("hidden", !google || !state.ride);]

    refute @app =~ "isOffered"
  end

  test "the automatic refresh: the shared busy rule, 'due' cleared before leaving, silent" do
    b = body("tryGoogleRefresh")
    assert b =~ "HoodGoogleRefresh.shouldRefresh("
    assert b =~ "busy: HoodUpdate.isBusy("
    {take, _} = :binary.match(b, "HoodGoogleRefresh.take(storageOrNull());")
    {go, _} = :binary.match(b, ~s[location.href = "/auth/google?refresh=silent";])
    assert take < go
    assert b =~ "if (DEMO || !state.realUser || googleRefreshing) return;"
  end

  # the update's silent reload and this refresh both wipe the page: one view
  # of what's in progress for both — the car form open counts (U2, owner
  # 2026-11-11: what was typed in it was lost; test_browser/carformupdate.mjs)
  test "both page-wiping paths ask the busy rule with the same view, the car form in it" do
    assert body("tryGoogleRefresh") =~ "busy: HoodUpdate.isBusy(busyView()),"
    assert body("updateDecision") =~ "busy: HoodUpdate.isBusy(busyView()),"
    assert body("checkForUpdate") =~ "const action = updateDecision();"
    assert length(String.split(@app, "HoodUpdate.isBusy(")) - 1 == 2
    assert body("busyView") =~ "form: carSheetOpen(),"
    # the third: the reload on return while location is blocked (locator.js
    # onVisible) waits while app.typing() — the car form open counts
    assert @app =~
             ~s[typing: () => (($("chat-input") && $("chat-input").value) || "").trim() !== "" || carSheetOpen(),]
  end

  test "'back' is the page shown again, focus, a restored page, or opening the app" do
    assert @app =~ ~s[document.addEventListener("visibilitychange", onGoogleRefreshVisibility);]
    assert @app =~ ~s[window.addEventListener("focus", tryGoogleRefresh);]
    assert @app =~ ~s[window.addEventListener("pageshow", tryGoogleRefresh);]
    assert @app =~ ~s[window.addEventListener("blur", () => (awayFromApp = true));]
    # opening the app later counts as back (an iPhone home-screen app may
    # never report the return)
    [signed_in] = Regex.run(~r/onSignedIn: async \(data\) => \{.*?\n  \},/s, @app)
    assert signed_in =~ "awayFromApp = true;"
    assert signed_in =~ "tryGoogleRefresh();"
  end

  test "a finished ride or shift is the next safe moment" do
    assert body("refreshControls") =~ "tryGoogleRefresh();"
  end

  test "the server's answer is shown once, then taken out of the address" do
    assert @app =~ "HoodGoogleRefresh.outcome(location.search)"

    assert @app =~
             "history.replaceState(null, \"\", location.pathname + HoodGoogleRefresh.withoutOutcome(location.search))"
  end

  # the start-up reconnect redrew the banner and wiped the note within ~2 s
  # (Chrome check): a message on screen now keeps it
  test "the reconnect after start-up doesn't wipe a message on screen" do
    b = body("softReload")
    assert b =~ "if (!bannerTimer) setBanner(contextBanner());"
    refute b =~ ~r/\n  setBanner\(contextBanner\(\)\);/
  end

  # Google can leave a bare "#" on its redirect back; browsers carry it over
  # the server's redirect to "/" (owner saw hoodride.app/#, 2026-10-29). At
  # start-up, before anything reads the address: same page, same ?query,
  # no "#" — replaceState, so no reload and no extra Back step
  test "a bare # left by Google's sign-in is tidied from the address at start-up" do
    tidy =
      ~s[if (location.href.endsWith("#")) history.replaceState(null, "", location.pathname + location.search);]

    {at, _} = :binary.match(@app, tidy)
    {demo, _} = :binary.match(@app, ~s[let DEMO = new URLSearchParams(location.search)])
    assert at < demo, "before the address is first read"
  end

  test "tapping the button takes the refresh: the automatic one doesn't run again" do
    assert @app =~
             ~s[$("settings-refresh-link").addEventListener("click", () => HoodGoogleRefresh.take(storageOrNull()));]
  end

  # the button lives in the box now, always: nothing to "offer" any more
  test "a refresh that failed says where the button is" do
    [signed_in] = Regex.run(~r/onSignedIn: async \(data\) => \{.*?\n  \},/s, @app)
    assert signed_in =~ "transientBanner(refreshNote, 6000);"
    refute signed_in =~ "HoodGoogleRefresh.offer("
  end

  test "signing out forgets it" do
    [logout] = Regex.run(~r/\$\("btn-logout"\)\.addEventListener\("click".*?\n}\);\n/s, @app)
    assert logout =~ "HoodGoogleRefresh.forget(storageOrNull());"
  end

  # (2026-11-12, found by the A2 journey refreshother.mjs) every location
  # reading redraws the normal banner (locator.js app.redrawBanner): it
  # wiped a message on screen at once — "That's a different Google account",
  # "Couldn't refresh…" never seen. A message showing (bannerTimer) is left
  # alone; the normal banner comes back when it ends (transientBanner)
  test "a location redraw leaves a message on screen alone" do
    [redraw] = Regex.run(~r/redrawBanner: \(\) => \{\n.*?\n    \},/s, @app)
    {guard, _} = :binary.match(redraw, "if (bannerTimer && !bannerIsLoc) return;")
    {draw, _} = :binary.match(redraw, "setBanner(contextBanner());")
    assert guard < draw

    msg = body("transientBanner")
    assert msg =~ "setBanner(contextBanner());", "the normal banner back when the message ends"
    assert msg =~ "bannerIsLoc = fromLoc;"
  end

  # …except location's OWN message ("location is off", "approximate"): the
  # next reading replaces it, as before — a good reading a second later
  # mustn't leave "location is off" up for 11 s (review, 2026-11-12)
  test "location's own message is marked as such, and a redraw replaces it" do
    assert @app =~ "message: (text) => queueMicrotask(() => transientBanner(text, 12000, true)),"
    [redraw] = Regex.run(~r/redrawBanner: \(\) => \{\n.*?\n    \},/s, @app)
    assert redraw =~ "clearTimeout(bannerTimer);"
    assert redraw =~ "bannerTimer = null;"

    for fun <- ["locTap"],
        do: assert(body(fun) =~ "bannerIsLoc = false;", fun)

    assert length(Regex.scan(~r/transientBanner\([^)]*, true\)/, @app)) == 1,
           "only location's messages are marked"
  end

  # …but a ✋ / GO ONLINE tap is the person acting: the message gives way
  # at once ("Finding your location…" — else a 12 s "Location is off" stood
  # over the retry). Every tap goes through locTap
  test "a ✋ / GO ONLINE tap ends a message on screen first" do
    tap = body("locTap")
    {clear, _} = :binary.match(tap, "bannerTimer = null;")
    {go, _} = :binary.match(tap, "loc.tapHand()")
    assert clear < go
    assert tap =~ "clearTimeout(bannerTimer);"

    assert Regex.scan(~r/\bloc\.tap(Hand|Online)\(\)/, @app) |> length() == 2,
           "only locTap calls the locator's taps"

    assert length(Regex.scan(~r/locTap\("(hand|online)"\)/, @app)) == 4
  end
end
