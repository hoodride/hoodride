# ETS locking options on OUR access patterns: none (one table lock),
# write_concurrency: true (fixed lock striping), write_concurrency: :auto
# (OTP 25+: the runtime adjusts lock granularity to contention; also turns
# on decentralized counters). Throughput of concurrent workers, median of 5
# interleaved rounds, plus the cost of :ets.info(t, :size) under each.
#
#   drivers  — 8 writers rewriting their own users' 6-tuple rows while 8
#              readers look rows up (GeoWriter shards + snapshot readers)
#   counts   — 8 writers update_counter on ~2,100 shared hot rows + delete-
#              at-zero (shift_agg from every shard)
#   presence — 200 processes each writing its own key and reading others
#              (user channels on connect/disconnect, sweeper reads)
#
# Run: mix run --no-start bench/ets_concurrency_bench.exs

defmodule EtsBench do
  @dur_ms 400

  def options do
    [
      {"none (one lock)", []},
      {"write_concurrency: true", [write_concurrency: true]},
      {"write_concurrency: :auto", [write_concurrency: :auto]}
    ]
  end

  def table(opts), do: :ets.new(:bench, [:set, :public] ++ opts)

  # run `fun.(i, t)` in `procs` processes for @dur_ms; total ops/s
  def run(t, procs, fun) do
    stop = System.monotonic_time(:millisecond) + @dur_ms

    ops =
      1..procs
      |> Enum.map(fn i ->
        Task.async(fn ->
          :rand.seed(:exsss, {i, 1, 1})
          loop(i, t, fun, stop, 0)
        end)
      end)
      |> Task.await_many(60_000)
      |> Enum.sum()

    ops * 1000 / @dur_ms
  end

  defp loop(i, t, fun, stop, n) do
    if rem(n, 64) == 0 and System.monotonic_time(:millisecond) >= stop do
      n
    else
      fun.(i, t)
      loop(i, t, fun, stop, n + 1)
    end
  end

  def drivers(opts) do
    t = table(opts)
    for k <- 1..50_000, do: :ets.insert(t, {k, "c8", 1.0, 2.0, %{name: "d", photo: nil}, 0})

    run(t, 16, fn
      i, t when i <= 8 ->
        k = i + 8 * :rand.uniform(6_000)
        :ets.insert(t, {k, "c8", :rand.uniform(), 2.0, %{name: "d", photo: nil}, 0})

      _i, t ->
        :ets.lookup(t, :rand.uniform(50_000))
    end)
  end

  def counts(opts) do
    t = table(opts)
    for c <- 1..2_100, do: :ets.insert(t, {c, 5, 5})

    run(t, 8, fn _i, t ->
      c = :rand.uniform(2_100)
      :ets.update_counter(t, c, {2, Enum.random([-1, 1]), 0, 0}, {c, 0, 0})
      :ets.select_delete(t, [{{c, 0, 0}, [], [true]}])
    end)
  end

  def presence(opts) do
    t = table(opts)

    run(t, 200, fn i, t ->
      if :rand.uniform(4) == 1,
        do: :ets.insert(t, {i, :online, 0}),
        else: :ets.lookup(t, :rand.uniform(200))
    end)
  end

  def size_cost(opts) do
    t = table(opts)
    for k <- 1..50_000, do: :ets.insert(t, {k})
    {us, _} = :timer.tc(fn -> for _ <- 1..20_000, do: :ets.info(t, :size) end)
    us / 20_000
  end
end

IO.puts("#{System.schedulers_online()} schedulers | median of 5 interleaved rounds | ops/s (higher is better)\n")

workloads = [{"drivers", &EtsBench.drivers/1}, {"counts", &EtsBench.counts/1}, {"presence", &EtsBench.presence/1}]

results =
  for _round <- 1..5, {wname, w} <- workloads, {oname, opts} <- EtsBench.options(), reduce: %{} do
    acc -> Map.update(acc, {wname, oname}, [w.(opts)], &[w.(opts) | &1])
  end

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end

for {wname, _} <- workloads do
  IO.puts(wname)

  for {oname, _} <- EtsBench.options() do
    IO.puts("  " <> String.pad_trailing(oname, 28) <> String.pad_leading("#{round(median.(results[{wname, oname}]))}", 12) <> " ops/s")
  end
end

IO.puts("\n:ets.info(t, :size), 50k rows")

for {oname, opts} <- EtsBench.options() do
  IO.puts("  " <> String.pad_trailing(oname, 28) <> :erlang.float_to_binary(EtsBench.size_cost(opts), decimals: 2) <> " µs per call")
end

IO.puts("\nwhat :ets.info reports for each:")

for {oname, opts} <- EtsBench.options() do
  t = EtsBench.table(opts)
  IO.puts("  #{String.pad_trailing(oname, 28)} write_concurrency=#{inspect(:ets.info(t, :write_concurrency))} decentralized_counters=#{inspect(:ets.info(t, :decentralized_counters))}")
end
