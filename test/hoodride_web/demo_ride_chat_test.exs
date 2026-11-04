defmodule HoodrideWeb.DemoRideChatTest do
  @moduledoc """
  The demo shows how Hood Ride works, so a ride starting there does what it
  does in the real app (startRealRide): the chat closes and both go to the
  MAP — the chat one tap away, the partner's messages as a banner (owner,
  2026-10-29: in the demo the chat stayed open). (app.js is glue the Node
  tests can't load — this reads the file; the live check is in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  test "the real app closes the chat when a ride starts" do
    [real] = Regex.run(~r/function startRealRide\(.*?\n}\n/s, @app)
    assert real =~ "closeChat();"
  end

  test "demo, as a rider: when the pretend driver accepts, the chat closes" do
    [rider] = Regex.run(~r/state\.ride\.status = "connected";.*?\}, 1800\);/s, @app)
    assert rider =~ "closeChat();"
  end

  test "demo, as a driver: when you accept, the chat closes" do
    [driver] = Regex.run(~r/state\.ride = \{ peer, status: "connected" \};.*?\n  \}\n/s, @app)
    assert driver =~ "closeChat();"
  end
end
