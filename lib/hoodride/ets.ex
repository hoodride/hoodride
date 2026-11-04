defmodule Hoodride.ETS do
  @moduledoc """
  Shared ETS helpers.

  `each_match/3` is how whole-table passes (the sweeper's) read: the match
  spec's condition and projection run INSIDE ETS, so only matching rows —
  and only the fields asked for — are copied into the caller, one page at
  a time. The Erlang efficiency guide's advice (select over tab2list +
  filter) and Cachex's janitor pattern, plus paging so even a pass where
  everything matches never holds the whole table at once.
  """

  # Bounds how many matches are in memory at once — a memory cap, not a
  # tuning knob: any page from tens to thousands reads the table the same.
  @page 500

  @doc """
  Every app table is created here, always with `write_concurrency: :auto`
  (OTP 25+): the runtime adjusts lock granularity to the contention it sees.
  Measured on our access patterns (bench/ets_concurrency_bench.exs), it gave
  7.9–9.8× the throughput of a table with no write concurrency and beat
  `true`, most of all on the hot shared count rows (1.8×). Its one cost —
  `:ets.info(t, :size)` at ~4 µs instead of ~0.1 — only hits the sweeper's
  few size reads per sweep. Any write_concurrency the caller passes is
  replaced, and the table is recorded so a test can check every one.
  """
  def new(name, opts) do
    opts = Enum.reject(opts, &match?({:write_concurrency, _}, &1)) ++ [write_concurrency: :auto]
    table = :ets.new(name, opts)
    :persistent_term.put({__MODULE__, :tables}, [table | tables()])
    table
  end

  @doc "Every table created through new/2 (names, or refs for unnamed ones)."
  def tables, do: :persistent_term.get({__MODULE__, :tables}, [])

  @doc """
  Calls `fun` on every result of `match_spec` over `table`. The table is
  fixed for the traversal (`safe_fixtable`), so concurrent writes — including
  `fun`'s own — can't make it skip or repeat a row that stays put.
  """
  def each_match(table, match_spec, fun) do
    :ets.safe_fixtable(table, true)

    try do
      each_walk(:ets.select(table, match_spec, @page), fun)
    after
      :ets.safe_fixtable(table, false)
    end
  end

  # its own loop rather than fold_match with a wrapper fun: one call per row
  # instead of two (measured: the sweep visits ~250k rows)
  defp each_walk(:"$end_of_table", _fun), do: :ok

  defp each_walk({matches, cont}, fun) do
    Enum.each(matches, fun)
    each_walk(:ets.select(cont), fun)
  end

  @doc "Like `each_match/3`, threading an accumulator through the results."
  def fold_match(table, match_spec, acc, fun) do
    :ets.safe_fixtable(table, true)

    try do
      walk(:ets.select(table, match_spec, @page), acc, fun)
    after
      :ets.safe_fixtable(table, false)
    end
  end

  defp walk(:"$end_of_table", acc, _fun), do: acc

  defp walk({matches, cont}, acc, fun) do
    walk(:ets.select(cont), Enum.reduce(matches, acc, fun), fun)
  end
end
