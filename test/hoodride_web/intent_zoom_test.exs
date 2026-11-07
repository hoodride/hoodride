defmodule HoodrideWeb.IntentZoomTest do
  @moduledoc """
  Go online (driver) and Need a ride (rider) put the camera in the SAME
  place: centred on you at one shared zoom (owner, 2026-10-29: the rider's
  view was a quarter of the driver's — a wider view gives a better chance
  of seeing cars nearby). One constant, so the two can't drift apart.

  Find the nearest (owner, 2026-11-07): both now also look for the nearest
  person (findNearest — nearby.js): zoomed out just enough to show them,
  never closer than that zoom. The locate button does the same while you're
  online or have ✋ up. (app.js is glue the Node tests can't load — this
  reads the file; the live check: test_browser/findnearest.mjs.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @sw File.read!("priv/static/sw.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "one shared zoom, 14 (about 3 km top to bottom on a phone)" do
    assert @app =~ ~r/^const INTENT_ZOOM = 14;/m
  end

  test "Go online and Need a ride both find the nearest, from where you are" do
    for fun <- ["setOnline", "setHand"] do
      assert body(fun) =~ "findNearest(state.me);", "#{fun} doesn't find the nearest"
      assert body(fun) =~ "stopFindNearest();", "#{fun}: going off doesn't end it"
      refute body(fun) =~ "map.easeTo(", "#{fun} moves the camera itself"
    end
  end

  test "never closer than the shared zoom; never wider than people one by one" do
    f = body("findNearest")
    assert f =~ "maxZoom: INTENT_ZOOM,"
    assert f =~ "rungs: [H3_RES, ...AGG_RESES],"
    assert f =~ "budget: MAX_WATCHED_CELLS,"
  end

  test "the locate button: the nearest too while online or ✋ up, else up close as before" do
    c = body("centreOnYou")
    assert c =~ "if (HoodNearby.lookingFor(state)) findNearest(at);"

    assert c =~
             "else map.easeTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), 15) });"
  end

  test "any move but its own ends it" do
    assert body("initMap") =~ "if (!e.nearSearch) stopFindNearest();"

    assert body("findNearest") =~
             "map.easeTo({ center: [at.lng, at.lat], zoom }, { nearSearch: seq })"
  end

  test "nearby.js loads before app.js, is cached offline, and served" do
    {near, _} = :binary.match(@html, ~s(src="nearby.js"))
    {app, _} = :binary.match(@html, ~s(src="app.js"))
    assert near < app
    assert @sw =~ ~s("nearby.js")
    assert "nearby.js" in HoodrideWeb.static_paths()
  end
end
