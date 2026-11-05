defmodule HoodrideWeb.ArrivedBannerTest do
  @moduledoc """
  After "I'm here": "You've arrived" for a minute, then "(the car) Ride with X · tap
  End ride when you're done" for both people, X being the other one (owner,
  2026-10-29: Hood Ride has no trip-start step, so "arrived" stayed up the
  whole drive). The rule is HoodRidePos.arrivedPhase (test_js/ridepos);
  app.js is glue the Node tests can't load — this reads the file; the live
  check is in Chrome.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "every way a ride becomes arrived goes through markArrived (one place keeps the time)" do
    # demo button, the broadcast, a missed broadcast on rejoin, the demo's driver
    assert length(Regex.scan(~r/markArrived\(\)/, @app)) >= 5
    assert [_one] = Regex.scan(~r/state\.ride\.status = "arrived"/, @app)
    assert body("markArrived") =~ ~s[state.ride.status = "arrived";]
  end

  test "markArrived keeps the time and redraws the banner once the minute is up" do
    b = body("markArrived")
    assert b =~ "state.ride.arrivedAt = performance.now();"
    assert b =~ "HoodRidePos.ARRIVED_SHOW_MS"
    assert b =~ ~s[if (state.ride && state.ride.status === "arrived") setBanner(contextBanner());]
  end

  test "the banner: arrived for a minute, then the ride with the other person's name" do
    b = body("situationBanner")
    assert b =~ "HoodRidePos.arrivedPhase(since)"
    # (owner: no "tap End ride when you're done" — the button is right there)
    assert b =~
             ~s[return CAR + t("Ride with {name}", { name: peer.name }) + (state.mode === "rider" ? HoodCar.inLine(peer.car) : "");]

    refute b =~ "tap End ride"
  end

  # owner, 2026-10-29: no "!" (no other banner shouts), and the driver gets
  # the rider's name — who to look for at the curb
  test "just arrived: plain, and the driver sees who they're picking up" do
    b = body("situationBanner")
    assert b =~ ~s[CAR + t("{name} has arrived", { name: peer.name }) + HoodCar.inLine(peer.car)]
    assert b =~ ~s[CAR + t("You've arrived · picking up {name}", { name: peer.name })]
    refute b =~ "has arrived!"
    # unknown arrival time (reloaded mid-ride) → riding
    assert b =~ "state.ride.arrivedAt == null ? null"
  end
end
