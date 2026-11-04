defmodule Hoodride.BatchedRecountTest do
  @moduledoc """
  The batched recount in the app: parent-cell membership (:geo_members)
  kept in step by every write, many short pauses sized by the safeguarded
  EWMA, holds sent as priority messages, membership drift repair.
  """
  use ExUnit.Case

  @moduletag timeout: 120_000

  alias Hoodride.Geo

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    Process.delete({Geo, :batch})
    :ok
  end

  defp prof(id), do: %{id: id, name: "P#{id}", photo: nil}

  defp shard_of(key),
    do: GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, key}})

  defp members_of(id),
    do: :ets.match_object(:geo_members, {{:_, id}, :_}) |> Enum.sort()

  # returns once a (suspended) process holds more than `n` messages
  defp queued_past(pid, n) do
    {:message_queue_len, len} = Process.info(pid, :message_queue_len)

    if len <= n do
      :erlang.yield()
      queued_past(pid, n)
    end
  end

  describe "membership follows every write" do
    test "join, cross, mode flip to hand (same cells re-filed), lower hand, offline" do
      Geo.driver_update(prof(1), "c8", nil, ["A", "B"])
      assert members_of(1) == [{{"A", 1}, :driver}, {{"B", 1}, :driver}]

      # crossing: B stays, A → C
      Geo.driver_update(prof(1), "c8", nil, ["C", "B"])
      assert members_of(1) == [{{"B", 1}, :driver}, {{"C", 1}, :driver}]

      # becoming a hand in the SAME cells: every row re-filed under :hand
      Geo.hand_up(1, "c8", "s", ["C", "B"])
      assert members_of(1) == [{{"B", 1}, :hand}, {{"C", 1}, :hand}]

      Geo.hand_down(1)
      assert members_of(1) == []

      Geo.driver_update(prof(1), "c8", nil, ["A"])
      Geo.driver_offline(1)
      assert members_of(1) == []
    end

    test "a repeated cell in the client's list is filed (and counted) once" do
      Geo.driver_update(prof(2), "c8", nil, ["A", "A", "B"])

      assert members_of(2) == [{{"A", 2}, :driver}, {{"B", 2}, :driver}]
      assert Geo.agg_counts_for("A") == %{drivers: 1, hands: 0}
      assert :ets.lookup(:geo_parents, 2) == [{2, :driver, ["A", "B"]}]
    end

    test "a same-cell position update writes neither parents nor membership" do
      Geo.driver_update(prof(3), "c8", "s1", ["A", "B"])

      calls =
        traced_ets_writes(fn -> Geo.driver_update(prof(3), "c8", "s2", ["A", "B"]) end)

      # the trace really captured the op (not vacuous): the position write
      assert {:insert, :geo_drivers} in calls, "trace captured nothing: #{inspect(calls)}"

      refute Enum.any?(calls, fn {_f, t} -> t in [:geo_parents, :geo_members, :geo_agg] end),
             "an unchanged update wrote #{inspect(calls)}"

      # the spot itself still moved
      assert [{3, "c8", "s2", _}] = :ets.lookup(:geo_drivers, 3)
    end
  end

  describe "batched recount" do
    test "many hexes: drift in many batches all heals, across many pauses" do
      for u <- 1..700, do: Geo.driver_update(prof(u), "c8", nil, ["h#{rem(u, 350)}"])
      for c <- [0, 120, 230, 349], do: :ets.update_counter(:geo_agg, "h#{c}", {2, 5})

      assert Geo.recompute_aggregates() == :ok
      for c <- 0..349, do: assert(Geo.agg_counts_for("h#{c}") == %{drivers: 2, hands: 0})

      # it really paused more than once, and learned a per-hex cost
      assert %{per_hex_us: est, last: last} = Process.get({Geo, :batch})
      assert est > 0 and last >= 1
    end

    test "a stuck writer stops the recount after ONE failed pause, not one per batch" do
      for u <- 1..300, do: Geo.driver_update(prof(u), "c8", nil, ["h#{rem(u, 150)}"])
      # force one hex per pause: 150 pauses if it kept going
      Process.put({Geo, :batch}, %{per_hex_us: 1.0e9, last: 1})

      busy = shard_of(1)
      :sys.suspend(busy)

      try do
        {us, result} = :timer.tc(&Geo.recompute_aggregates/0)
        assert result == :skipped
        # one pause waiting out the 250 ms cap — not 150 of them (37 s)
        assert us < 2_000_000
      after
        :sys.resume(busy)
      end
    end

    test "the hold is a PRIORITY message: it jumps a writer's queued mail" do
      shard = shard_of(5)
      :sys.suspend(shard)
      # 3,000 ordinary messages already waiting in the shard's mailbox
      for _ <- 1..3_000, do: send(shard, {:release, make_ref()})

      try do
        task =
          Task.async(fn ->
            Geo.with_writers_held(fn _ ->
              {:message_queue_len, left} = Process.info(shard, :message_queue_len)
              left
            end)
          end)

        # let the shard run the moment the hold lands (a fixed sleep here
        # outlasted the hold's 250 ms cap on a busy machine: :expired)
        queued_past(shard, 3_000)
        :sys.resume(shard)

        # the shard answered the hold while (nearly) all 3,000 were still
        # queued — an ordinary hold would have been answered after them
        assert {:ok, left} = Task.await(task, 5_000)
        assert left > 2_500, "hold answered with only #{left} messages still queued"
      after
        :sys.resume(shard)
      end
    end

    test "a batch may at most double the previous one, whatever the estimate says" do
      for u <- 1..400, do: Geo.driver_update(prof(u), "c8", nil, ["h#{rem(u, 400)}"])
      # the estimate claims hexes are nearly free: it would predict huge batches
      Process.put({Geo, :batch}, %{per_hex_us: 0.001, last: 1})

      assert Geo.recompute_aggregates() == :ok
      assert %{first_batch: first} = Process.get({Geo, :last_recount})
      assert first <= 2
    end

    test "the clock stops a pause at the target, however big the predicted batch" do
      for u <- 1..3_000, do: Geo.driver_update(prof(u), "c8", nil, ["h#{u}"])
      # a huge prediction AND a huge last batch: only the clock can stop it
      Process.put({Geo, :batch}, %{per_hex_us: 0.001, last: 1_000_000})

      assert Geo.recompute_aggregates() == :ok
      assert %{max_batch: max_batch, pauses: pauses} = Process.get({Geo, :last_recount})
      # counting 3,000 hexes takes several ms — far past one 250 µs pause
      assert max_batch < 3_000
      assert pauses > 1
    end

    test "every writer shard registers a priority alias" do
      for pid <-
            for(
              {_, pid, _, _} <- PartitionSupervisor.which_children(Hoodride.GeoWriters),
              do: pid
            ) do
        assert [{^pid, _alias}] = :ets.lookup(:geo_writer_aliases, pid)
      end
    end
  end

  describe "membership drift repair" do
    test "finds a missing row, a stray row, a wrong role and a wrong cell — only those users" do
      Geo.driver_update(prof(1), "c8", nil, ["A"])
      Geo.driver_update(prof(2), "c8", nil, ["A"])
      Geo.driver_update(prof(3), "c8", nil, ["A"])
      Geo.hand_up(4, "c8", "s", ["B"])
      Geo.driver_update(prof(9), "c8", nil, ["Z"])

      # 1: missing
      :ets.delete(:geo_members, {"A", 1})
      # 5: stray, nobody behind it
      :ets.insert(:geo_members, {{"A", 5}, :driver})
      # 3: wrong role
      :ets.insert(:geo_members, {{"A", 3}, :hand})
      # 4: wrong cell (row moved)
      :ets.delete(:geo_members, {"B", 4})
      :ets.insert(:geo_members, {{"C", 4}, :hand})

      assert Enum.sort(Geo.member_drift()) == [1, 3, 4, 5]
    end

    test "a lone missing row (the index pass alone sees nothing) is found by the count" do
      Geo.driver_update(prof(1), "c8", nil, ["A", "B"])
      Geo.driver_update(prof(2), "c8", nil, ["A"])
      :ets.delete(:geo_members, {"B", 1})

      assert Geo.member_drift() == [1]
    end

    test "a clean world reports nothing (the count-proof path)" do
      for u <- 1..50, do: Geo.driver_update(prof(u), "c8", nil, ["A#{rem(u, 4)}", "B"])
      assert Geo.member_drift() == []
    end

    test "rebuild re-derives a user's rows from their parents row; a sweep repairs then recounts" do
      Geo.user_connected(1)
      Geo.driver_update(prof(1), "c8", nil, ["A", "B"])
      :ets.delete(:geo_members, {"A", 1})
      :ets.insert(:geo_members, {{"Q", 1}, :driver})

      Hoodride.Sweeper.sweep_now()

      assert members_of(1) == [{{"A", 1}, :driver}, {{"B", 1}, :driver}]
      assert Geo.agg_counts_for("A") == %{drivers: 1, hands: 0}
      assert Geo.agg_counts_for("Q") == %{drivers: 0, hands: 0}
    end
  end

  # the ETS writes `fun` makes, in order, as {function, table} (call tracing)
  defp traced_ets_writes(fun) do
    parent = self()
    funs = [:insert, :insert_new, :delete, :delete_object, :update_counter, :select_delete]
    for f <- funs, a <- [2, 3, 4], do: :erlang.trace_pattern({:ets, f, a}, true, [])

    shard = shard_of(3)
    :erlang.trace(shard, true, [:call])

    try do
      fun.()
      ref = :erlang.trace_delivered(shard)
      assert_receive {:trace_delivered, ^shard, ^ref}, 5_000
    after
      :erlang.trace(shard, false, [:call])
      for f <- funs, a <- [2, 3, 4], do: :erlang.trace_pattern({:ets, f, a}, false, [])
    end

    collect(shard, [], parent)
  end

  defp collect(shard, acc, parent) do
    receive do
      {:trace, ^shard, :call, {:ets, f, [table | _]}} ->
        collect(shard, [{f, table} | acc], parent)
    after
      0 -> Enum.reverse(acc)
    end
  end
end
