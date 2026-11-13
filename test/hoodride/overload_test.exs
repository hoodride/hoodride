defmodule Hoodride.OverloadTest do
  @moduledoc """
  Under overload (the capacity test: 6,000 people on 4 cores, 2,000 joining
  at once), callers of the map writer waited past 5 s — and GenServer.call
  then EXITS the caller: user channels crashed (192 errors), and a ride
  starting then would have failed to start.

  But a timed-out request is NOT lost: it was already sent into the writer's
  queue (OTP gen.erl: send, then wait), and since OTP 24 a late reply never
  reaches the caller (process aliases). So the fix is only: stop waiting
  without crashing — the change still lands, later, in order (one writer per
  user id, a queue runs in arrival order). No retries (a second copy), no
  deadlines (a late "lower ✋" must still happen).

  Plus the database reads in long-lived processes: a ride ALWAYS starts (a
  failed name lookup shows "Neighbor" — before, a failure on the second
  lookup had already told one person "ride started" for a ride that then
  didn't exist), and tapping a person answers "unavailable". Only the
  expected database errors are caught: a real bug still crashes loudly.

  A writer is made "stuck" with :sys.suspend — it queues calls and answers
  none until resumed.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Accounts, AccountDeletion, Geo, Requests, Rides}

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    # short waits in tests: what matters is that a timeout is survived
    Application.put_env(:hoodride, :geo_call_timeout, 100)
    Application.put_env(:hoodride, :ride_geo_timeout, 50)

    on_exit(fn ->
      Application.delete_env(:hoodride, :geo_call_timeout)
      Application.delete_env(:hoodride, :ride_geo_timeout)
      Application.delete_env(:hoodride, :user_lookup)
    end)
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp me(u), do: %{id: u.id, name: u.name, photo: u.photo}

  defp writer(user_id),
    do: GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, user_id}})

  # the writer of user_id answers nothing until `fun` returns, then catches up
  defp stuck(user_ids, fun) do
    pids = user_ids |> Enum.map(&writer/1) |> Enum.uniq()
    Enum.each(pids, &:sys.suspend/1)

    try do
      fun.()
    after
      Enum.each(pids, &:sys.resume/1)
      # let it drain what queued up
      Enum.each(pids, &:sys.get_state/1)
    end
  end

  defp user_channel(u) do
    {:ok, socket} =
      Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
      )

    {:ok, _, chan} = subscribe_and_join(socket, "user:#{u.id}", %{})
    chan
  end

  describe "a stuck map writer" do
    test "the user channel survives; its changes land once the writer resumes" do
      u = user("ov-chan")
      # going online needs a car on file (step 5)
      :ok = Hoodride.TestHelpers.give_car(u.id)
      chan = user_channel(u)
      ref = Process.monitor(chan.channel_pid)

      stuck([u.id], fn ->
        Phoenix.ChannelTest.push(chan, "driver_update", %{"cell" => @cell, "spot" => @spot})
        # each waits 100 ms, then the channel carries on
        Process.sleep(300)
        refute_received {:DOWN, ^ref, _, _, _}
        refute Geo.driver_on_map?(u.id), "not yet: the writer is stuck"
      end)

      assert Geo.driver_on_map?(u.id), "it landed when the writer resumed"
      refute_received {:DOWN, ^ref, _, _, _}
    end

    test "raise then lower ✋ while stuck ends DOWN — in order, no lost change" do
      u = user("ov-hand")
      chan = user_channel(u)

      stuck([u.id], fn ->
        Phoenix.ChannelTest.push(chan, "hand_up", %{"cell" => @cell, "spot" => @spot})
        Process.sleep(150)
        Phoenix.ChannelTest.push(chan, "hand_down", %{})
        Process.sleep(150)
      end)

      assert Geo.hand_of(u.id) == nil
    end

    test "going offline while stuck: the car leaves once the writer resumes" do
      u = user("ov-off")
      Geo.driver_update(me(u), @cell, @spot, [])
      chan = user_channel(u)

      stuck([u.id], fn ->
        Phoenix.ChannelTest.push(chan, "driver_offline", %{})
        Process.sleep(150)
        assert Geo.driver_on_map?(u.id)
      end)

      refute Geo.driver_on_map?(u.id)
    end

    test "a ride accepted while the writers are stuck still STARTS, quickly" do
      driver = user("ov-ride-d")
      rider = user("ov-ride-r")
      Geo.driver_update(me(driver), @cell, @spot, [])
      :ok = Requests.create(me(rider), driver.id)
      # the general wait is LONG here: only the ride's own short limit keeps
      # this quick (4 × 10 s would be 40 s). Far apart on purpose: with 1 s,
      # a CPU-starved machine (4 × 50 ms measured at up to 3.6 s) overlapped
      # the 4 s it is there to catch
      Application.put_env(:hoodride, :geo_call_timeout, 10_000)

      stuck([driver.id, rider.id], fn ->
        {us, result} = :timer.tc(fn -> Requests.accept(me(driver), rider.id) end)
        assert {:ok, ride_id} = result
        assert Rides.ride_id_of_user(rider.id) == ride_id
        # four map calls at the ride's short limit, not 4 × 10 s
        assert us < 20_000_000
      end)

      # the writer's own guard: someone in a ride is never put back on the map
      refute Geo.driver_on_map?(driver.id)
    end

    test "only a TIMEOUT is survived: a writer that's gone still crashes loudly" do
      # a stuck writer: survived
      pid = writer(4_294_967_500)
      :sys.suspend(pid)

      try do
        assert Hoodride.GeoWriter.call(pid, {:hand_down, 4_294_967_500}, 50) == {:error, :timeout}
      after
        :sys.resume(pid)
      end

      # a process that doesn't exist exits :noproc — a real fault, not overload
      gone = spawn(fn -> :ok end)
      ref = Process.monitor(gone)
      assert_receive {:DOWN, ^ref, _, _, _}
      assert {:noproc, _} = catch_exit(Hoodride.GeoWriter.call(gone, {:hand_down, 1}, 100))
    end

    test "the Sweeper finishes its pass" do
      u = user("ov-sweep")
      # a car AND a ✋ at once: the sweep heals it through the writer
      Geo.driver_update(me(u), @cell, @spot, [])
      :ets.insert(:geo_hands, {u.id, @cell, @spot})

      stuck([u.id], fn ->
        assert Hoodride.Sweeper.sweep_now() == :ok
      end)
    end

    test "deleting an account completes" do
      u = user("ov-del")
      Geo.driver_update(me(u), @cell, @spot, [])

      stuck([u.id], fn ->
        assert AccountDeletion.delete(u.id) == :ok
        assert Accounts.get_user(u.id) == nil
      end)

      refute Geo.driver_on_map?(u.id)
    end
  end

  describe "a failing database" do
    defp failing_lookup(fail_after) do
      counter = :counters.new(1, [])

      fn id ->
        :counters.add(counter, 1, 1)

        if :counters.get(counter, 1) > fail_after,
          do: raise(DBConnection.ConnectionError, "connection not available"),
          else: Accounts.get_user(id)
      end
    end

    test "a ride ALWAYS starts and BOTH are told — a failed name lookup shows Neighbor" do
      driver = user("ov-db-d")
      rider = user("ov-db-r")
      Geo.driver_update(me(driver), @cell, @spot, [])
      :ok = Requests.create(me(rider), driver.id)
      HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")
      HoodrideWeb.Endpoint.subscribe("user:#{driver.id}")

      # the FIRST lookup works, the SECOND fails — the case that used to tell
      # one person "ride started" for a ride that then didn't exist
      Application.put_env(:hoodride, :user_lookup, failing_lookup(1))
      assert {:ok, ride_id} = Requests.accept(me(driver), rider.id)

      assert_receive %Phoenix.Socket.Broadcast{event: "ride_started", topic: t1, payload: p1}
      assert_receive %Phoenix.Socket.Broadcast{event: "ride_started", topic: t2, payload: p2}
      assert Enum.sort([t1, t2]) == Enum.sort(["user:#{rider.id}", "user:#{driver.id}"])
      assert p1.ride_id == ride_id and p2.ride_id == ride_id
      assert "Neighbor" in [p1.peer.name, p2.peer.name]
      # each is told about the OTHER one
      told = %{t1 => p1.peer.id, t2 => p2.peer.id}
      assert told["user:#{rider.id}"] == driver.id
      assert told["user:#{driver.id}"] == rider.id
      assert Rides.ride_id_of_user(rider.id) == ride_id
    end

    test "tapping a person: unavailable, and the map channel survives" do
      Application.put_env(:hoodride, :user_lookup, failing_lookup(0))
      assert Accounts.profile(4_294_967_399) == {:error, :unavailable}
    end

    test "SQLite busy is caught the same way" do
      Application.put_env(:hoodride, :user_lookup, fn _ ->
        raise Exqlite.Error, message: "database busy"
      end)

      assert Accounts.profile(4_294_967_400) == {:error, :unavailable}
    end

    test "any OTHER error still crashes — a real bug must stay visible" do
      Application.put_env(:hoodride, :user_lookup, fn _ -> raise ArgumentError, "a bug" end)
      assert_raise ArgumentError, fn -> Accounts.profile(4_294_967_401) end
    end

    test "a person who doesn't exist is nil, not 'unavailable'" do
      assert Accounts.profile(4_294_967_402) == nil
    end
  end

  # "Neighbor" used to stay for the whole ride (only a reload fixed it):
  # the ride now asks again — the pool's own patience, doubling, up to
  # 30 s — and tells the ride channel the real name once it has it
  describe "the real name, once the database answers again" do
    setup do
      repo = Application.get_env(:hoodride, Hoodride.Repo)
      Application.put_env(:hoodride, Hoodride.Repo, Keyword.put(repo, :queue_target, 30))
      on_exit(fn -> Application.put_env(:hoodride, Hoodride.Repo, repo) end)
    end

    # a ride whose start couldn't look `unnamed` up (everyone else works)
    defp ride_with_unnamed(driver, rider, unnamed) do
      Geo.driver_update(me(driver), @cell, @spot, [])
      :ok = Requests.create(me(rider), driver.id)
      down = :atomics.new(1, [])
      :atomics.put(down, 1, 1)

      Application.put_env(:hoodride, :user_lookup, fn id ->
        if id == unnamed and :atomics.get(down, 1) == 1,
          do: raise(DBConnection.ConnectionError, "connection not available"),
          else: Accounts.get_user(id)
      end)

      {:ok, ride_id} = Requests.accept(me(driver), rider.id)
      HoodrideWeb.Endpoint.subscribe("ride:" <> ride_id)
      {ride_id, fn -> :atomics.put(down, 1, 0) end}
    end

    test "the partner's real name follows on the ride channel" do
      driver = user("ov-nm-d")
      rider = user("ov-nm-r")
      {_ride, db_back} = ride_with_unnamed(driver, rider, driver.id)

      # still failing: nothing to tell yet, and it keeps trying
      refute_receive %Phoenix.Socket.Broadcast{event: "peer"}, 100
      db_back.()

      assert_receive %Phoenix.Socket.Broadcast{event: "peer", payload: p}, 2_000
      # the driver's side: with their car, for the rider (none set here)
      assert p == %{id: driver.id, name: "ov-nm-d", photo: nil, car: nil, car_parts: nil}
      # once: nothing more after the name is known
      refute_receive %Phoenix.Socket.Broadcast{event: "peer"}, 300
    end

    test "named at start: never asked again" do
      driver = user("ov-nm-d2")
      rider = user("ov-nm-r2")
      Geo.driver_update(me(driver), @cell, @spot, [])
      :ok = Requests.create(me(rider), driver.id)
      {:ok, ride_id} = Requests.accept(me(driver), rider.id)
      HoodrideWeb.Endpoint.subscribe("ride:" <> ride_id)
      refute_receive %Phoenix.Socket.Broadcast{event: "peer"}, 300
    end

    test "an account gone meanwhile: it stops asking, tells nothing" do
      driver = user("ov-nm-d3")
      rider = user("ov-nm-r3")
      {ride_id, db_back} = ride_with_unnamed(driver, rider, driver.id)
      Hoodride.Repo.delete!(Accounts.get_user(driver.id))
      db_back.()
      refute_receive %Phoenix.Socket.Broadcast{event: "peer"}, 500
      # and it stopped asking (nobody left to name)
      [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
      assert :sys.get_state(pid).unnamed == []
    end

    test "the waits grow from the pool's patience and stop at 30 s" do
      assert Rides.Ride.name_retry_ms(1) == Accounts.retry_wait_ms()
      assert Rides.Ride.name_retry_ms(2) == 2 * Accounts.retry_wait_ms()
      assert Rides.Ride.name_retry_ms(20) == 30_000
    end
  end
end
