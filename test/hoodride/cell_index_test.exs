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
end
