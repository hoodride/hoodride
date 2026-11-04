# Recount without copying: today's copy-out (tab2list the user-keyed parents
# table, filter, tally in the process) vs counting IN PLACE over a
# cell-keyed membership ordered_set ({{cell, user_id}, role}) with
# :ets.select_count per cell — only counts leave ETS, never rows.
#
# Measures the work done while writers are paused, and how much memory the
# recount process grows by (process heap, no GC in between).
#
# Run: mix run --no-start bench/recount_copy_bench.exs

defmodule CopyBench do
  def build(n) do
    for t <- [:b_drivers, :b_hands, :b_parents, :b_members, :b_agg] do
      if :ets.whereis(t) != :undefined, do: :ets.delete(t)
    end

    :ets.new(:b_drivers, [:named_table, :public, :set])
    :ets.new(:b_hands, [:named_table, :public, :set])
    :ets.new(:b_parents, [:named_table, :public, :set])
    :ets.new(:b_members, [:named_table, :public, :ordered_set])
    :ets.new(:b_agg, [:named_table, :public, :set])

    # half drivers, half hands, two parent cells each (res 7 + res 5)
    for id <- 1..n do
      parents = ["c7-#{rem(id, 2_000)}", "c5-#{rem(id, 100)}"]
      role = if rem(id, 2) == 0, do: :driver, else: :hand

      if role == :driver,
        do: :ets.insert(:b_drivers, {id, "c8-#{id}", 1.0, 2.0, %{name: "d#{id}", photo: nil}, 0}),
        else: :ets.insert(:b_hands, {id, "c8-#{id}", "c9-#{id}"})

      :ets.insert(:b_parents, {id, role, parents})
      for c <- parents, do: :ets.insert(:b_members, {{c, id}, role})

      for c <- parents do
        pos = if role == :driver, do: 2, else: 3
        :ets.update_counter(:b_agg, c, {pos, 1}, {c, 0, 0})
      end
    end
  end

  # today: copy everything out while paused (tally runs after the release)
  def copy_out do
    live =
      Enum.filter(:ets.tab2list(:b_parents), fn
        {id, :driver, _} -> :ets.member(:b_drivers, id)
        {id, :hand, _} -> :ets.member(:b_hands, id)
      end)

    {live, :ets.tab2list(:b_agg)}
  end

  # new: walk cells by key, count each cell's range inside ETS, compare to
  # its stored tally — collects only the cells that disagree
  def in_place, do: walk(:ets.first(:b_members), []) |> agg_only_cells()

  defp walk(:"$end_of_table", bad), do: bad

  defp walk({cell, _}, bad) do
    d = :ets.select_count(:b_members, [{{{cell, :_}, :driver}, [], [true]}])
    h = :ets.select_count(:b_members, [{{{cell, :_}, :hand}, [], [true]}])

    bad =
      case :ets.lookup(:b_agg, cell) do
        [{_, ^d, ^h}] -> bad
        _ -> [{cell, d, h} | bad]
      end

    # every {cell, integer_id} sorts before {cell, atom}: jump to the next cell
    walk(:ets.next(:b_members, {cell, :end}), bad)
  end

  # variant: ONE range read per cell returning only the role atoms (atoms are
  # immediates, so this copies a short list of words, never a row)
  def in_place_roles, do: walk_roles(:ets.first(:b_members), []) |> agg_only_cells()

  defp walk_roles(:"$end_of_table", bad), do: bad

  defp walk_roles({cell, _}, bad) do
    {d, h} =
      :ets.select(:b_members, [{{{cell, :_}, :"$1"}, [], [:"$1"]}])
      |> Enum.reduce({0, 0}, fn
        :driver, {d, h} -> {d + 1, h}
        :hand, {d, h} -> {d, h + 1}
      end)

    bad =
      case :ets.lookup(:b_agg, cell) do
        [{_, ^d, ^h}] -> bad
        _ -> [{cell, d, h} | bad]
      end

    walk_roles(:ets.next(:b_members, {cell, :end}), bad)
  end

  # tally rows whose cell has no members at all (a stale nonzero count)
  defp agg_only_cells(bad), do: agg_walk(:ets.first(:b_agg), bad)

  defp agg_walk(:"$end_of_table", bad), do: bad

  defp agg_walk(cell, bad) do
    bad =
      case :ets.next(:b_members, {cell, -1}) do
        {^cell, _} -> bad
        _ -> [{cell, 0, 0} | bad]
      end

    agg_walk(:ets.next(:b_agg, cell), bad)
  end

  # run fun in a fresh process: wall time + how much its memory grew
  def measure(fun) do
    parent = self()

    spawn(fn ->
      :erlang.garbage_collect()
      {:memory, m0} = Process.info(self(), :memory)
      {us, result} = :timer.tc(fun)
      {:memory, m1} = Process.info(self(), :memory)
      send(parent, {:done, us / 1000, (m1 - m0) / 1024, result})
    end)

    receive do
      {:done, ms, kb, result} -> {ms, kb, result}
    end
  end
end

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end

IO.puts("#{System.schedulers_online()} schedulers | median of 7 | world consistent (nothing to heal)\n")

for n <- [1_000, 10_000, 50_000, 200_000] do
  CopyBench.build(n)

  # sanity: the in-place walk finds a consistent world consistent...
  {_, _, []} = CopyBench.measure(&CopyBench.in_place/0)
  # ...and finds planted drift
  :ets.insert(:b_agg, {"c7-5", 99, 0})
  {_, _, [{"c7-5", _, _}]} = CopyBench.measure(&CopyBench.in_place/0)
  :ets.delete(:b_agg, "c7-5")
  CopyBench.build(n)

  a = for _ <- 1..7, do: CopyBench.measure(&CopyBench.copy_out/0)
  b = for _ <- 1..7, do: CopyBench.measure(&CopyBench.in_place/0)
  c = for _ <- 1..7, do: CopyBench.measure(&CopyBench.in_place_roles/0)
  {_, _, []} = CopyBench.measure(&CopyBench.in_place_roles/0)

  row = fn runs ->
    "#{Float.round(median.(Enum.map(runs, &elem(&1, 0))), 1)} ms, " <>
      "+#{round(median.(Enum.map(runs, &elem(&1, 1))))} KB"
  end

  IO.puts(
    String.pad_leading("#{n} people", 15) <>
      " | copy-out (today, tally still to do): #{row.(a)}" <>
      " | count in place, 2 counts/cell: #{row.(b)}" <>
      " | 1 role read/cell: #{row.(c)}"
  )
end
