# :pause vs :versioned recount, on the shared model (test/support/recount_model.ex),
# identical writer code. Measures what each costs and what each heals.
#
#   1. recount cost (time, memory) in a quiet world, at 1k / 10k / 50k users
#   2. write-path cost per update (crossing / same cells), no concurrency
#   3. writer latency (p50/p99/p99.9/max) and throughput: 8 writers, with
#      recounts running back-to-back (worst case) vs none
#   4. healing under load: drift planted in cold and hot cells mid-storm
#
# Run: $env:MIX_ENV="test"; mix run bench/recount_strategy_bench.exs

alias Hoodride.RecountModel, as: M

defmodule StratBench do
  def populate(m, n) do
    for u <- 1..n, do: M.update(m, u, ["c7-#{rem(u, 2000)}", "c5-#{rem(u, 100)}"])
  end

  def fresh(fun) do
    Task.async(fn ->
      :erlang.garbage_collect()
      {:memory, m0} = Process.info(self(), :memory)
      {us, r} = :timer.tc(fun)
      {:memory, m1} = Process.info(self(), :memory)
      {us / 1000, (m1 - m0) / 1024, r}
    end)
    |> Task.await(:infinity)
  end

  def pct(sorted, p), do: Enum.at(sorted, min(length(sorted) - 1, trunc(length(sorted) * p)))
  def f1(x), do: :erlang.float_to_binary(x / 1, decimals: 1)
end

IO.puts("#{System.schedulers_online()} schedulers\n")

# ---------- 1. recount cost ----------
IO.puts("1. recount cost, quiet world (min / median of 9, interleaved)")

for n <- [1_000, 10_000, 50_000] do
  models =
    for mode <- [:pause, :versioned, :hybrid, :batched], into: %{}, do: {mode, M.start(mode)}

  for {_, m} <- models, do: StratBench.populate(m, n)

  runs =
    for _ <- 1..9, mode <- [:pause, :versioned, :hybrid, :batched], reduce: %{} do
      acc ->
        {ms, kb, %{result: :ok} = r} = StratBench.fresh(fn -> M.recount(models[mode]) end)
        Map.update(acc, mode, [{ms, kb, r.max_pause_us}], &[{ms, kb, r.max_pause_us} | &1])
    end

  for mode <- [:pause, :versioned, :hybrid, :batched] do
    ms = runs[mode] |> Enum.map(&elem(&1, 0)) |> Enum.sort()
    kb = runs[mode] |> Enum.map(&elem(&1, 1)) |> Enum.sort()
    pz = runs[mode] |> Enum.map(&elem(&1, 2)) |> Enum.sort()

    IO.puts(
      "   #{String.pad_leading("#{n}", 6)} users  #{String.pad_trailing("#{mode}", 10)}" <>
        "time min #{StratBench.f1(hd(ms))} / median #{StratBench.f1(Enum.at(ms, 4))} ms" <>
        "   memory +#{round(Enum.at(kb, 4))} KB   longest pause (median) #{StratBench.f1(Enum.at(pz, 4) / 1000)} ms"
    )
  end

  for {_, m} <- models, do: M.stop(m)
end

# ---------- 2. write-path cost ----------
IO.puts("\n2. write-path cost per update, 200k updates, one process, no recount (µs)")

for mode <- [:pause, :versioned, :hybrid, :batched] do
  m = M.start(mode)
  StratBench.populate(m, 1_000)
  a = ["c7-a", "c5-a"]
  b = ["c7-b", "c5-a"]

  {cross, _} =
    :timer.tc(fn ->
      for i <- 1..200_000,
          do: M.update_now(m, rem(i, 1_000) + 1, if(rem(div(i, 1_000), 2) == 0, do: a, else: b))
    end)

  {same, _} = :timer.tc(fn -> for i <- 1..200_000, do: M.update_now(m, rem(i, 1_000) + 1, b) end)

  IO.puts(
    "   #{String.pad_trailing("#{mode}", 10)} crossing #{StratBench.f1(cross / 200_000)} µs" <>
      "   same cells #{StratBench.f1(same / 200_000)} µs"
  )

  M.stop(m)
end

# ---------- 3. writer latency and throughput ----------
IO.puts("\n3. 8 writers crossing cells for 3 s, 10k users (latency per update call, µs)")

