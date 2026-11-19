defmodule Hoodride.CellIndexTest do
  @moduledoc """
  The cell index ({cell, user_id} ordered_set): every write path keeps it
  exact, snapshots read it in O(log n + k) and agree with the old full
  scan, parallel writers can't corrupt it, and the sweeper repairs drift.
  """
  use ExUnit.Case

  alias Hoodride.Geo

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp prof(id), do: %{id: id, name: "U#{id}", photo: nil}
  defp idx(cell), do: :ets.match_object(:geo_by_cell, {{cell, :_}, :_}) |> Enum.sort()

  # the pre-index implementation, kept here as the reference oracle
  defp brute_snapshot(cell) do
    drivers =
      for {id, ^cell, spot, _} <- :ets.tab2list(:geo_drivers),
          do: %{id: id, cell: cell, spot: spot}

    hands =
      for {id, ^cell, spot} <- :ets.tab2list(:geo_hands), do: %{id: id, cell: cell, spot: spot}

    %{drivers: Enum.sort(drivers), hands: Enum.sort(hands)}
  end

  defp sorted(%{drivers: d, hands: h}), do: %{drivers: Enum.sort(d), hands: Enum.sort(h)}

  test "every write path keeps the index exact" do
    # driver arrives → one row
    Geo.driver_update(prof(1), "cA", nil)
    assert idx("cA") == [{{"cA", 1}, :driver}]

    # same-cell move → index untouched, still one row
    Geo.driver_update(prof(1), "cA", nil)
    assert idx("cA") == [{{"cA", 1}, :driver}]

    # crossing → row moves cells
    Geo.driver_update(prof(1), "cB", nil)
    assert idx("cA") == []
    assert idx("cB") == [{{"cB", 1}, :driver}]

    # offline → gone
    Geo.driver_offline(1)
    assert idx("cB") == []

    # hand up / re-raised elsewhere / down
    Geo.hand_up(2, "cC", "s1")
    assert idx("cC") == [{{"cC", 2}, :hand}]
    Geo.hand_up(2, "cD", "s2")
    assert idx("cC") == []
    assert idx("cD") == [{{"cD", 2}, :hand}]
    Geo.hand_down(2)
    assert idx("cD") == []
  end

  test "role changes (supply/demand exclusion) swap the index row cleanly" do
    Geo.hand_up(3, "cE", "s")
    Geo.driver_update(prof(3), "cF", nil)
    assert idx("cE") == []
    assert idx("cF") == [{{"cF", 3}, :driver}]

    Geo.hand_up(3, "cF", "s")
    assert idx("cF") == [{{"cF", 3}, :hand}]
  end

  test "indexed snapshots equal the old full-scan over a random world" do
    cells = for i <- 1..6, do: "c#{i}"

    for _ <- 1..400 do
      id = :rand.uniform(40)
      cell = Enum.random(cells)

      case :rand.uniform(4) do
        1 -> Geo.driver_update(prof(id), cell, nil)
        2 -> Geo.driver_offline(id)
        3 -> Geo.hand_up(id, cell, "s#{id}")
        4 -> Geo.hand_down(id)
      end
    end

    for cell <- cells do
      assert sorted(Geo.cell_snapshot(cell)) == brute_snapshot(cell)
    end

    Hoodride.TestHelpers.assert_world_invariants([], :geo)
  end

  test "parallel cell crossings in ONE crowded cell never lose or duplicate rows" do
    tasks =
      for id <- 1..32 do
        Task.async(fn ->
          for i <- 1..40 do
            cell = if rem(i, 2) == 0, do: "hot", else: "cold#{id}"
            Geo.driver_update(prof(id), cell, nil)
          end

          Geo.driver_update(prof(id), "hot", nil)
        end)
      end

    Task.await_many(tasks, 30_000)

    # no sweep: the writer path alone must leave the index exact
    assert length(idx("hot")) == 32
    assert length(Geo.cell_snapshot("hot").drivers) == 32
    Hoodride.TestHelpers.assert_world_invariants([], :geo)
  end

  test "a stale index row can never put a ghost in a snapshot" do
    Geo.driver_update(prof(7), "cG", nil)
    # corrupt: a leftover row claims driver 8 is in cG, but 8 doesn't exist
    :ets.insert(:geo_by_cell, {{"cG", 8}, :driver})
    # and one claims driver 7 is also in cH, where it is not
    :ets.insert(:geo_by_cell, {{"cH", 7}, :driver})

    assert [%{id: 7}] = Geo.cell_snapshot("cG").drivers
    assert Geo.cell_snapshot("cH").drivers == []
  end

  test "the sweeper repairs drift in both directions" do
    Geo.user_connected(9)
    Geo.user_connected(10)
    Geo.driver_update(prof(9), "cI", nil)
    Geo.hand_up(10, "cI", "s")

    # missing row + ghost row
    :ets.delete(:geo_by_cell, {"cI", 9})
    :ets.insert(:geo_by_cell, {{"cJ", 10}, :hand})
    refute Geo.cell_index_drift() == []

    Hoodride.Sweeper.sweep_now()

    assert Geo.cell_index_drift() == []
    assert idx("cI") == [{{"cI", 9}, :driver}, {{"cI", 10}, :hand}]
    assert idx("cJ") == []
  end

  # (full-scan audit, 2026-11-19: a person's repair found their index rows
  # by reading the whole index — {cell, user} has no leading user — inside
  # their writer shard, stalling its live map updates for the scan)
  test "repairing one person reads only their rows, however big the index" do
    # (the 50,000 gone after: a later module that doesn't scrub never sees them)
    on_exit(fn -> Hoodride.TestHelpers.scrub_live_state() end)
    Geo.user_connected(11)
    Geo.driver_update(prof(11), "cK", nil)
    # 50,000 others in the index (their backing rows aren't needed here)
    :ets.insert(:geo_by_cell, for(i <- 1..50_000, do: {{"zz#{i}", 5_000_000 + i}, :hand}))
    # a ghost beside the real row
    :ets.insert(:geo_by_cell, {{"cL", 11}, :driver})

    repair_one(11)
    assert_received {:repair_work, work}

    assert idx("cL") == []
    assert idx("cK") == [{{"cK", 11}, :driver}]
    assert work < 5_000, "#{work} reductions: the whole index read"
  end

  # the same for the area memberships (the counts' rows): {parent, user}
  test "repairing one person's memberships reads only their rows, however many there are" do
    # (the 50,000 gone after: a later module that doesn't scrub never sees them)
    on_exit(fn -> Hoodride.TestHelpers.scrub_live_state() end)
    Geo.user_connected(12)
    Geo.driver_update(prof(12), "cM", nil, ["pA", "pB"])
    mine = fn -> :ets.match_object(:geo_members, {{:_, 12}, :_}) |> Enum.sort() end
    assert mine.() == [{{"pA", 12}, :driver}, {{"pB", 12}, :driver}]
    :ets.insert(:geo_members, for(i <- 1..50_000, do: {{"zz#{i}", 6_000_000 + i}, :hand}))
    # a ghost membership, and a real one missing
    :ets.insert(:geo_members, {{"pZ", 12}, :driver})
    :ets.delete(:geo_members, {"pB", 12})

    repair_members_one(12)
    assert_received {:repair_work, work}

    assert mine.() == [{{"pA", 12}, :driver}, {{"pB", 12}, :driver}]
    assert work < 5_000, "#{work} reductions: every membership read"
  end

  # (full-scan audit, 2026-11-19: an unblock built the person's whole cell
  # to find their one marker) — by their keys, the same as the cell's list
  test "one person's marker by its keys: exactly as their cell's list shows it" do
    Geo.user_connected(13)
    Geo.user_connected(14)
    Geo.driver_update(prof(13), "cN", "cN-s")
    Geo.hand_up(14, "cN", "cN-h")
    snap = Geo.cell_snapshot("cN")
    assert Geo.marker(:drivers, 13) == Enum.find(snap.drivers, &(&1.id == 13))
    assert Geo.marker(:hands, 14) == Enum.find(snap.hands, &(&1.id == 14))
    assert Geo.marker(:drivers, 14) == nil
    assert Geo.marker(:hands, 13) == nil
    assert Geo.marker(:drivers, 999) == nil
    # not indexed in its cell: the list doesn't show it — neither does this
    :ets.delete(:geo_by_cell, {"cN", 13})
    assert Geo.cell_snapshot("cN").drivers == []
    assert Geo.marker(:drivers, 13) == nil
  end

  # (2026-11-19: a rider's area snapshot built the ✋ too, then kept only
  # the cars — in a crowded block, every ✋ looked up for nothing)
  test "an area's cars for a rider: the ✋ there aren't looked up" do
    # (the 5,000 gone after: a later module that doesn't scrub never sees them)
    on_exit(fn -> Hoodride.TestHelpers.scrub_live_state() end)
    Geo.user_connected(15)
    Geo.driver_update(prof(15), "cP", "cP-s")
    hands = for i <- 1..5_000, do: {7_000_000 + i, "cP-h#{i}"}
    :ets.insert(:geo_hands, for({id, spot} <- hands, do: {id, "cP", spot}))
    :ets.insert(:geo_by_cell, for({id, _} <- hands, do: {{"cP", id}, :hand}))

    {:reductions, a} = Process.info(self(), :reductions)
    cars = layer_snapshot("cP", :drivers)
    {:reductions, b} = Process.info(self(), :reductions)

    assert cars == [%{id: 15, cell: "cP", spot: "cP-s"}]
    assert length(layer_snapshot("cP", :hands)) == 5_000
    # (the old way: ~73,000 — each ✋ looked up; now the area's index walked,
    # one comparison a row: ~5,000)
    assert b - a < 15_000, "#{b - a} reductions: the area's ✋ looked up for a rider"
  end

  defp layer_snapshot(cell, layer), do: Geo.cell_snapshot(cell, layer)

  # the repair for one person, as the Sweeper runs it: the drift pass's
  # rows for them (the pass reads everything — that's its job, once a
  # minute), then the repair (inside their shard: here in the test's own
  # process, to count ITS work)
  defp repair_one(id) do
    seen = Map.get(Geo.cell_index_strays(), id, [])
    {:reductions, before} = Process.info(self(), :reductions)
    Geo.reindex_user_now(id, seen)
    {:reductions, later} = Process.info(self(), :reductions)
    send(self(), {:repair_work, later - before})
  end

  defp repair_members_one(id) do
    seen = Map.get(Geo.member_strays(), id, [])
    {:reductions, before} = Process.info(self(), :reductions)
    Geo.rebuild_members_now(id, seen)
    {:reductions, later} = Process.info(self(), :reductions)
    send(self(), {:repair_work, later - before})
  end
end
