defmodule HoodrideWeb.CancelAcceptRaceTest do
  @moduledoc """
  A rider's Cancel that lands just AFTER the driver's Accept (leftovers
  review, 2026-11-13): the request is already gone — taken by the Accept,
  the ride starting — but Cancel answered "ok" anyway, and the app said
  "Request cancelled" just before the ride opened, the driver on the way.
  Now the answer says the driver already accepted (the app then lets the
  ride arrive: test_browser/cancelrace.mjs). A Cancel with nothing to
  cancel and no ride is still "ok" (nothing to undo).
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  @cell "882a1072c7fffff"
  @car_spot "892a1072c63ffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "car-r", name: "CarR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "car-d", name: "CarD"})

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

  defp requested(rider, driver) do
    rsock = connect_as(rider)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(connect_as(driver), "user:#{driver.id}", %{})
    push(dchan, "driver_update", %{"spot" => @car_spot})
    # (a replying push: the car is on the map before the rider looks)
    ref = push(dchan, "cancel_request", %{})
    assert_reply ref, :ok
    {:ok, _, world} = subscribe_and_join(rsock, "world", %{})
    ref = push(world, "sync", %{"geo" => [@cell]})
    assert_reply ref, :ok
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok
    {rchan, dchan}
  end

  test "Cancel just after the Accept: 'the driver already accepted', and the ride stands",
       %{rider: rider, driver: driver} do
    {rchan, dchan} = requested(rider, driver)
    ref = push(dchan, "accept_request", %{"rider_id" => rider.id})
    assert_reply ref, :ok

    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :error, %{reason: "accepted"}
    assert is_binary(Hoodride.Rides.ride_id_of_user(rider.id))
  end

  test "Cancel before the Accept: cancelled, as always", %{rider: rider, driver: driver} do
    {rchan, _dchan} = requested(rider, driver)
    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :ok
    assert :ets.lookup(:ride_requests, rider.id) == []
  end

  test "nothing to cancel and no ride: still 'ok'", %{rider: rider} do
    {:ok, _, rchan} = subscribe_and_join(connect_as(rider), "user:#{rider.id}", %{})
    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :ok
  end
end
