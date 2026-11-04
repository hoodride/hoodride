defmodule Hoodride.SweeperMemoryTest do
  @moduledoc """
  The sweep reads every table, but copies only what it acts on: conditions
  run inside ETS (match specs) and matches arrive a page at a time, so a
  sweep's memory doesn't grow with the size of the world.
  """
  use ExUnit.Case

  @moduletag timeout: 120_000

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  @scanned [
    :geo_drivers,
    :geo_hands,
    :geo_by_cell,
    :geo_presence,
    :ride_requests,
    :requests_by_driver,
    :rides_by_user,
    :chat_conversations,
    :chat_by_user
  ]

  # a big, healthy world: everyone fresh and present, nothing to act on
  defp healthy_world(n) do
    now = System.system_time(:second)

    for id <- 1..n do
      cell = "c8-#{rem(id, 500)}"
      :ets.insert(:geo_drivers, {id, cell, cell, now})
      :ets.insert(:geo_by_cell, {{cell, id}, :driver})
      :ets.insert(:geo_presence, {id, :online, now})

      rider = 100_000 + id
      :ets.insert(:geo_presence, {rider, :online, now})
      :ets.insert(:ride_requests, {rider, id, now})
      :ets.insert(:requests_by_driver, {{id, rider}, now})
      # seats claimed by a ride still being set up
      :ets.insert(:rides_by_user, {200_000 + id, :pending})

      key = Hoodride.Chat.pair_key(id, rider)
      :ets.insert(:chat_conversations, {key, now})
      :ets.insert(:chat_by_user, [{{id, key}}, {{rider, key}}])
    end

    for id <- 1..div(n, 5) do
      hand = 300_000 + id
      cell = "c8-h#{rem(id, 200)}"
      :ets.insert(:geo_hands, {hand, cell, "spot"})
      :ets.insert(:geo_by_cell, {{cell, hand}, :hand})
      :ets.insert(:geo_presence, {hand, :online, now})
    end
  end

  defp bytes(table), do: :ets.info(table, :memory) * :erlang.system_info(:wordsize)

  defp heap_growth_bytes(fun) do
    parent = self()

    spawn(fn ->
      :erlang.garbage_collect()
      {:memory, before} = Process.info(self(), :memory)
      fun.()
      {:memory, aft} = Process.info(self(), :memory)
      send(parent, {:grew, aft - before})
    end)

    receive do
      {:grew, b} -> b
    end
  end

  test "a sweep over a big healthy world copies a small fraction of what it scans" do
    healthy_world(10_000)
    sizes = Map.new(@scanned, &{&1, bytes(&1)})

    grew = heap_growth_bytes(fn -> Hoodride.Sweeper.sweep_now() end)
    total = sizes |> Map.values() |> Enum.sum()

    assert grew < div(total, 10),
           "one sweep grew #{grew} B while scanning #{total} B of tables #{inspect(sizes)}"

    # and it acted on nothing: the world was healthy
    assert :ets.info(:geo_drivers, :size) == 10_000
    assert :ets.info(:ride_requests, :size) == 10_000
    assert :ets.info(:chat_conversations, :size) == 10_000
  end

  # The filters now run inside ETS, so their exact edges get their own
  # tests. Start well inside a wall-clock second, so "now" can't tick over
  # between planting a row and the sweep reading it.
  defp fresh_second do
    if rem(System.system_time(:millisecond), 1000) > 500 do
      fresh_second()
    else
      System.system_time(:second)
    end
  end

  describe "filter edges" do
    test "a request expires one second PAST the TTL, not at it" do
      now = fresh_second()
      :ets.insert(:ride_requests, {1, 10, now - 300})
      :ets.insert(:ride_requests, {2, 10, now - 301})

      Hoodride.Requests.expire_older_than(300)

      assert Hoodride.Requests.open_request_of(1) != nil
      assert Hoodride.Requests.open_request_of(2) == nil
    end

    test "a driver is frozen one second PAST 3 minutes of silence, not at it" do
      now = fresh_second()

      for {id, ts} <- [{1, now - 180}, {2, now - 181}] do
        :ets.insert(:geo_presence, {id, :online, now})
        :ets.insert(:geo_drivers, {id, "c8", "c8", ts})
        :ets.insert(:geo_by_cell, {{"c8", id}, :driver})
      end

      Hoodride.Sweeper.sweep_now()

      assert Hoodride.Geo.driver_on_map?(1)
      refute Hoodride.Geo.driver_on_map?(2)
    end

    test "a hand is reaped one second PAST the 5-minute grace, not at it" do
      now = fresh_second()

      for {id, since} <- [{1, now - 300}, {2, now - 301}] do
        :ets.insert(:geo_presence, {id, :grace, since})
        :ets.insert(:geo_hands, {id, "c8", "spot"})
        :ets.insert(:geo_by_cell, {{"c8", id}, :hand})
      end

      Hoodride.Sweeper.sweep_now()

      assert :ets.member(:geo_hands, 1)
      refute :ets.member(:geo_hands, 2)
    end

    test "a seat still being set up (:pending) is never treated as an active ride" do
      now = System.system_time(:second)
      :ets.insert(:geo_presence, {5, :online, now})
      :ets.insert(:geo_drivers, {5, "c8", "c8", now})
      :ets.insert(:geo_by_cell, {{"c8", 5}, :driver})
      :ets.insert(:rides_by_user, {5, :pending})

      Hoodride.Sweeper.sweep_now()

      # not a mid-ride ghost, and not an orphaned seat
      assert Hoodride.Geo.driver_on_map?(5)
      assert :ets.lookup(:rides_by_user, 5) == [{5, :pending}]
    end

    test "cell index drift finds each kind of drift, and only those users" do
      # healthy driver and hand
      :ets.insert(:geo_drivers, {1, "cA", "cA", 0})
      :ets.insert(:geo_by_cell, {{"cA", 1}, :driver})
      :ets.insert(:geo_hands, {2, "cA", "s"})
      :ets.insert(:geo_by_cell, {{"cA", 2}, :hand})
      # missing index row
      :ets.insert(:geo_drivers, {3, "cB", "cB", 0})
      # stray index row, nobody behind it
      :ets.insert(:geo_by_cell, {{"cC", 4}, :driver})
      # wrong role in the index
      :ets.insert(:geo_drivers, {5, "cD", "cD", 0})
      :ets.insert(:geo_by_cell, {{"cD", 5}, :hand})
      # index row in the wrong cell
      :ets.insert(:geo_hands, {6, "cE", "s"})
      :ets.insert(:geo_by_cell, {{"cF", 6}, :hand})

      # car AND hand in one cell (two-tab residue): the index row can carry
      # only one role, so the other one is drift
      :ets.insert(:geo_drivers, {7, "cG", "cG", 0})
      :ets.insert(:geo_hands, {7, "cG", "s"})
      :ets.insert(:geo_by_cell, {{"cG", 7}, :driver})

      assert Enum.sort(Hoodride.Geo.cell_index_drift()) == [3, 4, 5, 6, 7]
    end

    test "cell index drift finds a lone stray row (the count-skip must not hide it)" do
      :ets.insert(:geo_drivers, {1, "cA", "cA", 0})
      :ets.insert(:geo_by_cell, {{"cA", 1}, :driver})
      # passes 1–2 are clean; only the counts reveal this one
      :ets.insert(:geo_by_cell, {{"cZ", 9}, :hand})

      assert Hoodride.Geo.cell_index_drift() == [9]
    end

    # each case ALONE: the only drift, counts still equal, so the cell
    # comparison in the first pass is the only thing that can catch it
    test "cell index drift: a lone driver indexed under the wrong cell is found" do
      :ets.insert(:geo_drivers, {5, "cD", "cD", 0})
      :ets.insert(:geo_by_cell, {{"cX", 5}, :driver})

      assert Hoodride.Geo.cell_index_drift() == [5]
    end

    test "cell index drift: a lone hand indexed under the wrong cell is found" do
      :ets.insert(:geo_hands, {6, "cE", "s"})
      :ets.insert(:geo_by_cell, {{"cF", 6}, :hand})

      assert Hoodride.Geo.cell_index_drift() == [6]
    end

    test "cell index drift: a stray row on a later page is found" do
      # well over two pages of healthy rows, then one stray that sorts last
      for id <- 1..1_200 do
        :ets.insert(:geo_drivers, {id, "cA", "cA", 0})
        :ets.insert(:geo_by_cell, {{"cA", id}, :driver})
      end

      :ets.insert(:geo_by_cell, {{"zz-last", 9_999}, :driver})

      assert Hoodride.Geo.cell_index_drift() == [9_999]
    end

    test "request index: a row naming the wrong driver (counts still equal) is fixed" do
      now = System.system_time(:second)
      # rider 1 is waiting on driver 20, but the only index row says driver 10
      :ets.insert(:ride_requests, {1, 20, now})
      :ets.insert(:requests_by_driver, {{10, 1}, now - 1_000})

      Hoodride.Requests.heal_index(300)

      assert :ets.tab2list(:requests_by_driver) == [{{20, 1}, now}]
      assert [%{rider_id: 1}] = Hoodride.Requests.pending_for_driver(20)
    end

    test "cell index drift on a clean world finds nothing (the skip path)" do
      for id <- 1..50 do
        :ets.insert(:geo_drivers, {id, "c#{rem(id, 7)}", "c#{rem(id, 7)}", 0})
        :ets.insert(:geo_by_cell, {{"c#{rem(id, 7)}", id}, :driver})
      end

      assert Hoodride.Geo.cell_index_drift() == []
    end

    test "chat index: a stale row is dropped even when a missing pair would balance the count" do
      now = System.system_time(:second)
      # a conversation with NO index rows (2 missing)...
      live = Hoodride.Chat.pair_key(1, 2)
      :ets.insert(:chat_conversations, {live, now})
      # ...and two stale rows for a conversation that's gone (2 extra)
      gone = Hoodride.Chat.pair_key(3, 4)
      :ets.insert(:chat_by_user, [{{3, gone}}, {{4, gone}}])

      Hoodride.Chat.heal_index()

      assert Enum.sort(:ets.tab2list(:chat_by_user)) == [{{1, live}}, {{2, live}}]
    end

    test "chat index: a row filed under someone outside the conversation is dropped" do
      key = Hoodride.Chat.pair_key(1, 2)
      :ets.insert(:chat_conversations, {key, System.system_time(:second)})
      # the two right rows, plus one under user 99 — only a bug could write it
      :ets.insert(:chat_by_user, [{{1, key}}, {{2, key}}, {{99, key}}])

      Hoodride.Chat.heal_index()

      assert Enum.sort(:ets.tab2list(:chat_by_user)) == [{{1, key}}, {{2, key}}]
      assert Hoodride.Chat.conversations_for(99) == []
    end

    test "a connected user is never past grace, whatever their stored clock says" do
      # stored clock from long ago, but a live channel registration right now
      :ets.insert(:geo_presence, {7, :grace, System.system_time(:second) - 10_000})
      :ets.insert(:geo_hands, {7, "c8", "spot"})
      :ets.insert(:geo_by_cell, {{"c8", 7}, :hand})
      {:ok, _} = Registry.register(Hoodride.UserChannels, 7, nil)

      Hoodride.Sweeper.sweep_stale_geo()

      assert :ets.member(:geo_hands, 7)
      Registry.unregister(Hoodride.UserChannels, 7)
    end

    test "a user with no presence row at all is treated as long gone" do
      :ets.insert(:geo_hands, {8, "c8", "spot"})
      :ets.insert(:geo_by_cell, {{"c8", 8}, :hand})

      Hoodride.Sweeper.sweep_stale_geo()

      refute :ets.member(:geo_hands, 8)
    end

    test "the recount's tallies count drivers and hands per cell exactly" do
      prof = fn id -> %{id: id, name: "P#{id}", photo: nil} end

      # through the real write paths, which keep membership in step
      Hoodride.Geo.driver_update(prof.(1), "c8", nil, ["cX", "cY"])
      Hoodride.Geo.driver_update(prof.(2), "c8", nil, ["cX"])
      Hoodride.Geo.hand_up(3, "c8", "s", ["cX", "cZ"])

      # stored tallies all wrong: the recount must rebuild every one
      :ets.insert(:geo_agg, [{"cX", 9, 9}, {"cY", 9, 9}, {"cZ", 9, 9}])
      assert Hoodride.Geo.recompute_aggregates() == :ok

      assert Hoodride.Geo.agg_counts_for("cX") == %{drivers: 2, hands: 1}
      assert Hoodride.Geo.agg_counts_for("cY") == %{drivers: 1, hands: 0}
      assert Hoodride.Geo.agg_counts_for("cZ") == %{drivers: 0, hands: 1}
    end

    test "request index: a stale row is dropped even when a missing one would balance the count" do
      now = System.system_time(:second)
      # a request with no index row (1 missing)...
      :ets.insert(:ride_requests, {1, 10, now})
      # ...and an old stale row with no request behind it (1 extra)
      :ets.insert(:requests_by_driver, {{20, 2}, now - 1_000})

      Hoodride.Requests.heal_index(300)

      assert :ets.tab2list(:requests_by_driver) == [{{10, 1}, now}]
    end

    test "a seat pointing at a dead ride is reclaimed; a live ride's is kept" do
      # no ride process is registered under this id: it died without cleanup
      :ets.insert(:rides_by_user, {8, "ride-that-died"})

      Hoodride.Sweeper.sweep_now()

      assert :ets.lookup(:rides_by_user, 8) == []
    end

    test "passes act on EVERY match, across many pages, not just the first page" do
      # well over two pages of expired requests
      old = System.system_time(:second) - 10_000
      for rider <- 1..1_200, do: :ets.insert(:ride_requests, {rider, 10, old})

      Hoodride.Requests.expire_older_than(300)

      assert :ets.info(:ride_requests, :size) == 0
    end
  end
end
