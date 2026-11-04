# Cell index benchmark: old full-scan snapshot vs indexed snapshot.
# Run: mix run bench/cell_index_bench.exs
#
# Populates the live tables directly (read-path benchmark), with N drivers:
# 200 packed into one crowded "hot" cell, the rest spread over 2,000 cells.

defmodule CellIndexBench do
  @cells 2_000
  @hot 200

  # the pre-index implementation, verbatim in behaviour
  def old_snapshot(cell) do
    drivers =
      :ets.match_object(:geo_drivers, {:_, cell, :_, :_})
      |> Enum.map(fn {id, c, spot, _ts} -> %{id: id, cell: c, spot: spot} end)

    hands =
      :ets.match_object(:geo_hands, {:_, cell, :_})
      |> Enum.map(fn {id, c, spot} -> %{id: id, cell: c, spot: spot} end)

    %{drivers: drivers, hands: hands}
  end

  def populate(n) do
    for t <- [:geo_drivers, :geo_hands, :geo_by_cell], do: :ets.delete_all_objects(t)

    for id <- 1..n do
      cell = if id <= @hot, do: "hot", else: "c#{rem(id, @cells)}"
      prof = %{name: "U#{id}", photo: nil}
      :ets.insert(:geo_drivers, {id, cell, cell, 0})
      :ets.insert(:geo_by_cell, {{cell, id}, :driver})
    end
  end

  # average microseconds per call over `iters` calls
  def avg_us(iters, fun) do
    {us, _} = :timer.tc(fn -> for _ <- 1..iters, do: fun.() end)
    us / iters
  end

  def fmt(us) when us >= 1000, do: :io_lib.format("~.2f ms", [us / 1000]) |> to_string()
  def fmt(us), do: :io_lib.format("~.1f µs", [us]) |> to_string()

  def run do
    IO.puts("\n#{String.pad_trailing("drivers", 9)}| case               | full scan  | index      | speedup")
    IO.puts(String.duplicate("-", 72))

    for n <- [300, 3_000, 10_000] do
      populate(n)
      sync80 = for i <- 1..80, do: "c#{i * 17}"

      cases = [
        {"empty cell", fn -> old_snapshot("nobody") end, fn -> Hoodride.Geo.cell_snapshot("nobody") end, 2_000},
        {"typical cell", fn -> old_snapshot("c42") end, fn -> Hoodride.Geo.cell_snapshot("c42") end, 2_000},
        {"hot cell (200)", fn -> old_snapshot("hot") end, fn -> Hoodride.Geo.cell_snapshot("hot") end, 500},
        {"80-cell sync", fn -> Enum.each(sync80, &old_snapshot/1) end,
         fn -> Enum.each(sync80, &Hoodride.Geo.cell_snapshot/1) end, 50}
      ]

      for {name, old, new, iters} <- cases do
        # warm-up, then measure
        old.()
        new.()
        o = avg_us(iters, old)
        i = avg_us(iters, new)

        IO.puts(
          "#{String.pad_trailing(Integer.to_string(n), 9)}| #{String.pad_trailing(name, 19)}| " <>
            "#{String.pad_trailing(fmt(o), 11)}| #{String.pad_trailing(fmt(i), 11)}| " <>
            "#{:io_lib.format("~.1f", [o / max(i, 0.01)])}x"
        )
      end

      IO.puts(String.duplicate("-", 72))
    end

    # write-side cost the index adds: one cell crossing = delete + insert
    populate(10_000)

    crossing =
      avg_us(20_000, fn ->
        :ets.delete(:geo_by_cell, {"c5", 5})
        :ets.insert(:geo_by_cell, {{"c6", 5}, :driver})
        :ets.delete(:geo_by_cell, {"c6", 5})
        :ets.insert(:geo_by_cell, {{"c5", 5}, :driver})
      end) / 2

    IO.puts("index cost added per cell crossing (10,000 drivers): #{fmt(crossing)}\n")
  end
end

CellIndexBench.run()
