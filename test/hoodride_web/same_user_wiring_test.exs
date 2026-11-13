defmodule HoodrideWeb.SameUserWiringTest do
  @moduledoc """
  One account per tab (owner, 2026-11-08) — the app side. app.js is glue the
  Node tests can't load, so this reads the file; the journey
  test_browser/accountswitch.mjs runs it for real, and HoodrideWeb.SameUserTest
  the server's refusal.

    * every /api request goes through apiFetch, which says which account the
      tab shows (`x-hood-user`);
    * the refusal is recognised by its HEADER (logout's own 409s carry a body
      their caller reads), and the tab steps aside IN PLACE under the "Use
      here" cover — no reload — with an answer that never comes;
    * "not_yours" on the user channel does the same (it used to loop on
      "retrying"); the ride channel's own "not_yours" (the ride is over) is
      left alone;
    * while the cover is up nothing reloads or navigates on its own: an update
      reload (checked again just before it reloads), the back-from-Settings
      reload, the Google refresh.
  """
  use ExUnit.Case, async: true

  @static "priv/static"
  @app File.read!("priv/static/app.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "no request to /api leaves the app without apiFetch" do
    for f <- Path.wildcard(Path.join(@static, "*.js")),
        Path.basename(f) not in ["sw.js", "maplibre-gl.js", "phoenix.min.js", "h3-js.umd.js"] do
      # ONE exception, on purpose: the error report (app.js reportError) —
      # it never says who (no account header: "what broke, never who"), and
      # it must work while the app is starting, before there's an account or
      # apiFetch to call; a mismatch must never sign the view out over it
      src = File.read!(f) |> String.replace(~s[fetch("/api/client-error"], "")
      # a bare fetch("/api…"), fetch('/api…') or fetch(`/api…`)
      refute src =~ ~r/(?<![A-Za-z_.])fetch\(\s*["'`]\/api/, "#{f} calls /api without apiFetch"
      refute src =~ ~r/window\.fetch\(\s*["'`]\/api/, "#{f} calls /api without apiFetch"
    end

    assert length(Regex.scan(~r/apiFetch\("\/api\//, @app)) == 11
    # (the one exception, and only once: the error report, with no account)
    assert length(Regex.scan(~r/fetch\("\/api\/client-error"/, @app)) == 1
    refute @app =~ ~r/x-hood-user[^
]*client-error|client-error[^
]*x-hood-user/
  end

  test "apiFetch: the account shown, the header checked (never the body), the cover, no answer" do
    b = body("apiFetch")
    assert b =~ ~s[if (state.realUser) headers.set("x-hood-user", String(state.realUser.id));]
    # looked up at each call (the journeys wrap window.fetch); with a time
    # limit unless the caller brings its own (owner, 2026-11-13:
    # test_browser/hungrequest.mjs)
    assert b =~ "window.fetch(url, { ...opts, headers, signal })"
    assert b =~ "setTimeout(() => stop.abort(), API_TIMEOUT_MS);"
    assert b =~ ~s[res.headers.get("x-hood-other-account") !== "1"]
    refute b =~ ".json()"
    refute b =~ "location.reload"
    assert b =~ "onSessionMoved();"
    assert b =~ "return new Promise(() => {});"
  end

  test "the cover works before a socket exists (the Terms screen)" do
    assert body("onSessionMoved") =~ "if (socket) socket.disconnect();"
  end

  test "not_yours: the user channel steps aside; the ride channel's is left alone" do
    assert @app =~
             ~s[else if (e && e.reason === "not_yours") onSessionMoved();\n      else transientBanner(t("Connection problem — retrying"));]

    assert length(Regex.scan(~r/"not_yours"\) onSessionMoved/, @app)) == 1
  end

  test "under the cover nothing reloads or navigates on its own" do
    assert @app =~ ~s[const steppedAside = () => !!document.getElementById("session-moved");]

    update = body("reloadForUpdate")
    assert update =~ ~r/\A[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(steppedAside\(\)\) return;/
    # and again when the worker update is done, leaving no stamp behind
    assert update =~ "if (!steppedAside()) return location.reload();"
    assert update =~ "HoodSession.takeQuietReload(tabStorage());"
    refute update =~ ".finally(() => location.reload())"

    [settings] = Regex.run(~r/    reload: \(\) => \{.*?\n    \},/s, @app)
    assert settings =~ ~r/\A    reload: \(\) => \{\n      if \(steppedAside\(\)\) return;/

    google = body("tryGoogleRefresh")
    assert google =~ "if (steppedAside()) return;"
    [before_nav, _] = String.split(google, "location.href", parts: 2)
    assert before_nav =~ "if (steppedAside()) return;"
  end
end
