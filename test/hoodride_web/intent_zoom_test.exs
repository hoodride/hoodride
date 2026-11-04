defmodule HoodrideWeb.IntentZoomTest do
  @moduledoc """
  Go online (driver) and Need a ride (rider) put the camera in the SAME
  place: centred on you at one shared zoom (owner, 2026-10-29: the rider's
  view was a quarter of the driver's — a wider view gives a better chance
  of seeing cars nearby). One constant, so the two can't drift apart.
  (app.js is glue the Node tests can't load — this reads the file; the live
  check is in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "one shared zoom, 14 (about 3 km across on a phone)" do
    assert @app =~ ~r/^const INTENT_ZOOM = 14;/m
  end

  test "Go online and Need a ride both centre on you at it" do
    for fun <- ["setOnline", "setHand"] do
      assert body(fun) =~
               "map.easeTo({ center: [state.me.lng, state.me.lat], zoom: INTENT_ZOOM })",
             "#{fun} doesn't use the shared zoom"
    end
  end
end
