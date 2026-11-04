# Verifies the ETS docs' claim: a cell bound INSIDE the key pattern narrows
# an ordered_set traversal; the same filter written as a guard does not.
# Run: mix run bench/prefix_vs_guard.exs

:ets.delete_all_objects(:geo_by_cell)
for id <- 1..10_000, do: :ets.insert(:geo_by_cell, {{"c#{rem(id, 2000)}", id}, :driver})

prefix = fn -> :ets.match_object(:geo_by_cell, {{"c42", :_}, :_}) end
guard = fn -> :ets.select(:geo_by_cell, [{{{:"$1", :_}, :_}, [{:==, :"$1", "c42"}], [:"$_"]}]) end

true = Enum.sort(prefix.()) == Enum.sort(guard.())

{p, _} = :timer.tc(fn -> for _ <- 1..2000, do: prefix.() end)
{g, _} = :timer.tc(fn -> for _ <- 1..2000, do: guard.() end)

IO.puts(
  "same results: yes | cell in key pattern: #{Float.round(p / 2000, 1)} us | " <>
    "cell in filter condition: #{Float.round(g / 2000, 1)} us | #{round(g / p)}x slower"
)
