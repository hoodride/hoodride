defmodule HoodrideWeb.RideGuardsWiringTest do
  @moduledoc """
  Two guards with no path a person can take today (leftovers review,
  2026-11-13) — kept so a future change can't open one. app.js is glue the
  Node tests can't load, so this reads the file.

    * a "declined" is about ONE driver's request (`by_id`): it clears the
      waiting request only if that's the one waiting — a late one for an
      older request never wipes a newer;
    * joining a ride's channel leaves any channel still open first: two
      open, the old one's "ended" or its join error could clean up the NEW
      ride.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "a decline clears only the request it's about" do
    [handler] = Regex.run(~r/userChannel\.on\("request_declined", .*?\n  \}\);/s, @app)
    assert handler =~ "by_id"
    assert handler =~ "state.ride.peer.id !== by_id"
  end

  # (review 2026-11-14) Settings asks for your car whenever it redraws while
  # it's unknown — every message, every status change: offline, a stream of
  # overlapping requests. One at a time now: a second ask joins the first
  test "your car is asked for once at a time, however often Settings redraws" do
    b = body("loadMyCar")
    assert b =~ "if (carLoading) return carLoading;"
    assert b =~ "carLoading = null"
  end

  test "joining a ride's channel leaves the one still open first" do
    b = body("joinRideChannel")
    [before_join, _] = String.split(b, "socket.channel(`ride:", parts: 2)
    assert before_join =~ "if (rideChannel) rideChannel.leave();"
  end
end
