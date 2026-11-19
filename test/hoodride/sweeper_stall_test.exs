defmodule Hoodride.SweeperStallTest do
  @moduledoc """
  The cleanup pass never stalls on backed-up map writers (server review,
  2026-11-13). It took stale cars and ✋ off the map one by one, waiting up
  to 5 s for each: with the writers backed up, 100 stale cars held the pass
  ~8 minutes — and every step after it (sign-ins, chats, rate rows, the
  recount) waited too.

  Now it waits at most a second; once a writer has kept it waiting, the
  rest of the pass doesn't wait at all. Nothing is lost: each change is
  already in its writer's queue and lands, in order, when it catches up
  (Hoodride.GeoWriter.exec).

  The writers are made "stuck" with :sys.suspend; the waits are the real
  ones (no :geo_call_timeout override).
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Geo}

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp writers do
    for {_, pid, _, _} <- PartitionSupervisor.which_children(Hoodride.GeoWriters),
        is_pid(pid),
        do: pid
  end

  defp stale_car(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, @spot, [])
    # silent for an hour
    [row] = :ets.lookup(:geo_drivers, u.id)
    :ets.insert(:geo_drivers, put_elem(row, 3, System.monotonic_time(:second) - 3600))
    u.id
  end

  test "stale cars with every writer stuck: the pass ends within seconds; the cars still go" do
    ids = for i <- 1..30, do: stale_car("ss-#{i}")
    ws = writers()
    Enum.each(ws, &:sys.suspend/1)

    sweep = Task.async(fn -> Hoodride.Sweeper.sweep_now() end)

    try do
      # (before: ~5 s per car — 30 cars, 2½ minutes)
      assert Task.yield(sweep, 4_000) == {:ok, :ok}, "the pass stalled on the writers"
    after
      Task.shutdown(sweep, :brutal_kill)
      Enum.each(ws, &:sys.resume/1)
      Enum.each(ws, &:sys.get_state/1)
    end

    # what it asked for landed once the writers caught up
    for id <- ids, do: refute(Geo.driver_on_map?(id))
  end

  # (2026-11-18, the sweeper review) the pass judged them gone, and its
  # removal waited in the writer's queue — meanwhile they came BACK (their
  # app rejoined and read its ✋ / car from /api/state). The queued removal
  # used to run anyway: a ✋ the rider's app showed raised, gone from every
  # driver's map, nothing ever telling them (a ✋ is sent once — unlike a
  # car's 20 s heartbeat). It now asks "still gone?" when it runs
  test "a ✋ and a car queued for removal: their owners came back meanwhile — both kept" do
    {:ok, r} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-back-r", name: "R"})
    {:ok, d} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-back-d", name: "D"})
    :ok = Geo.hand_up(r.id, @cell, @spot, [])
    :ok = Geo.driver_update(%{id: d.id, name: d.name, photo: nil}, @cell, @spot, [])
    # both gone past the 5-minute grace
    for u <- [r, d],
        do: :ets.insert(:geo_presence, {u.id, :grace, System.monotonic_time(:second) - 3600})

    ws = writers()
    Enum.each(ws, &:sys.suspend/1)
    sweep = Task.async(fn -> Hoodride.Sweeper.sweep_now() end)

    try do
      assert Task.yield(sweep, 4_000) == {:ok, :ok}
      # …they come back while the removals wait in the queue
      me = self()

      back =
        for u <- [r, d] do
          spawn(fn ->
            Registry.register(Hoodride.UserChannels, u.id, nil)
            Geo.user_connected(u.id)
            send(me, {:back, u.id})
            Process.sleep(:infinity)
          end)
        end

      for u <- [r, d], do: assert_receive({:back, id} when id == u.id)
      on_exit(fn -> Enum.each(back, &Process.exit(&1, :kill)) end)
    after
      Task.shutdown(sweep, :brutal_kill)
      Enum.each(ws, &:sys.resume/1)
      Enum.each(ws, &:sys.get_state/1)
    end

    assert [{_, _, _}] = :ets.lookup(:geo_hands, r.id), "the returning rider's ✋ was removed"
    assert Geo.driver_on_map?(d.id), "the returning driver's car was removed"
  end

  # ---- (independent review, 2026-11-18) every other removal the pass
  # queues asks its reason again when it runs, too: the person's own newer
  # change can be queued AHEAD of it ----

  defp queued(ws),
    do: ws |> Enum.map(&elem(Process.info(&1, :message_queue_len), 1)) |> Enum.sum()

  # `fun` started, and waiting in a (stuck) writer's queue before returning
  defp queue_first(ws, fun) do
    before = queued(ws)
    task = Task.async(fun)
    wait_until(fn -> queued(ws) > before end)
    task
  end

  defp wait_until(f, n \\ 200) do
    cond do
      f.() -> :ok
      n == 0 -> flunk("never queued")
      true -> :timer.sleep(5) && wait_until(f, n - 1)
    end
  end

  # the writers stuck: `ahead` queued, then the pass, then `meanwhile`
  # done while its removals wait; then the writers catch up
  defp stuck_pass(ahead, meanwhile \\ fn -> :ok end) do
    ws = writers()
    Enum.each(ws, &:sys.suspend/1)

    try do
      tasks = Enum.map(ahead, &queue_first(ws, &1))
      sweep = Task.async(fn -> Hoodride.Sweeper.sweep_now() end)
      assert Task.yield(sweep, 4_000) == {:ok, :ok}
      meanwhile.()
      tasks
    after
      Enum.each(ws, &:sys.resume/1)
      Enum.each(ws, &:sys.get_state/1)
    end
    |> Enum.each(&Task.await/1)
  end

  test "a 'frozen' car whose fresh position was queued first: kept, its waiting rider not declined" do
    {:ok, d} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-frz", name: "F"})
    me = %{id: d.id, name: d.name, photo: nil}
    :ok = Geo.driver_update(me, @cell, @spot, [])
    {:ok, _} = Registry.register(Hoodride.UserChannels, d.id, nil)
    Geo.user_connected(d.id)
    :ok = Hoodride.Requests.create(%{id: 9_701, name: "W", photo: nil}, d.id)
    HoodrideWeb.Endpoint.subscribe("user:9701")
    # silent 3+ minutes by the pass's look
    [row] = :ets.lookup(:geo_drivers, d.id)
    :ets.insert(:geo_drivers, put_elem(row, 3, System.monotonic_time(:second) - 600))

    # its app's heartbeat, queued before the pass's removal
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        stuck_pass([fn -> Geo.driver_update(me, @cell, @spot, []) end])
      end)

    # nothing repaired, so no repair logged (a false alarm on a busy server
    # — the seventh review)
    refute log =~ "frozen car"

    assert Geo.driver_on_map?(d.id), "the frozen-car removal took a car that had just spoken"
    assert Hoodride.Requests.open_request_of(9_701) != nil
    refute_received %Phoenix.Socket.Broadcast{event: "request_declined"}
  end

  test "a car and a ✋ at once, the ✋ raised again first: the fresh ✋ kept" do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-both", name: "B"})
    {:ok, _} = Registry.register(Hoodride.UserChannels, u.id, nil)
    Geo.user_connected(u.id)
    :ok = Geo.driver_update(%{id: u.id, name: "B", photo: nil}, @cell, @spot, [])
    # a stray ✋ beside the car (the car is the winner by the parents row)
    :ets.insert(:geo_hands, {u.id, @cell, @spot})

    # they raise their ✋ for real, queued before the pass's removal of the stray one
    stuck_pass([fn -> Geo.hand_up(u.id, @cell, @spot, []) end])

    assert [{_, _, _}] = :ets.lookup(:geo_hands, u.id), "the ✋ they just raised was removed"
    refute Geo.driver_on_map?(u.id)
  end

  # (the sixth review) a car and a ✋ with no record of which came last: both
  # go in ONE step — and if the person lowers their ✋ first, neither does
  # (two steps: the car's check couldn't tell that from the pass's own ✋
  # removal, and took the car)
  test "a car and a ✋ with no record of which came last, the ✋ lowered first: the car kept" do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-np", name: "N"})
    {:ok, _} = Registry.register(Hoodride.UserChannels, u.id, nil)
    Geo.user_connected(u.id)
    :ok = Geo.driver_update(%{id: u.id, name: "N", photo: nil}, @cell, @spot, [])
    :ets.insert(:geo_hands, {u.id, @cell, @spot})
    :ets.delete(:geo_parents, u.id)

    # they lower the ✋, queued before the pass's removal
    stuck_pass([fn -> Geo.hand_down(u.id) end])

    assert Geo.driver_on_map?(u.id), "the car taken though the ✋ was lowered"
  end

  test "on the map mid-ride, the ride over before the removal runs: the car kept" do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-mid", name: "M"})
    {:ok, _} = Registry.register(Hoodride.UserChannels, u.id, nil)
    Geo.user_connected(u.id)
    :ok = Geo.driver_update(%{id: u.id, name: "M", photo: nil}, @cell, @spot, [])
    # a live ride's seat (a stand-in registered as the ride)
    test = self()

    ride =
      spawn(fn ->
        Registry.register(Hoodride.Rides.Registry, "ss-ride", nil)
        send(test, :up)
        receive do: (:stop -> :ok)
      end)

    assert_receive :up
    :ets.insert(:rides_by_user, {u.id, "ss-ride"})

    # the ride ends (its seat freed) while the removal waits in the queue
    stuck_pass([], fn -> :ets.delete(:rides_by_user, u.id) end)
    send(ride, :stop)

    assert Geo.driver_on_map?(u.id), "removed as mid-ride after the ride had ended"
  end

  # (the second review) gone past grace by the pass's look; while the
  # removal waits they come back AND leave again — a fresh grace: kept
  test "left, came back and left again while the removal waited: a fresh grace — car and ✋ kept" do
    {:ok, r} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-lrl-r", name: "R"})
    {:ok, d} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-lrl-d", name: "D"})
    :ok = Geo.hand_up(r.id, @cell, @spot, [])
    :ok = Geo.driver_update(%{id: d.id, name: d.name, photo: nil}, @cell, @spot, [])
    # the car's position fresh: only the grace is in question
    for u <- [r, d],
        do: :ets.insert(:geo_presence, {u.id, :grace, System.monotonic_time(:second) - 3600})

    stuck_pass([], fn ->
      # back… and gone again, a moment ago
      for u <- [r, d] do
        Geo.user_connected(u.id)
        Geo.user_disconnected(u.id)
      end
    end)

    assert [{_, _, _}] = :ets.lookup(:geo_hands, r.id), "removed inside a fresh grace"
    assert Geo.driver_on_map?(d.id), "removed inside a fresh grace"
  end

  test "the short wait is the pass's own: afterwards the same process waits as before" do
    Application.put_env(:hoodride, :geo_call_timeout, 300)
    on_exit(fn -> Application.delete_env(:hoodride, :geo_call_timeout) end)
    id = stale_car("ss-own")
    ws = writers()
    Enum.each(ws, &:sys.suspend/1)

    try do
      # (in THIS process: the timer's pass runs in the Sweeper's)
      assert Hoodride.Sweeper.sweep_now() == :ok
      {us, result} = :timer.tc(fn -> Geo.hand_down(id) end)
      assert result == {:error, :timeout}
      assert us >= 250_000, "the pass's 'don't wait' leaked out of it"
    after
      Enum.each(ws, &:sys.resume/1)
      Enum.each(ws, &:sys.get_state/1)
    end
  end
end
