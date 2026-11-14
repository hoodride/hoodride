defmodule Hoodride.RideBusyTest do
  @moduledoc """
  A ride slow to answer is NOT a ride that's gone (server review,
  2026-11-13). A ride's own process used to look up a name it started
  without ("Neighbor") itself — on a struggling database that froze it for
  seconds — and any question it couldn't answer within 5 s read "gone": a
  phone rejoining then (switching networks) was told the ride was over and
  closed it, while the ride went on.

    * the name lookups run outside the ride: it always answers;
    * a ride that's alive but slow answers "busy" — the ride channel's join
      says so (the app retries it: HoodRehydrate.rideJoinLost), and
      /api/state answers 503 (the app retries: HoodBoot), never "no ride".

  A ride is made slow with :sys.suspend (it queues and answers nothing).
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Accounts, Geo, Requests, Rides}

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    Application.put_env(:hoodride, :ride_call_timeout, 200)
    repo = Application.get_env(:hoodride, Hoodride.Repo)
    Application.put_env(:hoodride, Hoodride.Repo, Keyword.put(repo, :queue_target, 30))

    on_exit(fn ->
      Application.delete_env(:hoodride, :ride_call_timeout)
      Application.delete_env(:hoodride, :user_lookup)
      Application.put_env(:hoodride, Hoodride.Repo, repo)
    end)
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp me(u), do: %{id: u.id, name: u.name, photo: u.photo}

  defp ride(driver, rider) do
    Geo.driver_update(me(driver), @cell, @spot, [])
    :ok = Requests.create(me(rider), driver.id)
    {:ok, ride_id} = Requests.accept(me(driver), rider.id)
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
    {ride_id, pid}
  end

  defp ride_socket(u) do
    {:ok, socket} =
      Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
      )

    socket
  end

  # suspended for the length of `fun` (the ride answers nothing meanwhile)
  defp slow(pid, fun) do
    :sys.suspend(pid)

    try do
      fun.()
    after
      :sys.resume(pid)
    end
  end

  test "a slow name lookup never freezes the ride" do
    driver = user("rb-d1")
    rider = user("rb-r1")
    test = self()
    gate = make_ref()

    # the start can't name the driver; the retry's lookup then hangs until
    # released — a database answering slowly
    down = :atomics.new(1, [])

    Application.put_env(:hoodride, :user_lookup, fn id ->
      cond do
        id != driver.id ->
          Accounts.get_user(id)

        :atomics.add_get(down, 1, 1) == 1 ->
          raise DBConnection.ConnectionError, "connection not available"

        true ->
          send(test, {:looking, self()})

          receive do
            ^gate -> Accounts.get_user(id)
          end
      end
    end)

    {ride_id, _pid} = ride(driver, rider)
    HoodrideWeb.Endpoint.subscribe("ride:" <> ride_id)
    assert_receive {:looking, looker}, 2_000

    # the lookup is stuck — the ride still answers, at once
    assert {:ok, %{id: ^ride_id}} = Rides.get(ride_id)
    assert Rides.position(ride_id, rider.id, %{lat: 40.7, lng: -74.0}) == :ok

    {:ok, _, _chan} = subscribe_and_join(ride_socket(rider), "ride:" <> ride_id, %{})

    # and once it answers, the name follows as before
    send(looker, gate)
    assert_receive %Phoenix.Socket.Broadcast{event: "peer", payload: %{name: "rb-d1"}}, 2_000
  end

  test "a lookup that crashes is asked again (the ride carries on)" do
    driver = user("rb-d2")
    rider = user("rb-r2")
    calls = :atomics.new(1, [])

    Application.put_env(:hoodride, :user_lookup, fn id ->
      if id == driver.id do
        case :atomics.add_get(calls, 1, 1) do
          1 -> raise DBConnection.ConnectionError, "connection not available"
          2 -> exit(:boom)
          _ -> Accounts.get_user(id)
        end
      else
        Accounts.get_user(id)
      end
    end)

    {ride_id, pid} = ride(driver, rider)
    HoodrideWeb.Endpoint.subscribe("ride:" <> ride_id)
    assert_receive %Phoenix.Socket.Broadcast{event: "peer", payload: %{name: "rb-d2"}}, 3_000
    assert Process.alive?(pid)
  end

  test "joining a ride that's slow to answer: busy (retried), never gone" do
    driver = user("rb-d3")
    rider = user("rb-r3")
    {ride_id, pid} = ride(driver, rider)
    socket = ride_socket(rider)

    slow(pid, fn ->
      assert {:error, %{reason: "busy"}} = subscribe_and_join(socket, "ride:" <> ride_id, %{})
      assert Rides.get(ride_id) == {:error, :busy}
    end)

    # the ride went on: joining now works
    assert {:ok, _, _} = subscribe_and_join(socket, "ride:" <> ride_id, %{})
  end

  test "/api/state while the ride is slow: 503 (retried), never 'no ride'", %{conn: conn} do
    driver = user("rb-d4")
    rider = user("rb-r4")
    {_ride_id, pid} = ride(driver, rider)
    session = Hoodride.TestHelpers.session_for(rider.id)

    slow(pid, fn ->
      assert json_response(get(init_test_session(conn, session), "/api/state"), 503) ==
               %{"error" => "busy"}
    end)

    assert json_response(get(init_test_session(build_conn(), session), "/api/state"), 200)[
             "ride"
           ]["id"]
  end

  test "a ride that's really gone still reads gone" do
    assert Rides.get("no-such-ride") == {:error, :gone}
    driver = user("rb-d5")
    rider = user("rb-r5")
    {ride_id, pid} = ride(driver, rider)
    ref = Process.monitor(pid)
    Rides.end_ride(ride_id, rider.id)
    assert_receive {:DOWN, ^ref, :process, ^pid, _}

    assert {:error, %{reason: "gone"}} =
             subscribe_and_join(ride_socket(rider), "ride:" <> ride_id, %{})
  end
end
