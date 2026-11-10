defmodule Hoodride.AggregatesTest do
  @moduledoc "The coarse-cell tally tier: recompute, diffs, channel reads."
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.Geo

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "agg-u", name: "AggU"})

    %{user: user}
  end

  defp profile(id), do: %{id: id, name: "P#{id}", photo: nil}

  # Each side of a hex count has its OWN topic and audience: car counts go
  # to riders (agg:d:), hand counts to online drivers (agg:h:). A change
  # publishes only the side that moved — sending the other side too, even
  # unchanged, would leak WHEN the other role's people come and go.
  defp sub(cell) do
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, cell))
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:hands, cell))
  end

  # a broadcast is its update plus `json`, that same update encoded once
  # (Hoodride.MapJsonTest) — which therefore can't carry the other side either
  defp only_itself(payload) do
    {json, plain} = Map.pop!(payload, :json)
    assert Jason.decode!(json, keys: :atoms) == plain
    plain
  end

  defp cars(cell), do: "agg:d:" <> cell
  defp hands(cell), do: "agg:h:" <> cell

  test "tallies shift INSTANTLY on every parents-row change, no recompute needed" do
    sub("c7A")
    {d, h} = {cars("c7A"), hands("c7A")}

    # each arrival broadcasts the fresh count the moment it happens
    Geo.driver_update(profile(1), "cell8a", nil, ["c7A", "c5A"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 1} = p}
    refute Map.has_key?(p, :hands)
    Geo.driver_update(profile(2), "cell8b", nil, ["c7A", "c5A"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 2}}
    Geo.hand_up(3, "cell8c", "spot9c", ["c7A", "c5A"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 1} = p}
    refute Map.has_key?(p, :drivers)
    # …and a hand arriving says NOTHING on the car side
    refute_receive %Phoenix.Socket.Broadcast{topic: ^d}, 150
    assert Geo.agg_counts_for("c7A") == %{drivers: 2, hands: 1}
    assert Geo.agg_counts_for("c5A") == %{drivers: 2, hands: 1}

    # recompute agrees with the instant layer → silence, no re-broadcast
    Geo.recompute_aggregates()
    refute_receive %Phoenix.Socket.Broadcast{topic: ^d}, 150
    refute_receive %Phoenix.Socket.Broadcast{topic: ^h}, 10

    # a position update that stays in the same parents → silence
    Geo.driver_update(profile(2), "cell8b", nil, ["c7A", "c5A"])
    refute_receive %Phoenix.Socket.Broadcast{topic: ^d}, 150

    # leaving decrements instantly
    Geo.driver_offline(2)
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 1}}
    refute_receive %Phoenix.Socket.Broadcast{topic: ^h}, 150
    assert Geo.agg_counts_for("c7A") == %{drivers: 1, hands: 1}
  end

  test "a boundary crossing decrements the old hex and increments the new one instantly" do
    sub("c7X")
    sub("c7Y")
    {x, y} = {cars("c7X"), cars("c7Y")}

    Geo.driver_update(profile(11), "cell8x", nil, ["c7X", "c5X"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^x, payload: %{drivers: 1}}

    # crossing: res-7 parent changes, res-5 stays — only the changed hex moves
    Geo.driver_update(profile(11), "cell8y", nil, ["c7Y", "c5X"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^x, payload: %{drivers: 0}}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^y, payload: %{drivers: 1}}
    assert Geo.agg_counts_for("c7X") == %{drivers: 0, hands: 0}
    assert Geo.agg_counts_for("c7Y") == %{drivers: 1, hands: 0}
    # the unchanged shared res-5 parent kept its count without churn
    assert Geo.agg_counts_for("c5X") == %{drivers: 1, hands: 0}
  end

  test "emptied cells broadcast zeros instantly and are deleted from the table" do
    sub("c7B")
    {d, h} = {cars("c7B"), hands("c7B")}
    Geo.hand_up(9, "cell8z", "spot9z", ["c7B"])
    assert Geo.agg_counts_for("c7B") == %{drivers: 0, hands: 1}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 1}}

    Geo.hand_down(9)
    assert Geo.agg_counts_for("c7B") == %{drivers: 0, hands: 0}
    # the zero goes to the side that emptied, and only to it
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 0}}
    refute_receive %Phoenix.Socket.Broadcast{topic: ^d}, 150
    assert :ets.lookup(:geo_agg, "c7B") == []
  end

  test "a mode flip moves the hex count between columns instantly" do
    sub("c7F")
    {d, h} = {cars("c7F"), hands("c7F")}

    # demand first: one hand in the hex
    Geo.hand_up(31, "cell8f", "spot9f", ["c7F"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 1}}

    # same user becomes a driver — the exclusion lowers the hand, then the
    # driver shift lands: hand column empties, driver column fills,
    # instantly, each told to its own side
    Geo.driver_update(profile(31), "cell8f", nil, ["c7F"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 0}}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 1}}
    assert Geo.agg_counts_for("c7F") == %{drivers: 1, hands: 0}
  end

  test "stray role-crossed teardowns never erase the other role's hex count" do
    # a stray hand_down against an on-duty driver: his count must survive
    Geo.driver_update(profile(41), "cell8m", nil, ["c7M"])
    Geo.hand_down(41)
    assert Geo.agg_counts_for("c7M") == %{drivers: 1, hands: 0}
    assert Geo.driver_on_map?(41)

    # a stray driver_offline against a raised hand: her count must survive
    Geo.hand_up(42, "cell8n", "spot9n", ["c7N"])
    Geo.driver_offline(42)
    assert Geo.agg_counts_for("c7N") == %{drivers: 0, hands: 1}
    assert [{42, _, _}] = :ets.lookup(:geo_hands, 42)
  end

  test "recompute on a virgin world is a quiet no-op" do
    # the sweeper's first tick on a fresh boot, before any user exists
    assert Geo.recompute_aggregates() == :ok
    assert :ets.tab2list(:geo_agg) == []
  end

  defp shard_of(key),
    do: GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, key}})

  # returns once a (paused) process has mail waiting
  defp queued(pid) do
    if Process.info(pid, :message_queue_len) == {:message_queue_len, 0} do
      :erlang.yield()
      queued(pid)
    end
  end

  test "the recount never reads a write in flight (the torn-moment double count)" do
    # born from a failing proof: with the shared seqlock, two shards mid-op
    # left the version even, the recount trusted this exact torn moment, and
    # the finishing writer's own +1 made it TWO drivers

    # a shard caught mid-op: suspended, it cannot reach the pause
    busy = shard_of(77)
    :sys.suspend(busy)

    try do
      # its torn moment: parents and membership rows written, count not yet shifted
      :ets.insert(:geo_drivers, {77, "cell8t", "cell8t", 0})
      :ets.insert(:geo_parents, {77, :driver, ["c7T"]})
      :ets.insert(:geo_members, {{"c7T", 77}, :driver})

      # one shard never paused → the recount refuses to read at all
      assert Geo.recompute_aggregates() == :skipped
      assert Geo.agg_counts_for("c7T") == %{drivers: 0, hands: 0}

      # the writer finishes its op: its own +1 lands
      :ets.update_counter(:geo_agg, "c7T", {2, 1}, {"c7T", 0, 0})
    after
      # never leave a shard frozen for the tests that follow
      :sys.resume(busy)
    end

    # a still world now: the recount agrees — counted once, never twice
    assert Geo.recompute_aggregates() == :ok
    assert Geo.agg_counts_for("c7T") == %{drivers: 1, hands: 0}
  end

  test "writes during the pause wait, then all apply in order once released" do
    m = profile(61)

    assert {:ok, {task, on_map_while_paused}} =
             Geo.with_writers_held(fn _held? ->
               task =
                 Task.async(fn ->
                   Geo.driver_update(m, "cell8w", nil, ["c7W"])
                   Geo.driver_update(m, "cell8v", nil, ["c7V"])
                 end)

               # the write is waiting in its paused writer (a fixed 50 ms
               # sleep here outlasted the pause's 250 ms cap on a busy
               # machine: :expired)
               queued(shard_of(61))
               {task, Geo.driver_on_map?(61)}
             end)

    refute on_map_while_paused
    Task.await(task)

    # both landed, in order: the driver ends in the second cell
    assert [{61, "cell8v", _, _}] = :ets.lookup(:geo_drivers, 61)
    assert Geo.agg_counts_for("c7V") == %{drivers: 1, hands: 0}
    assert Geo.agg_counts_for("c7W") == %{drivers: 0, hands: 0}
  end

  defp spawn_stuck_holder do
    parent = self()

    holder =
      spawn(fn ->
        Geo.with_writers_held(fn _ ->
          send(parent, :holding)
          Process.sleep(:infinity)
        end)
      end)

    assert_receive :holding, 1_000
    holder
  end

  defp ms_to_write(user_id) do
    {us, :ok} =
      :timer.tc(fn -> Geo.driver_update(profile(user_id), "cell8k", nil, ["c7K"]) end)

    div(us, 1000)
  end

  test "a finished pause frees the writers at once, not at the cap" do
    assert {:ok, :read} = Geo.with_writers_held(fn _ -> :read end)
    assert ms_to_write(64) < div(Geo.max_pause_ms(), 2)
  end

  test "a holder that dies mid-pause releases every writer at once" do
    holder = spawn_stuck_holder()
    Process.exit(holder, :kill)

    # released by the holder's death — well before the time cap
    assert ms_to_write(62) < div(Geo.max_pause_ms(), 2)
  end

  test "a wedged holder stalls the map no longer than the pause cap" do
    holder = spawn_stuck_holder()

    # the holder lives on, never releasing: each shard's own cap frees it
    assert ms_to_write(63) <= Geo.max_pause_ms() + 100
    Process.exit(holder, :kill)
  end

  test "a pause that outlives its cap discards what it read" do
    assert Geo.with_writers_held(fn _ ->
             Process.sleep(Geo.max_pause_ms() + 20)
             :read
           end) == :expired
  end

  test "a shard restarted mid-pause voids the pause (its fresh process was never held)" do
    assert :expired =
             Geo.with_writers_held(fn held? ->
               old = shard_of(5)
               ref = Process.monitor(old)
               Process.exit(old, :kill)
               assert_receive {:DOWN, ^ref, :process, ^old, :killed}
               await_new_shard(5, old)
               refute held?.()
               :read
             end)
  end

  defp await_new_shard(key, old) do
    case shard_of(key) do
      pid when is_pid(pid) and pid != old ->
        :ok

      _ ->
        Process.sleep(5)
        await_new_shard(key, old)
    end
  end

  test "the recount prunes altitude orphans and their phantom counts" do
    Geo.driver_update(profile(71), "cell8o", nil, ["c7O"])

    # crash residue: the street-map row is gone, parents row and count remain
    :ets.delete(:geo_drivers, 71)

    assert Geo.recompute_aggregates() == :ok
    assert :ets.lookup(:geo_parents, 71) == []
    assert Geo.agg_counts_for("c7O") == %{drivers: 0, hands: 0}
  end

  test "the sweeper shrugs off a late pause reply" do
    send(Hoodride.Sweeper, {:held, make_ref(), self()})
    assert Hoodride.Sweeper.sweep_now() == :ok
    assert Process.alive?(Process.whereis(Hoodride.Sweeper))
  end

  test "the reconciler recreates a vanished tally row (the insert_new path)" do
    sub("c7R")
    {d, h} = {cars("c7R"), hands("c7R")}
    Geo.driver_update(profile(51), "cell8r", nil, ["c7R"])
    assert Geo.agg_counts_for("c7R") == %{drivers: 1, hands: 0}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 1}}

    # the row vanishes (raw corruption) while truth still holds the driver —
    # found by mutation testing: this branch ran in tests but nothing checked it
    :ets.delete(:geo_agg, "c7R")
    Geo.recompute_aggregates()

    assert Geo.agg_counts_for("c7R") == %{drivers: 1, hands: 0}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 1}}
    # the hand side was zero before and after: nothing to tell drivers
    refute_receive %Phoenix.Socket.Broadcast{topic: ^h}, 150
  end

  test "the reconciler heals a corrupted tally within one sweep" do
    sub("c7H")
    {d, h} = {cars("c7H"), hands("c7H")}
    Geo.hand_up(19, "cell8h", "spot9h", ["c7H"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 1}}

    # simulate drift (a hypothetical missed shift): the counter lies, rows
    # are truth. Both sides are wrong, so both sides hear the healed number.
    :ets.insert(:geo_agg, {"c7H", 42, 0})
    Geo.recompute_aggregates()
    assert Geo.agg_counts_for("c7H") == %{drivers: 0, hands: 1}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: %{drivers: 0}}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: %{hands: 1}}
  end

  test "each side's count reaches only its own topic, carrying only its own number" do
    sub("c7S")
    {d, h} = {cars("c7S"), hands("c7S")}
    Geo.driver_update(profile(21), "cell8s", nil, ["c7S"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^d, payload: car_payload}
    assert only_itself(car_payload) == %{cell: "c7S", drivers: 1}

    Geo.hand_up(22, "cell8t", "spot9t", ["c7S"])
    assert_receive %Phoenix.Socket.Broadcast{topic: ^h, payload: hand_payload}
    assert only_itself(hand_payload) == %{cell: "c7S", hands: 1}
    refute_receive %Phoenix.Socket.Broadcast{topic: ^d}, 150

    # the table itself still holds both (the channel picks the side)
    assert %{drivers: 1, hands: 1} = Geo.agg_counts_for("c7S")
  end

  test "the sweeper tick runs the recompute" do
    Geo.user_connected(4)
    Geo.driver_update(profile(4), "cell8d", nil, ["c7C"])
    Hoodride.Sweeper.sweep_now()
    assert Geo.agg_counts_for("c7C") == %{drivers: 1, hands: 0}
  end

  @tag :per_message
  test "world sync of an agg cell returns its counts and streams updates", %{user: user} do
    Geo.driver_update(profile(5), "cell8e", nil, ["c7D"])
    Geo.recompute_aggregates()

    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    # this user is a viewer: the car count, and only the car count
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    ref = push(world, "sync", %{"agg" => ["c7D"]})
    assert_reply ref, :ok, %{agg: [%{cell: "c7D", drivers: 1} = counts]}
    refute Map.has_key?(counts, :hands)

    # a hand in the watched hex is none of a viewer's business: silence
    Geo.hand_up(6, "cell8f", "spot9f", ["c7D"])
    refute_push "agg_update", %{}

    # a car arriving is forwarded by the multiplexer
    Geo.driver_update(profile(7), "cell8g", nil, ["c7D"])
    assert_push "agg_update", %{cell: "c7D", drivers: 2}

    ref = push(world, "anything", %{})
    assert_reply ref, :error, %{reason: "read_only"}
  end

  test "parents arrive via the user channel and malformed ones are dropped", %{user: user} do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(socket, "user:#{user.id}", %{})

    push(chan, "driver_update", %{
      "cell" => "cell8f",
      "lat" => 1.0,
      "lng" => 2.0,
      "parents" => ["c7E", 123, String.duplicate("x", 500), "c5E"]
    })

    # sync barrier
    ref = push(chan, "cancel_request", %{})
    assert_reply ref, :ok

    Hoodride.Geo.recompute_aggregates()
    # only the two well-formed parents tallied
    assert Geo.agg_counts_for("c7E") == %{drivers: 1, hands: 0}
    assert Geo.agg_counts_for("c5E") == %{drivers: 1, hands: 0}
  end

  # two writer shards counting the same hex each broadcast the number they
  # read — and their messages can land in either order (two senders, no
  # order between them): a watcher could be left on a stale count until
  # the hex next changed (owner, 2026-11-10). After sending, the count is
  # read again and sent again if it moved: the LAST number a watcher gets
  # is always one read after the last change.
  test "many people joining and leaving one hex at once: the last count a watcher hears is the true count" do
    hex = "c7-stress"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, hex))
    people = for i <- 1..48, do: profile(9_100_000 + i)

    for round <- 1..30 do
      on = Enum.take_random(people, 32)

      Task.async_stream(on, &Geo.driver_update(&1, "c9-#{&1.id}", nil, [hex]),
        max_concurrency: 32,
        timeout: :infinity
      )
      |> Stream.run()

      Task.async_stream(Enum.take_random(on, 16), &Geo.driver_offline(&1.id),
        max_concurrency: 16,
        timeout: :infinity
      )
      |> Stream.run()

      last = last_count(hex, nil)
      truth = Geo.agg_counts_for(hex).drivers
      assert truth == 16, "(round #{round}: 16 left on)"

      assert last == truth,
             "round #{round}: watcher left on #{inspect(last)}, the hex holds #{truth}"

      for p <- on, do: Geo.driver_offline(p.id)
      _ = last_count(hex, nil)
    end
  end

  # the re-check after sending must never repeat one side's count because
  # the OTHER side moved: a rider hearing the same car count twice would
  # learn a hand went up or down there (the privacy law: a side is sent
  # only when it changed). One car comes and goes while many hands churn
  # the same hex: the car count heard must alternate 1, 0, 1, 0 — never
  # repeat.
  test "the count re-check never repeats a side because the other side moved" do
    hex = "c7-xside"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, hex))
    car = profile(9_200_000)
    hands = for i <- 1..40, do: 9_200_000 + i

    heard =
      for _round <- 1..40, reduce: [] do
        acc ->
          churn =
            Task.async(fn ->
              Task.async_stream(hands, &Geo.hand_up(&1, "c9-h#{&1}", nil, [hex]),
                max_concurrency: 40,
                timeout: :infinity
              )
              |> Stream.run()

              Task.async_stream(hands, &Geo.hand_down(&1),
                max_concurrency: 40,
                timeout: :infinity
              )
              |> Stream.run()
            end)

          Geo.driver_update(car, "c9-car", nil, [hex])
          Geo.driver_offline(car.id)
          Task.await(churn, :infinity)
          acc ++ drivers_heard(hex, [])
      end

    # exactly: 1, 0 per round — no repeat (a hand's move leaked), none missing
    assert heard == List.flatten(List.duplicate([1, 0], 40)),
           "car counts heard (a repeat = a hand's move leaked): #{inspect(heard)}"
  end

  # the last car and the last hand of a hex leave at the same moment, from
  # two writer shards: the second to finish finds the row already deleted
  # (it went 0/0, and the other deleted it) — it must still say ITS side is
  # 0, or riders keep seeing a car there until the hex next changes. (Two
  # real shards rarely interleave there: the state is set up directly.)
  test "a count whose row another shard already deleted still announces its own side as 0" do
    hex = "c7-zero"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, hex))
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:hands, hex))
    :ets.delete(:geo_agg, hex)
    Geo.settle_and_broadcast(hex, [:drivers])
    assert side_heard(hex, %{}) == %{drivers: 0}, "riders must hear 0 — and drivers nothing"
  end

  defp side_heard(hex, acc) do
    receive do
      %Phoenix.Socket.Broadcast{topic: "agg:d:" <> ^hex, payload: p} ->
        side_heard(hex, Map.put(acc, :drivers, p.drivers))

      %Phoenix.Socket.Broadcast{topic: "agg:h:" <> ^hex, payload: p} ->
        side_heard(hex, Map.put(acc, :hands, p.hands))
    after
      100 -> acc
    end
  end

  # the mirror (owner, 2026-11-10): a repeated ✋ count would tell drivers
  # when CARS come and go there
  test "the count re-check never repeats the hands side because cars moved" do
    hex = "c7-xside-h"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:hands, hex))
    hand = 9_400_000
    cars = for i <- 1..40, do: profile(9_400_000 + i)

    heard =
      for _round <- 1..40, reduce: [] do
        acc ->
          churn =
            Task.async(fn ->
              Task.async_stream(cars, &Geo.driver_update(&1, "c9-c#{&1.id}", nil, [hex]),
                max_concurrency: 40,
                timeout: :infinity
              )
              |> Stream.run()

              Task.async_stream(cars, &Geo.driver_offline(&1.id),
                max_concurrency: 40,
                timeout: :infinity
              )
              |> Stream.run()
            end)

          Geo.hand_up(hand, "c9-hand", nil, [hex])
          Geo.hand_down(hand)
          Task.await(churn, :infinity)
          acc ++ hands_heard(hex, [])
      end

    assert heard == List.flatten(List.duplicate([1, 0], 40)),
           "hand counts heard (a repeat = a car's move leaked): #{inspect(heard)}"
  end

  test "a ✋ count whose row another shard already deleted still announces 0 — to drivers only" do
    hex = "c7-zero-h"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, hex))
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:hands, hex))
    :ets.delete(:geo_agg, hex)
    Geo.settle_and_broadcast(hex, [:hands])
    assert side_heard(hex, %{}) == %{hands: 0}
  end

  test "many hands up and down in one hex at once: the last ✋ count a driver hears is the true count" do
    hex = "c7-stress-h"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:hands, hex))
    people = for i <- 1..48, do: 9_500_000 + i

    for round <- 1..30 do
      on = Enum.take_random(people, 32)

      Task.async_stream(on, &Geo.hand_up(&1, "c9-#{&1}", nil, [hex]),
        max_concurrency: 32,
        timeout: :infinity
      )
      |> Stream.run()

      Task.async_stream(Enum.take_random(on, 16), &Geo.hand_down/1,
        max_concurrency: 16,
        timeout: :infinity
      )
      |> Stream.run()

      truth = Geo.agg_counts_for(hex).hands
      assert truth == 16
      assert hands_last(hex, nil) == truth, "round #{round}"
      for p <- on, do: Geo.hand_down(p)
      _ = hands_last(hex, nil)
    end
  end

  defp hands_heard(hex, acc) do
    receive do
      %Phoenix.Socket.Broadcast{topic: "agg:h:" <> ^hex, payload: p} ->
        hands_heard(hex, [p.hands | acc])
    after
      100 -> Enum.reverse(acc)
    end
  end

  defp hands_last(hex, acc) do
    receive do
      %Phoenix.Socket.Broadcast{topic: "agg:h:" <> ^hex, payload: p} -> hands_last(hex, p.hands)
    after
      200 -> acc
    end
  end

  # load bounds (owner, 2026-11-10): one writer crossing into a hex is ONE
  # count message per side — the re-check adds nothing when nobody else
  # wrote; a heartbeat inside the same hexes adds none at all
  test "one car crossing into a hex: exactly one count message; a heartbeat in place: none" do
    hex = "c7-load"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, hex))
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:hands, hex))
    car = profile(9_600_000)
    Geo.driver_update(car, "c9-l1", nil, [hex])
    assert_receive %Phoenix.Socket.Broadcast{topic: "agg:d:" <> ^hex, payload: %{drivers: 1}}
    refute_receive %Phoenix.Socket.Broadcast{topic: "agg:" <> _}, 100
    Geo.driver_update(car, "c9-l1", nil, [hex])
    Geo.driver_update(car, "c9-l2", nil, [hex])
    refute_receive %Phoenix.Socket.Broadcast{topic: "agg:" <> _}, 100
  end

  # a rider with a ✋ up switches to driving: the car replaces the ✋ — the
  # drivers watching must HEAR the ✋ go (and its count drop), and riders
  # hear the car arrive; each on its own topic only
  test "a ✋ replaced by a car: drivers hear the ✋ leave and its count drop; riders hear the car" do
    alias Phoenix.Socket.Broadcast
    hex = "c7-swap"

    for t <- [
          "geo:h:c9-sw",
          "geo:d:c9-sw",
          Geo.agg_topic(:hands, hex),
          Geo.agg_topic(:drivers, hex)
        ],
        do: HoodrideWeb.Endpoint.subscribe(t)

    Geo.hand_up(9_700_001, "c9-sw", nil, [hex])
    assert_receive %Broadcast{topic: "geo:h:c9-sw", event: "hand_update"}
    assert_receive %Broadcast{topic: "agg:h:" <> ^hex, payload: %{hands: 1}}

    Geo.driver_update(profile(9_700_001), "c9-sw", nil, [hex])
    assert_receive %Broadcast{topic: "geo:h:c9-sw", event: "hand_left", payload: %{id: 9_700_001}}
    assert_receive %Broadcast{topic: "agg:h:" <> ^hex, payload: %{hands: 0} = h}

    assert_receive %Broadcast{
      topic: "geo:d:c9-sw",
      event: "driver_update",
      payload: %{id: 9_700_001}
    }

    assert_receive %Broadcast{topic: "agg:d:" <> ^hex, payload: %{drivers: 1} = d}
    # each count carries only its own side
    refute Map.has_key?(h, :drivers)
    refute Map.has_key?(d, :hands)
  end

  # the re-check is bounded: a hex that never stops changing gets at most
  # 3 extra sends from one settle (its own next writes carry on from there)
  # the re-check is bounded: a hex that never stops changing gets at most
  # 3 extra sends from one settle (its own next writes carry on from there).
  # A reader whose count moves on EVERY read: exactly 3, then it stops.
  test "the count re-check is bounded: 3 extra sends at most, however the count keeps moving" do
    hex = "c7-churn"
    HoodrideWeb.Endpoint.subscribe(Geo.agg_topic(:drivers, hex))
    counter = :counters.new(1, [])

    ever_new = fn _cell ->
      :counters.add(counter, 1, 1)
      {:counters.get(counter, 1), 0}
    end

    Geo.reconfirm_agg(hex, [:drivers], {0, 0}, 3, ever_new)
    assert drivers_heard(hex, []) == [1, 2, 3]
    # and a count that doesn't move: nothing sent at all
    Geo.reconfirm_agg(hex, [:drivers], {5, 0}, 3, fn _ -> {5, 9} end)
    assert drivers_heard(hex, []) == []
    # a count that moved ONCE, then holds: sent once — the next re-check
    # compares with what was just sent (not the first number): no repeat
    Geo.reconfirm_agg(hex, [:drivers], {0, 0}, 3, fn _ -> {1, 0} end)
    assert drivers_heard(hex, []) == [1]
  end

  defp drivers_heard(hex, acc) do
    receive do
      %Phoenix.Socket.Broadcast{topic: "agg:d:" <> ^hex, payload: p} ->
        drivers_heard(hex, [p.drivers | acc])
    after
      100 -> Enum.reverse(acc)
    end
  end

  defp last_count(hex, acc) do
    receive do
      %Phoenix.Socket.Broadcast{topic: "agg:d:" <> ^hex, payload: p} -> last_count(hex, p.drivers)
    after
      200 -> acc
    end
  end
end
