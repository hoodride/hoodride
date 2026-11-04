# One full sweep, before vs after the select/paging rewrite, over a big
# HEALTHY world (nothing to act on — the pure cost of looking). "Before" is
# the old sweep's reads, kept verbatim (tab2list + filter in the process);
# the parts both versions share (index heals, the recount) run in both.
#
# Run: $env:MIX_ENV="test"; mix run bench/sweeper_select_bench.exs

defmodule OldSweep do
  alias Hoodride.Geo

  def sweep_now do
    cutoff = System.system_time(:second) - 300
    _ = :ride_requests |> :ets.tab2list() |> Enum.filter(fn {_, _, ts} -> ts < cutoff end)

    for {_u, ride_id} <- :ets.tab2list(:rides_by_user), ride_id != :pending,
        do: Hoodride.Rides.get(ride_id)

    now = System.system_time(:second)

    for {id, _c, _la, _ln, _p, ts} <- :ets.tab2list(:geo_drivers),
        past_grace?(id) or now - ts > 180,
        do: :act

    for {id, _c, _s} <- :ets.tab2list(:geo_hands), past_grace?(id), do: :act
    for {id, _c, _s} <- :ets.tab2list(:geo_hands), Geo.driver_on_map?(id), do: :act
    for {_u, ride_id} <- :ets.tab2list(:rides_by_user), ride_id != :pending, do: :act

    old_drift()

    for {r, d, _} <- :ets.tab2list(:ride_requests) do
      Hoodride.Rides.ride_id_of_user(r) || Hoodride.Rides.ride_id_of_user(d) ||
        Geo.driver_on_map?(d)
    end

    Hoodride.Requests.heal_index(300)

    for {{a, b}, _} <- :ets.tab2list(:chat_conversations) do
      Hoodride.Requests.open_between?(a, b) or (past_grace?(a) and past_grace?(b))
    end

    Hoodride.Chat.heal_index()
    Geo.recompute_aggregates()
  end

  defp old_drift do
    expected =
      MapSet.new(
        for({id, cell, _, _} <- :ets.tab2list(:geo_drivers), do: {{cell, id}, :driver}) ++
          for({id, cell, _} <- :ets.tab2list(:geo_hands), do: {{cell, id}, :hand})
      )

    actual = MapSet.new(:ets.tab2list(:geo_by_cell))
    MapSet.union(MapSet.difference(expected, actual), MapSet.difference(actual, expected))
  end

  defp past_grace?(id) do
    case Geo.presence_of(id) do
      {:online, _} -> false
      {:grace, since} -> System.system_time(:second) - since > 300
      {:offline, _} -> true
    end
  end
end

defmodule SweepBench do
  def world(n) do
    Hoodride.TestHelpers.scrub_live_state()
    now = System.system_time(:second)

    for id <- 1..n do
      cell = "c8-#{rem(id, 500)}"
      :ets.insert(:geo_drivers, {id, cell, cell, now})
      :ets.insert(:geo_by_cell, {{cell, id}, :driver})
      :ets.insert(:geo_presence, {id, :online, now})
      rider = 1_000_000 + id
      :ets.insert(:geo_presence, {rider, :online, now})
      :ets.insert(:ride_requests, {rider, id, now})
      :ets.insert(:requests_by_driver, {{id, rider}, now})
      :ets.insert(:rides_by_user, {2_000_000 + id, :pending})
      key = Hoodride.Chat.pair_key(id, rider)
      :ets.insert(:chat_conversations, {key, now})
      :ets.insert(:chat_by_user, [{{id, key}}, {{rider, key}}])
    end
  end

  def measure(fun) do
    parent = self()

    spawn(fn ->
      :erlang.garbage_collect()
      {:memory, m0} = Process.info(self(), :memory)
      {us, _} = :timer.tc(fun)
      {:memory, m1} = Process.info(self(), :memory)
      send(parent, {:done, us / 1000, (m1 - m0) / 1024})
    end)

    receive do
      {:done, ms, kb} -> {ms, kb}
    end
  end
end

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end

row = fn runs ->
  "#{Float.round(median.(Enum.map(runs, &elem(&1, 0))), 1)} ms, " <>
    "+#{round(median.(Enum.map(runs, &elem(&1, 1))))} KB"
end

IO.puts("#{System.schedulers_online()} schedulers | median of 5 | healthy world, nothing to act on\n")

for n <- [10_000, 50_000] do
  SweepBench.world(n)
  before = for _ <- 1..5, do: SweepBench.measure(&OldSweep.sweep_now/0)
  aft = for _ <- 1..5, do: SweepBench.measure(&Hoodride.Sweeper.sweep_now/0)
  true = :ets.info(:geo_drivers, :size) == n

  IO.puts(
    String.pad_leading("#{n} drivers", 15) <>
      " (+#{n} requests, conversations, seats) | before #{row.(before)} | after #{row.(aft)}"
  )
end

Hoodride.TestHelpers.scrub_live_state()
