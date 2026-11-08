defmodule HoodrideWeb.OwnNewsTest do
  @moduledoc """
  What you do is news for a reload (owner, 2026-11-07): a reload whose
  snapshot was taken just before your action reached the server put things
  back as they were — a ✋ down on your screen while drivers still saw it, a
  message gone from your chat though it was delivered. Everything you send
  on your own channel and your ride's counts, so a reload loading meanwhile
  asks again (HoodRehydrate.freshState) — except the position updates.

  The live checks are test_browser/tapreload.mjs. One part can't fail
  there today: the ride's channel (Accept, the pin, End ride are already
  answered by the server with news of its own — proven with it removed), so
  this reads the file for it — a later ride action the server doesn't
  answer would need it.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  test "both your channels count what you send: your own, and your ride's" do
    assert @app =~ "userChannel = ownNews(socket.channel(`user:${state.realUser.id}`));"
    assert @app =~ "rideChannel = ownNews(socket.channel(`ride:${state.ride.id}`));"
    refute @app =~ ~r/(userChannel|rideChannel) = socket\.channel\(/
  end

  test "everything counts but the position updates (a reload would never settle)" do
    assert @app =~ ~s|const QUIET_PUSHES = new Set(["driver_update", "pos"]);|
    [own] = Regex.run(~r/function ownNews\(channel\) \{.*?\n\}/s, @app)
    assert own =~ "if (!QUIET_PUSHES.has(event)) tapNews();"
  end

  test "going online counts, where it's tapped (its update is a position update)" do
    assert @app =~
             "lastGeoSent = null; // going online always announces immediately\n      tapNews();\n      pushDriverUpdate();"
  end

  test "news is what a reload checks" do
    [tap] = Regex.run(~r/function tapNews\(\) \{.*?\n\}/s, @app)
    assert tap =~ "liveNews++;"
    assert @app =~ "liveCount: () => liveNews,"
  end
end
