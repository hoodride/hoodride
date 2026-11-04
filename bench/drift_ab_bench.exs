# A/B/C for Geo.cell_index_drift, interleaved round by round so background
# load hits every variant alike. Reports min (least disturbed) and median.
#   old  — whole-row lookups, all three passes (the previous code, verbatim)
#   A    — one-field lookups (lookup_element/4), all three passes
#   now  — the live Geo.cell_index_drift (A + count-based skip of pass 3)
#
# Run: $env:MIX_ENV="test"; mix run bench/drift_ab_bench.exs

import Hoodride.ETS, only: [fold_match: 4]

n = 50_000
Hoodride.TestHelpers.scrub_live_state()
now = System.system_time(:second)

for id <- 1..n do
  cell = "c8-#{rem(id, 500)}"
  :ets.insert(:geo_drivers, {id, cell, cell, now})
  :ets.insert(:geo_by_cell, {{cell, id}, :driver})
end

for id <- 1..div(n, 5) do
  hand = 300_000 + id
  cell = "c8-h#{rem(id, 200)}"
  :ets.insert(:geo_hands, {hand, cell, "spot"})
  :ets.insert(:geo_by_cell, {{cell, hand}, :hand})
end

old = fn ->
  s =
    fold_match(:geo_drivers, [{{:"$1", :"$2", :_, :_}, [], [{{:"$1", :"$2"}}]}], [], fn
      {id, cell}, acc ->
        if :ets.lookup(:geo_by_cell, {cell, id}) == [{{cell, id}, :driver}], do: acc, else: [id | acc]
    end)

  s =
    fold_match(:geo_hands, [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}], s, fn
      {id, cell}, acc ->
        if :ets.lookup(:geo_by_cell, {cell, id}) == [{{cell, id}, :hand}], do: acc, else: [id | acc]
    end)

  fold_match(:geo_by_cell, [{:"$1", [], [:"$1"]}], s, fn
    {{cell, id}, :driver}, acc ->
      if match?([{_, ^cell, _, _}], :ets.lookup(:geo_drivers, id)), do: acc, else: [id | acc]

    {{cell, id}, :hand}, acc ->
      if match?([{_, ^cell, _}], :ets.lookup(:geo_hands, id)), do: acc, else: [id | acc]
  end)
  |> Enum.uniq()
end

a = fn ->
  s =
    fold_match(:geo_drivers, [{{:"$1", :"$2", :_, :_}, [], [{{:"$1", :"$2"}}]}], [], fn
      {id, cell}, acc ->
        if :ets.lookup_element(:geo_by_cell, {cell, id}, 2, nil) == :driver, do: acc, else: [id | acc]
    end)

  s =
    fold_match(:geo_hands, [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}], s, fn
      {id, cell}, acc ->
        if :ets.lookup_element(:geo_by_cell, {cell, id}, 2, nil) == :hand, do: acc, else: [id | acc]
    end)

  fold_match(:geo_by_cell, [{:"$1", [], [:"$1"]}], s, fn
    {{cell, id}, :driver}, acc ->
      if :ets.lookup_element(:geo_drivers, id, 2, nil) == cell, do: acc, else: [id | acc]

    {{cell, id}, :hand}, acc ->
      if :ets.lookup_element(:geo_hands, id, 2, nil) == cell, do: acc, else: [id | acc]
  end)
  |> Enum.uniq()
end

variants = [{"old", old}, {"A (one-field lookups)", a}, {"now (A + count skip)", &Hoodride.Geo.cell_index_drift/0}]

# all three agree on a healthy world
[[], [], []] = for {_, f} <- variants, do: f.()

run = fn f -> Task.async(fn -> elem(:timer.tc(f), 0) / 1000 end) |> Task.await(:infinity) end

times =
  for _round <- 1..15, {name, f} <- variants, reduce: %{} do
    acc -> Map.update(acc, name, [run.(f)], &[run.(f) | &1])
  end

IO.puts("cell_index_drift, #{n} drivers + #{div(n, 5)} hands | 15 interleaved rounds\n")

for {name, _} <- variants do
  ts = Enum.sort(times[name])

  IO.puts(
    String.pad_trailing(name, 26) <>
      "min #{:erlang.float_to_binary(hd(ts), decimals: 1)} ms" <>
      "   median #{:erlang.float_to_binary(Enum.at(ts, 7), decimals: 1)} ms"
  )
end

Hoodride.TestHelpers.scrub_live_state()