run_storm = fn m, recount? ->
  stop = :atomics.new(1, [])

  recounter =
    Task.async(fn ->
      Stream.repeatedly(fn -> if recount?, do: M.recount(m), else: Process.sleep(5) end)
      |> Enum.take_while(fn _ -> :atomics.get(stop, 1) == 0 end)
      |> length()
    end)

  deadline = System.monotonic_time(:millisecond) + 3_000

  writers =
    for w <- 1..8 do
      Task.async(fn ->
        :rand.seed(:exsss, {w, 1, 1})

        Stream.repeatedly(fn ->
          u = :rand.uniform(10_000)
          cells = ["c7-#{:rand.uniform(2000)}", "c5-#{:rand.uniform(100)}"]
          {us, :ok} = :timer.tc(fn -> M.update(m, u, cells) end)
          us
        end)
        |> Enum.take_while(fn _ -> System.monotonic_time(:millisecond) < deadline end)
      end)
    end

  lat = writers |> Task.await_many(60_000) |> List.flatten() |> Enum.sort()
  :atomics.put(stop, 1, 1)
  recounts = Task.await(recounter, 60_000)
  {lat, recounts}
end

for {mode, recount?} <- [
      {:pause, false},
      {:pause, true},
      {:versioned, false},
      {:versioned, true},
      {:hybrid, true},
      {:batched, true}
    ] do
  m = M.start(mode)
  StratBench.populate(m, 10_000)
  {lat, recounts} = run_storm.(m, recount?)

  IO.puts(
    "   #{String.pad_trailing("#{mode}", 10)} #{String.pad_trailing(if(recount?, do: "recounting", else: "no recount"), 11)}" <>
      " #{String.pad_leading("#{round(length(lat) / 3)}", 7)} updates/s" <>
      "  p50 #{StratBench.pct(lat, 0.5)}  p99 #{StratBench.pct(lat, 0.99)}" <>
      "  p99.9 #{StratBench.pct(lat, 0.999)}  max #{List.last(lat)}" <>
      if(recount?, do: "   (#{recounts} recounts)", else: "")
  )

  M.stop(m)
end

# ---------- 4. healing under load ----------
IO.puts("\n4. healing under load: 10k users, 8 writers moving users among 20 HOT cells;")
IO.puts("   drift planted in 50 COLD cells and the 20 HOT cells, then ONE recount mid-storm")

for mode <- [:pause, :versioned, :hybrid, :batched] do
  m = M.start(mode)
  for u <- 1..10_000, do: M.update(m, u, ["cold-#{rem(u, 50)}", "hot-#{rem(u, 20)}"])
  stop = :atomics.new(1, [])

  writers =
    for w <- 1..8 do
      Task.async(fn ->
        :rand.seed(:exsss, {w, 2, 2})

        Stream.repeatedly(fn ->
          u = :rand.uniform(10_000)
          M.update(m, u, ["cold-#{rem(u, 50)}", "hot-#{:rand.uniform(20) - 1}"])
        end)
        |> Enum.take_while(fn _ -> :atomics.get(stop, 1) == 0 end)
        |> length()
      end)
    end

  Process.sleep(300)
  for c <- 0..49, do: M.bump(m, "cold-#{c}", 1000)
  for c <- 0..19, do: M.bump(m, "hot-#{c}", 1000)
  r = M.recount(m)

  :atomics.put(stop, 1, 1)
  Task.await_many(writers, 60_000)
  Enum.each(M.shard_pids(m), &:sys.get_state/1)

  counts = M.counts(m)
  truth = M.truth(m)
  cold_ok = Enum.count(0..49, fn c -> counts["cold-#{c}"] == truth["cold-#{c}"] end)
  hot_ok = Enum.count(0..19, fn c -> counts["hot-#{c}"] == truth["hot-#{c}"] end)

  IO.puts(
    "   #{String.pad_trailing("#{mode}", 10)} result #{r.result}, healed #{r.healed}," <>
      " skipped #{r.skipped_cells} cells -> correct after: cold #{cold_ok}/50, hot #{hot_ok}/20"
  )

  M.stop(m)
end

