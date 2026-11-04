defmodule Hoodride.RecountModelTest do
  @moduledoc """
  Correctness of BOTH recount strategies on the shared model
  (Hoodride.RecountModel). A strategy that fails any of these is out of the
  comparison, whatever its speed.
  """
  use ExUnit.Case

  @moduletag timeout: 180_000

  alias Hoodride.RecountModel, as: M

  # a row in the mode's own format, planted raw
  defp row(%M{mode: mode}, u, cells) when mode in [:pause, :batched], do: {u, cells}
  defp row(%M{}, u, cells), do: {u, cells, M.stamp(), nil}

  # every shard has finished everything queued before this call
  defp quiesce(m), do: Enum.each(M.shard_pids(m), &:sys.get_state/1)

  for mode <- [:pause, :versioned, :hybrid, :batched] do
    describe "#{mode}" do
      @mode mode

      setup do
        m = M.start(@mode)
        on_exit(fn -> M.stop(m) end)
        %{m: m}
      end

      test "a quiet, correct world: the recount finds nothing to heal", %{m: m} do
        for u <- 1..50, do: M.update(m, u, ["c#{rem(u, 5)}", "big#{rem(u, 2)}"])

        assert %{result: :ok, healed: 0} = M.recount(m)
        assert M.counts(m) == M.truth(m)
      end

      test "planted wrong counts are all healed when quiet", %{m: m} do
        for u <- 1..30, do: M.update(m, u, ["c#{rem(u, 3)}"])
        M.plant(m, "c0", 99)
        M.plant(m, "ghost", 7)
        :ets.delete(m.agg, "c1")

        assert %{result: :ok, healed: 3} = M.recount(m)
        assert M.counts(m) == M.truth(m)
      end

      test "a writer caught mid-MOVE is never double-counted", %{m: m} do
        # driver 1 moves cA → cB; driver 2 stays in cA (so a wrong decrement
        # of cA can't hide behind the floor at zero); 100 sits in a cold cell
        M.update(m, 1, ["cA"])
        M.update(m, 2, ["cA"])
        M.update(m, 100, ["cCold"])
        parent = self()

        writer =
          Task.async(fn -> M.call(m, 1, {:update_paused_mid_op, 1, ["cB"], parent}) end)

        # the torn moment: driver 1's row says cB, the counts still say cA=2
        assert_receive {:mid_op, shard}, 5_000

        # drift in a cell nobody is touching
        M.plant(m, "cCold", 42)
        r = M.recount(m)

        case @mode do
          # a shard stuck inside an op can't reach the pause: no read at all
          paused when paused in [:pause, :batched] ->
            assert r.result == :skipped
            assert M.counts(m)["cCold"] == 42

          # optimistic: the in-flight user's OLD and NEW cells wait, the
          # rest heal now. The hybrid's fallback pause can't reach the stuck
          # shard either, so it keeps exactly what the optimistic pass healed.
          stamped when stamped in [:versioned, :hybrid] ->
            assert r.result == :ok
            # the hybrid reports its fallback: it tried, and couldn't pause
            if Map.has_key?(r, :paused), do: assert(r.paused == :expired)
            assert M.counts(m)["cCold"] == 1
            assert M.counts(m)["cA"] == 2
            assert Map.get(M.counts(m), "cB") == nil
        end

        send(shard, :continue)
        Task.await(writer)

        # NO healing recount after: whatever the first recount wrote must
        # already be consistent with the finished move
        assert M.counts(m)["cA"] == 1
        assert M.counts(m)["cB"] == 1
        if @mode in [:versioned, :hybrid], do: assert(M.counts(m) == M.truth(m))
      end

      if mode == :batched do
        test "membership rows follow every crossing and offline exactly", %{m: m} do
          for u <- 1..30, do: M.update(m, u, ["c#{rem(u, 4)}", "big"])
          for u <- 1..30, rem(u, 3) == 0, do: M.update(m, u, ["c9", "big"])
          for u <- 1..30, rem(u, 5) == 0, do: M.offline(m, u)

          assert members_exactly_derived?(m)
          assert %{result: :ok, healed: 0} = M.recount(m)
        end

        test "many cells: every batch is checked and healed (no batch skipped)", %{m: m} do
          # 350 cells → 4 batches; drift planted in one cell of every batch
          for u <- 1..700, do: M.update(m, u, ["c#{rem(u, 350)}"])
          for c <- [0, 120, 230, 349], do: M.bump(m, "c#{c}", 5)

          assert %{result: :ok, healed: 4, skipped_cells: 0} = M.recount(m)
          assert M.counts(m) == M.truth(m)
        end

        test "one cell per pause, and a time budget per pause, both heal everything", %{m: m} do
          for u <- 1..300, do: M.update(m, u, ["c#{rem(u, 150)}"])

          for batch <- [
                1,
                {:budget_us, 200},
                {:ewma, 200},
                {:safe_ewma, 200},
                {:aimd, 200},
                :self_tune
              ] do
            for c <- [0, 75, 149], do: M.bump(m, "c#{c}", 5)
            r = M.recount(%{m | batch: batch})

            assert %{result: :ok, healed: 3, skipped_cells: 0} = r
            if batch == 1, do: assert(r.pauses == 150)
            assert M.counts(m) == M.truth(m)
          end
        end

        test "a stuck writer stops the recount after ONE failed pause, not one per batch",
             %{m: m} do
          for u <- 1..300, do: M.update(m, u, ["c#{rem(u, 150)}"])
          parent = self()

          writer =
            Task.async(fn -> M.call(m, 1, {:update_paused_mid_op, 1, ["cX"], parent}) end)

          assert_receive {:mid_op, shard}, 5_000

          # 150 cells at one per pause: waiting out the cap each time would be 37 s
          {us, r} = :timer.tc(fn -> M.recount(%{m | batch: 1}) end)

          assert r.result == :skipped
          assert r.pauses == 1
          assert us < 2_000_000

          send(shard, :continue)
          Task.await(writer)
        end

        test "a crash mid-update leaves membership rows rebuilt from the truth", %{m: m} do
          for u <- 1..10, do: M.update(m, u, ["c#{rem(u, 2)}"])
          catch_exit(M.call(m, 4, {:crash_mid_update, 4, ["cNew"]}))
          await_shards(m)

          assert members_exactly_derived?(m)
        end
      end

      if mode == :hybrid do
        test "nothing skipped → no pause at all", %{m: m} do
          for u <- 1..20, do: M.update(m, u, ["c#{rem(u, 4)}"])
          M.plant(m, "c0", 99)

          assert %{result: :ok, paused: false, healed: 1} = M.recount(m)
          assert M.counts(m) == M.truth(m)
        end

        test "a move inside the window: optimistic skips, the fallback pause heals it all",
             %{m: m} do
          M.update(m, 1, ["cA"])
          M.update(m, 2, ["cA"])
          # drift IN a cell the move will touch: only the fallback can heal it
          M.plant(m, "cA", 40)

          r = M.recount(m, after_first_read: fn -> M.update(m, 1, ["cB"]) end)

          assert r.paused == true
          assert r.skipped_cells == 0
          assert M.counts(m) == M.truth(m)
          assert M.counts(m) == %{"cA" => 1, "cB" => 1}
        end
      end

      if mode == :versioned do
        test "a move that completes INSIDE the read window makes its user unstable", %{m: m} do
          M.update(m, 1, ["cA"])
          M.update(m, 2, ["cA"])

          r =
            M.recount(m,
              after_first_read: fn -> M.update(m, 1, ["cB"]) end
            )

          # driver 1's cells differ between the reads: cA and cB both wait
          assert r.skipped_cells == 2
          assert M.counts(m) == M.truth(m)
        end

        test "ABA: a person passing THROUGH a cell inside the window, then a newcomer, isn't lost",
             %{m: m} do
          # D starts with one stable member, so its count is 1
          M.update(m, 9, ["D"])
          M.update(m, 1, ["C"])

          M.recount(m,
            # person 1 moves C → D: D reads as 2 in the count snapshot...
            after_first_read: fn -> M.update(m, 1, ["D"]) end,
            # ...then moves on D → E before the second people read, so
            # neither people read ever shows person 1 in D
            after_counts: fn -> M.update(m, 1, ["E"]) end,
            # a newcomer enters D: D's count is back to exactly what was read
            after_second_read: fn -> M.update(m, 2, ["D"]) end
          )

          # truth: 9 and 2 are in D
          assert M.counts(m)["D"] == 2
          assert M.counts(m) == M.truth(m)
        end

        test "a move away and BACK inside the window (same cells, new stamp) heals nothing wrong",
             %{m: m} do
          M.update(m, 1, ["cA"])
          M.update(m, 2, ["cA"])

          # the counts are read in the middle state: cA=1, cB=1
          M.recount(m,
            after_first_read: fn -> M.update(m, 1, ["cB"]) end,
            after_counts: fn -> M.update(m, 1, ["cA"]) end
          )

          assert M.counts(m) == M.truth(m)
          assert M.counts(m) == %{"cA" => 2}
        end
      end

      test "a crash between the parents write and the count shift is healed", %{m: m} do
        for u <- 1..10, do: M.update(m, u, ["c#{rem(u, 2)}"])

        catch_exit(M.call(m, 3, {:crash_mid_update, 3, ["cNew"]}))
        await_shards(m)

        # :versioned may hand an orphan to its shard: give that a round
        M.recount(m)
        quiesce(m)
        M.recount(m)

        assert M.counts(m) == M.truth(m)
        # no row is left half-updated
        refute Enum.any?(:ets.tab2list(m.parents), &match?({_, _, _, {:pending, _}}, &1))
      end

      test "an orphan (row with no map row) is removed and stops counting", %{m: m} do
        M.update(m, 1, ["cA"])
        :ets.insert(m.parents, row(m, 2, ["cA"]))
        M.bump(m, "cA", 1)
        # a real :batched orphan has its membership row (a restarted shard
        # rebuilds them from the parents rows)
        if @mode == :batched, do: :ets.insert(m.members, {{"cA", 2}})

        M.recount(m)
        quiesce(m)

        # right after ONE recount plus the orphan's removal: already exact
        # (healing the cell AND removing the orphan would subtract it twice)
        assert M.counts(m) == %{"cA" => 1}

        M.recount(m)

        assert :ets.lookup(m.parents, 2) == []
        assert M.counts(m) == %{"cA" => 1}
      end

      test "duel: recounts fired into a toggling driver stay exact, 40 rounds", %{m: m} do
        for _round <- 1..40 do
          toggler =
            Task.async(fn ->
              for i <- 1..10 do
                M.update(m, 7, ["cD#{rem(i, 3)}", "cBig"])
                M.offline(m, 7)
              end

              M.update(m, 7, ["cD0", "cBig"])
            end)

          healer = Task.async(fn -> for _ <- 1..4, do: M.recount(m) end)
          Task.await_many([toggler, healer], 30_000)

          # no sweep after: the recounts themselves must never have broken it
          assert M.counts(m) == M.truth(m)
          M.offline(m, 7)
        end
      end

      test "storm: 8 writers × random ops with recounts firing throughout", %{m: m} do
        stop = :atomics.new(1, [])

        recounter =
          Task.async(fn ->
            Stream.repeatedly(fn -> M.recount(m) end)
            |> Enum.take_while(fn _ -> :atomics.get(stop, 1) == 0 end)
            |> length()
          end)

        writers =
          for w <- 1..8 do
            Task.async(fn ->
              :rand.seed(:exsss, {w, 7, 7})

              for _ <- 1..1_500 do
                u = :rand.uniform(40)

                if :rand.uniform(4) == 1,
                  do: M.offline(m, u),
                  else: M.update(m, u, ["c#{:rand.uniform(12)}", "big#{:rand.uniform(3)}"])
              end
            end)
          end

        Task.await_many(writers, 120_000)
        :atomics.put(stop, 1, 1)
        recounts = Task.await(recounter, 60_000)
        quiesce(m)

        assert recounts > 0
        # BEFORE any final recount: no recount ever made a count wrong
        assert M.counts(m) == M.truth(m)
        if @mode == :batched, do: assert(members_exactly_derived?(m))
        assert %{healed: 0} = M.recount(m)
      end
    end
  end

  # :batched's index invariant: membership rows are exactly {cell, u} for
  # every cell of every parents row — no missing row, no stray row
  defp members_exactly_derived?(m) do
    expected =
      for {u, cells} <- :ets.tab2list(m.parents), c <- cells, into: MapSet.new(), do: {{c, u}}

    expected == MapSet.new(:ets.tab2list(m.members))
  end

  defp await_shards(m, tries \\ 200) do
    if length(M.shard_pids(m)) == m.shards or tries == 0 do
      :ok
    else
      Process.sleep(5)
      await_shards(m, tries - 1)
    end
  end
end
