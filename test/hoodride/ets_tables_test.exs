defmodule Hoodride.EtsTablesTest do
  @moduledoc """
  Every app ETS table runs with write_concurrency: :auto — enforced, so a
  table added later can't forget it (bench/ets_concurrency_bench.exs has
  why: 7.9–9.8× the throughput of no write concurrency on our patterns).
  """
  use ExUnit.Case, async: true

  @lib Path.expand("../../lib", __DIR__)

  defp lib_sources, do: Path.wildcard(Path.join(@lib, "**/*.ex"))

  test "lib/ creates no table except through Hoodride.ETS.new/2" do
    offenders =
      for file <- lib_sources(),
          Path.basename(file) != "ets.ex",
          {line, n} <- file |> File.read!() |> String.split("\n") |> Enum.with_index(1),
          String.contains?(line, ":ets.new("),
          do: "#{Path.relative_to(file, @lib)}:#{n}"

    assert offenders == [], "raw :ets.new outside Hoodride.ETS: #{inspect(offenders)}"
  end

  test "every app table reports write_concurrency: :auto" do
    named = Enum.filter(Hoodride.ETS.tables(), &is_atom/1)

    # one recorded table per Hoodride.ETS.new call in lib/ — none missed
    calls =
      lib_sources()
      |> Enum.map(
        &(File.read!(&1)
          |> String.split("Hoodride.ETS.new(")
          |> length()
          |> Kernel.-(1))
      )
      |> Enum.sum()

    assert length(Enum.uniq(named)) == calls

    for t <- named do
      assert :ets.info(t, :write_concurrency) == :auto, "#{inspect(t)} is not :auto"
    end
  end

  test "a caller's own write_concurrency is replaced by :auto" do
    t = Hoodride.ETS.new(:ets_tables_test_probe, [:set, :public, write_concurrency: true])
    assert :ets.info(t, :write_concurrency) == :auto
    :ets.delete(t)
  end
end