# ---------- 5. realistic load ----------
# Each user crosses into a new cell about every 2 minutes and sends a
# same-cell position every 5 s (paced, not flat out). Users sit in a small
# cell (2,000 of them) and a BIG cell (100 of them, hundreds of users each),
# like Geo's res-7 and res-5 parents.
IO.puts("\n5. realistic load: crossings 1 per user per 2 min, positions 1 per user per 5 s")

paced = fn m, n, stop ->
  for w <- 1..8 do
    Task.async(fn ->
      :rand.seed(:exsss, {w, 5, 5})
      t0 = System.monotonic_time(:millisecond)
      cross_rate = n / 120 / 8 / 1000
      beat_rate = n / 5 / 8 / 1000

      loop = fn loop, crossed, beat ->
        if :atomics.get(stop, 1) == 1 do
          {crossed, beat}
        else
          el = System.monotonic_time(:millisecond) - t0

          crossed =
            Enum.reduce(crossed..(trunc(el * cross_rate) - 1)//1, crossed, fn _, c ->
              u = :rand.uniform(n)
              M.update(m, u, ["c7-#{:rand.uniform(2000) - 1}", "c5-#{:rand.uniform(100) - 1}"])
              c + 1
            end)

          beat =
            Enum.reduce(beat..(trunc(el * beat_rate) - 1)//1, beat, fn _, b ->
              u = :rand.uniform(n)

              case :ets.lookup(m.parents, u) do
                [row] -> M.update(m, u, elem(row, 1))
                [] -> :ok
              end

              b + 1
            end)

          Process.sleep(1)
          loop.(loop, crossed, beat)
        end
      end

      loop.(loop, 0, 0)
    end)
  end
end

for n <- [10_000, 50_000], mode <- [:pause, :versioned, :hybrid, :batched] do
  m = M.start(mode)
  for u <- 1..n, do: M.update(m, u, ["c7-#{rem(u, 2000)}", "c5-#{rem(u, 100)}"])

  # a) ten recounts, 300 ms apart, under realistic load
  stop = :atomics.new(1, [])
  load = paced.(m, n, stop)
  Process.sleep(1_000)

  rs =
    for _ <- 1..10 do
      {us, r} = :timer.tc(fn -> M.recount(m) end)
      Process.sleep(300)
      {us / 1000, r}
    end

  # b) drift in EVERY big cell and 200 small ones, ONE recount, then stop
  for c <- 0..99, do: M.bump(m, "c5-#{c}", 1000)
  for c <- 0..199, do: M.bump(m, "c7-#{c}", 1000)
  M.recount(m)
  :atomics.put(stop, 1, 1)
  done = Task.await_many(load, 60_000)
  Enum.each(M.shard_pids(m), &:sys.get_state/1)

  counts = M.counts(m)
  truth = M.truth(m)
  big_ok = Enum.count(0..99, fn c -> counts["c5-#{c}"] == truth["c5-#{c}"] end)
  small_ok = Enum.count(0..199, fn c -> counts["c7-#{c}"] == truth["c7-#{c}"] end)

  skipped = rs |> Enum.map(fn {_, r} -> r.skipped_cells end) |> Enum.sort()
  ms = rs |> Enum.map(&elem(&1, 0)) |> Enum.sort()
  paused = Enum.count(rs, fn {_, r} -> Map.get(r, :paused) == true end)
  longest = rs |> Enum.map(fn {_, r} -> r.max_pause_us end) |> Enum.max()
  {crossed, beats} = Enum.reduce(done, {0, 0}, fn {c, b}, {ca, ba} -> {ca + c, ba + b} end)

  IO.puts(
    "   #{String.pad_leading("#{n}", 6)} #{String.pad_trailing("#{mode}", 10)}" <>
      "recount median #{StratBench.f1(Enum.at(ms, 5))} ms, skipped cells median #{Enum.at(skipped, 5)} (max #{List.last(skipped)})" <>
      if(mode == :hybrid, do: ", paused #{paused}/10", else: "") <>
      ", longest pause #{StratBench.f1(longest / 1000)} ms" <>
      " | one recount fixed: big #{big_ok}/100, small #{small_ok}/200" <>
      "  [load: #{crossed} crossings, #{beats} positions]"
  )

  M.stop(m)
end
