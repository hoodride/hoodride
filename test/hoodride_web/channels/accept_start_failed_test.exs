defmodule HoodrideWeb.AcceptStartFailedTest do
  @moduledoc """
  Crash review 2026-11-12, fixed 2026-11-13 (owner: "focus on this now").
  A driver's Accept whose ride couldn't start — its start-up crashed (here:
  the ride's process can't reach the database) — came back as
  `{:start_failed, why}`, and the channel's `to_string(reason)` on that
  tuple crashed the DRIVER's connection: a blip and a reconnect, no word
  of what happened. Now it answers "unavailable" (the app: "couldn't do
  that — try again"), the connection stays, and the request still stands.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  import ExUnit.CaptureLog
  @endpoint HoodrideWeb.Endpoint

  @cell "882a1072c7fffff"
  @car_spot "892a1072c63ffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "asf-r", name: "AsfR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "asf-d", name: "AsfD"})

    :ok = Hoodride.TestHelpers.give_car(driver.id)
    %{rider: rider, driver: driver}
  end

  defp connect_as(user) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    socket
  end

  test "a ride that can't start: Accept answers 'unavailable', the driver stays connected, the request stands",
       %{rider: rider, driver: driver} do
    rsock = connect_as(rider)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(connect_as(driver), "user:#{driver.id}", %{})

    push(dchan, "driver_update", %{"spot" => @car_spot})
    ref = push(dchan, "cancel_request", %{})
    assert_reply ref, :ok

    {:ok, _, world} = subscribe_and_join(rsock, "world", %{})
    ref = push(world, "sync", %{"geo" => [@cell]})
    assert_reply ref, :ok
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok

    # from now on only this test's own process may use the database: the
    # ride's start-up (its name lookups) can't — it crashes
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, :manual)

    capture_log(fn ->
      ref = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_reply ref, :error, %{reason: "unavailable"}, 2_000
    end)

    # still connected: it answers
    ref = push(dchan, "made_up_event", %{})
    assert_reply ref, :error, %{reason: "bad_request"}
    # no ride, no seat held — and the request still stands (Accept again
    # once the server's fine; the database can't be handed back to other
    # processes in this test, so it's read rather than accepted again)
    assert Hoodride.Rides.ride_id_of_user(driver.id) == nil
    assert Hoodride.Rides.ride_id_of_user(rider.id) == nil
    assert [{rid, did, _}] = :ets.lookup(:ride_requests, rider.id)
    assert {rid, did} == {rider.id, driver.id}
  end
end
