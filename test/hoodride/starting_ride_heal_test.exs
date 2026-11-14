defmodule Hoodride.StartingRideHealTest do
  @moduledoc """
  The cleanup's request repair and a ride still STARTING (crash review,
  2026-11-14). A seat claimed for a ride that's starting (:pending) isn't a
  ride yet — the start can still fail. The repair counted it as one: a pass
  landing in those milliseconds cancelled the person's other request (their
  app went on showing it, waiting) or declined the riders waiting on them,
  and then the start failed. A starting ride's own start-up withdraws what
  needs withdrawing (Rides.start_ride); the repair only acts on real rides.
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Geo, Requests, Sweeper}

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp me(u), do: %{id: u.id, name: u.name, photo: u.photo}

  defp requested(rider, driver) do
    Geo.driver_update(me(driver), @cell, @spot, [])
    :ok = Requests.create(me(rider), driver.id)
  end

  test "the rider's seat for a ride still starting: their request is left alone" do
    rider = user("srh-r1")
    driver = user("srh-d1")
    requested(rider, driver)
    :ets.insert(:rides_by_user, {rider.id, :pending})

    Sweeper.heal_unlawful_requests()
    assert [_] = :ets.lookup(:ride_requests, rider.id)
  end

  test "the driver's seat for a ride still starting: the riders waiting on them are left alone" do
    rider = user("srh-r2")
    driver = user("srh-d2")
    requested(rider, driver)
    :ets.insert(:rides_by_user, {driver.id, :pending})

    Sweeper.heal_unlawful_requests()
    assert [_] = :ets.lookup(:ride_requests, rider.id)
  end

  test "a real ride still clears them, as before" do
    rider = user("srh-r3")
    driver = user("srh-d3")
    requested(rider, driver)
    :ets.insert(:rides_by_user, {rider.id, "r-some-ride"})

    Sweeper.heal_unlawful_requests()
    assert :ets.lookup(:ride_requests, rider.id) == []
  end
end
