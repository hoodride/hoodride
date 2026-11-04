# The hex recount, broken into its parts on a 50k world (every user counted
# in 2 parent cells, ~2,100 cells), plus alternative ways to tally.
# Interleaved rounds; min and median.
#
# Run: $env:MIX_ENV="test"; mix run bench/recount_parts_bench.exs

n = 50_000
Hoodride.TestHelpers.scrub_live_state()

for id <- 1..n do
  :ets.insert(:geo_drivers, {id, "c8", "c8", 0})
  :ets.insert(:geo_parents, {id, :driver, ["c7-#{rem(id, 2000)}", "c5-#{rem(id, 100)}"]})
end

:ok = Hoodride.Geo.recompute_aggregates()
parents = :ets.tab2list(:geo_parents)

tally = fn
  :driver, {d, h} -> {d + 1, h}
  :hand, {d, h} -> {d, h + 1}
end

variants = [
  # what runs inside the writer pause today
  {"pause: copy parents + map-row check", fn ->
     :ets.tab2list(:geo_parents)
     |> Enum.split_with(fn {id, :driver, _} -> :ets.member(:geo_drivers, id) end)
   end},
  {"pause: copy tallies table", fn -> :ets.tab2list(:geo_agg) end},
  # tally variants, all on the same copied list
  {"tally: today (nested reduce, {d,h} tuples)", fn ->
     Enum.reduce(parents, %{}, fn {_u, role, cells}, acc ->
       Enum.reduce(cells, acc, fn cell, a -> Map.update(a, cell, tally.(role, {0, 0}), &tally.(role, &1)) end)
     end)
   end},
  {"tally: flat list + Enum.frequencies", fn ->
     for({_u, role, cells} <- parents, cell <- cells, do: {cell, role}) |> Enum.frequencies()
   end},
  {"tally: recursion, integer counter per {cell, role}", fn ->
     count = fn
       [], acc, _f -> acc
       [{_u, role, cells} | rest], acc, f ->
         acc = Enum.reduce(cells, acc, fn c, a -> Map.update(a, {c, role}, 1, &(&1 + 1)) end)
         f.(rest, acc, f)
     end

     count.(parents, %{}, count)
   end},
  {"tally: private ETS set + update_counter", fn ->
     t = :ets.new(:tally_probe, [:set, :private])

     for {_u, role, cells} <- parents, cell <- cells,
         do: :ets.update_counter(t, {cell, role}, 1, {{cell, role}, 0})

     r = :ets.tab2list(t)
     :ets.delete(t)
     r
   end},
  {"compare + heal (nothing to heal)", fn -> :ok = Hoodride.Geo.recompute_aggregates() end}
]

run = fn f -> Task.async(fn -> elem(:timer.tc(f), 0) / 1000 end) |> Task.await(:infinity) end

times =
  for _ <- 1..11, {name, f} <- variants, reduce: %{} do
    acc -> Map.update(acc, name, [run.(f)], &[run.(f) | &1])
  end

IO.puts("recount parts, #{n} users x 2 parent cells | 11 interleaved rounds\n")

for {name, _} <- variants do
  ts = Enum.sort(times[name])

  IO.puts(
    String.pad_trailing(name, 52) <>
      "min " <> String.pad_leading(:erlang.float_to_binary(hd(ts), decimals: 1), 6) <>
      "   median " <> String.pad_leading(:erlang.float_to_binary(Enum.at(ts, 5), decimals: 1), 6)
  )
end

Hoodride.TestHelpers.scrub_live_state()
