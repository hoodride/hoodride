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
    :ets.insert(:rides_by_user, {rider.id, {:pending, self(), 0, 0}})

    Sweeper.heal_unlawful_requests()
    assert [_] = :ets.lookup(:ride_requests, rider.id)
  end

  test "the driver's seat for a ride still starting: the riders waiting on them are left alone" do
    rider = user("srh-r2")
    driver = user("srh-d2")
    requested(rider, driver)
    :ets.insert(:rides_by_user, {driver.id, {:pending, self(), 0, 0}})

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

  # ---- the start itself (the second review, 2026-11-18): the seats are
  # claimed FIRST, in the accepting connection's name; the ride's process is
  # then started (the rides' supervisor stuck here: that step held open) ----

  # the accepting driver's connection, as a process: accepts, then waits
  defp accepting(driver, rider) do
    test = self()

    spawn(fn ->
      send(test, {:accept, Requests.accept(me(driver), rider.id)})
      receive do: (:never -> :ok)
    end)
  end

  defp with_supervisor_stuck(fun) do
    sup = Process.whereis(Hoodride.Rides.Supervisor)
    :sys.suspend(sup)

    try do
      fun.()
    after
      :sys.resume(sup)
      _ = :sys.get_state(sup)
    end
  end

  defp wait_until(f, n \\ 400) do
    cond do
      f.() -> :ok
      n == 0 -> flunk("never happened")
      true -> :timer.sleep(5) && wait_until(f, n - 1)
    end
  end

  # (the fourth review) the guard on that clean-up: the rider has asked
  # this driver AGAIN since — the index row is the new request's: kept
  test "a taken request's clean-up never removes a newer request's index row" do
    [rider, driver] = [user("st-g-r"), user("st-g-d")]
    requested(rider, driver)
    assert [_] = :ets.lookup(:requests_by_driver, {driver.id, rider.id})

    Requests.taken(rider.id, driver.id)

    assert [_] = :ets.lookup(:requests_by_driver, {driver.id, rider.id}),
           "the new request's row removed"

    assert [%{rider_id: _}] = Requests.pending_for_driver(driver.id)
  end

  # (what the rider's Cancel looks at — HoodrideWeb.UserChannel
  # "cancel_request": no request, but a seat → "accepted")
  test "while the ride is being set up the seats are already claimed: Cancel would answer 'accepted', never 'cancelled'" do
    [rider, driver] = [user("st-c-r"), user("st-c-d")]
    requested(rider, driver)

    with_supervisor_stuck(fn ->
      conn = accepting(driver, rider)
      on_exit(fn -> Process.exit(conn, :kill) end)
      # the accept took the request and is starting the ride's process
      wait_until(fn -> Requests.open_request_of(rider.id) == nil end)
      # what the rider's Cancel looks at (UserChannel "cancel_request"):
      # no request — but a seat, so it answers "accepted" (the ride opening)
      assert Requests.cancel(rider.id) != :ok

      assert Hoodride.Rides.ride_id_of_user(rider.id) != nil,
             "no seat yet: Cancel would answer 'cancelled' and then the ride would open"
    end)

    assert_receive {:accept, {:ok, ride}}, 5_000
    :ok = Hoodride.Rides.end_ride(ride, rider.id)
  end

  test "the accepting connection gone while the ride is being set up: seats freed, the rider told 'declined' once, no ride" do
    [rider, driver] = [user("st-d-r"), user("st-d-d")]
    requested(rider, driver)
    HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")
    before = DynamicSupervisor.count_children(Hoodride.Rides.Supervisor).active

    with_supervisor_stuck(fn ->
      conn = accepting(driver, rider)
      wait_until(fn -> Hoodride.Rides.ride_id_of_user(driver.id) != nil end)
      # the driver's connection dies right there
      ref = Process.monitor(conn)
      Process.exit(conn, :kill)
      assert_receive {:DOWN, ^ref, :process, ^conn, :killed}
      # the cleanup frees what nothing can finish now
      Sweeper.heal_stranded_starting_seats()
    end)

    # (the ride's process the supervisor then starts sees its starter gone
    # and stops: it frees nothing more and says nothing twice)
    wait_until(fn ->
      DynamicSupervisor.count_children(Hoodride.Rides.Supervisor).active == before
    end)

    assert Hoodride.Rides.ride_id_of_user(rider.id) == nil
    assert Hoodride.Rides.ride_id_of_user(driver.id) == nil
    did = driver.id
    assert_receive %Phoenix.Socket.Broadcast{event: "request_declined", payload: %{by_id: ^did}}
    refute_receive %Phoenix.Socket.Broadcast{event: "request_declined"}, 200
    # its index row too — left, the index repair called it a bug for 5
    # minutes (the third review)
    assert :ets.lookup(:requests_by_driver, {driver.id, rider.id}) == []
  end
end
