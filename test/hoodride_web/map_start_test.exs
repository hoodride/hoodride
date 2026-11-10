defmodule HoodrideWeb.MapStartTest do
  @moduledoc """
  Where the map opens (owner, 2026-10-29 — it always opened on Manhattan):

    1. a location reading at load (already allowed, or a resumed shift)
       centres the map on you at INTENT_ZOOM — unless you moved the map
       first (never yanked away from what you're looking at)
    2. otherwise the area you last used on this device (HoodViewStore —
       the privacy page promised it), cleared on every sign-out
    3. first visit, no location: the placeholder

  The rules are tested in test_js/viewstore.test.mjs; app.js is glue the
  Node tests can't load — this keeps it wired; the live check is in Chrome.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @sw File.read!("priv/static/sw.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "the page loads viewstore.js before app.js, and the offline cache keeps it" do
    {store, _} = :binary.match(@html, ~s(src="viewstore.js"))
    {app, _} = :binary.match(@html, ~s(src="app.js"))
    assert store < app
    assert @sw =~ ~s("viewstore.js")
    assert "viewstore.js" in HoodrideWeb.static_paths()
  end

  test "the map opens on the remembered area (else the placeholder)" do
    init = body("initMap")
    assert init =~ "HoodViewStore.startView("
    assert init =~ "HoodViewStore.read(storageOrNull()"
  end

  test "every map move is remembered (real accounts; not the demo)" do
    assert body("initMap") =~ ~r/map\.on\("moveend".*?rememberView\(\)/s
    assert body("rememberView") =~ "if (DEMO || !state.realUser) return;"
    assert body("rememberView") =~ "HoodViewStore.save("
  end

  test "a move of YOURS before the first reading cancels the centring" do
    assert body("initMap") =~
             ~r/map\.on\("movestart", \(e\) => \{\s*if \(e\.originalEvent\) movedByYou = true;/
  end

  # (the usual view: INTENT_ZOOM — closer in on a screen so big it shows
  # counts there, owner 2026-11-09: usualZoom, near_covers_test.exs)
  test "the first reading centres on you at the usual view, unless you moved the map" do
    # (online or ✋ up: the nearest found too — intent_zoom_test.exs)
    assert @app =~
             "if (first && !centre && !movedByYou) {\n        if (HoodNearby.lookingFor(state)) findNearest(pos);\n        else map.easeTo({ center: [pos.lng, pos.lat], zoom: usualZoom(pos) });"
  end

  test "signing out (here, elsewhere, or deleting the account) forgets it" do
    [logout] = Regex.run(~r/\$\("btn-logout"\)\.addEventListener.*?\n}\);\n/s, @app)
    assert logout =~ "HoodViewStore.forget(storageOrNull(), state.realUser.id)"
    assert body("deleteAccount") =~ "HoodViewStore.forget(storageOrNull(), state.realUser.id)"
    [signed_out] = Regex.run(~r/onSignedOut: async \(\) => \{.*?\n  \},/s, @app)
    assert signed_out =~ "HoodViewStore.forgetAll(storageOrNull())"
  end
end
