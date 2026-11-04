# The batched recount in the REAL app under live, realistic traffic: n
# drivers through the real write path (Geo.driver_update → GeoWriter), 8
# paced writers sending a cell crossing per driver every ~2 min and a
# same-cell position every 5 s.
#
#   A. 3 s with NO recount — the writers' baseline update latency
#   B. 10 recounts 300 ms apart — longest pause, pauses, recount time, and
#      the writers' update latency while recounts run
#   C. drift planted in every big hex, ONE recount under traffic, then
#      traffic stops and the planted hexes are checked against the truth
#
# Run: $env:MIX_ENV="test"; mix run bench/recount_live_bench.exs [n ...]

alias Hoodride.Geo

sizes =
  case System.argv() do
    [] -> [10_000, 50_000]
    args -> Enum.map(args, &String.to_integer/1)
  end

pct = fn sorted, p -> Enum.at(sorted, min(length(sorted) - 1, trunc(length(sorted) * p))) end
median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end
f2 = fn x -> :erlang.float_to_binary(x / 1, decimals: 2) end

lat_line = fn lats ->
  "p50 #{pct.(lats, 0.5)}  p99 #{pct.(lats, 0.99)}  p99.9 #{pct.(lats, 0.999)}  max #{List.last(lats)} µs"
end

prof = fn id -> %{id: id, name: "d#{id}", photo: nil} end
cells_for = fn -> ["c7-#{:rand.uniform(2000) - 1}", "c5-#{:rand.uniform(100) - 1}"] end

IO.puts("#{System.schedulers_online()} schedulers\n")

for n <- sizes do
  Hoodride.TestHelpers.scrub_live_state()
  Process.delete({Geo, :batch})

  for id <- 1..n,
      do:
        Geo.driver_update(prof.(id), "c8", nil, [
          "c7-#{rem(id, 2000)}",
          "c5-#{rem(id, 100)}"
        ])

  :ok = Geo.recompute_aggregates()

  lat = :ets.new(:live_lat, [:duplicate_bag, :public, write_concurrency: true])
  phase = :atomics.new(1, [])
  stop = :atomics.new(1, [])

  writers =
    for w <- 1..8 do
      Task.async(fn ->
        :rand.seed(:exsss, {w, 4, 4})
        t0 = System.monotonic_time(:millisecond)
        cross_rate = n / 120 / 8 / 1000
        beat_rate = n / 5 / 8 / 1000

        timed = fn id, cells ->
          {us, :ok} = :timer.tc(fn -> Geo.driver_update(prof.(id), "c8", nil, cells) end)
          ph = :atomics.get(phase, 1)
          if ph > 0, do: :ets.insert(lat, {ph, us})
        end

        loop = fn loop, crossed, beat ->
          if :atomics.get(stop, 1) == 1 do
            {crossed, beat}
          else
            el = System.monotonic_time(:millisecond) - t0

            crossed =
              Enum.reduce(crossed..(trunc(el * cross_rate) - 1)//1, crossed, fn _, c ->
                timed.(:rand.uniform(n), cells_for.())
                c + 1
              end)

            beat =
              Enum.reduce(beat..(trunc(el * beat_rate) - 1)//1, beat, fn _, b ->
                id = :rand.uniform(n)

                case :ets.lookup(:geo_parents, id) do
                  [{_, _, cells}] -> timed.(id, cells)
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

  Process.sleep(1_000)

  # A. baseline: no recount
  :atomics.put(phase, 1, 1)
  Process.sleep(3_000)

  # B. recounts under traffic
  :atomics.put(phase, 1, 2)

  rs =
    for _ <- 1..10 do
      {us, result} = :timer.tc(&Geo.recompute_aggregates/0)
      st = Process.get({Geo, :last_recount})
      Process.sleep(300)
      {result, us / 1000, st.max_pause_us / 1000, st.pauses}
    end

  :atomics.put(phase, 1, 0)

  # C. healing under traffic: every big hex wrong by +1000, one recount
  for c <- 0..99, do: :ets.update_counter(:geo_agg, "c5-#{c}", {2, 1000}, {"c5-#{c}", 0, 0})
  heal_result = Geo.recompute_aggregates()
  :atomics.put(stop, 1, 1)
  done = Task.await_many(writers, 120_000)

  # truth from the parents rows (everyone is a driver on the map here)
  truth =
    Enum.reduce(:ets.tab2list(:geo_parents), %{}, fn {_id, :driver, cells}, acc ->
      Enum.reduce(cells, acc, fn c, a -> Map.update(a, c, 1, &(&1 + 1)) end)
    end)

  fixed =
    Enum.count(0..99, fn c ->
      Geo.agg_counts_for("c5-#{c}").drivers == Map.get(truth, "c5-#{c}", 0)
    end)

  base = lat |> :ets.lookup(1) |> Enum.map(&elem(&1, 1)) |> Enum.sort()
  during = lat |> :ets.lookup(2) |> Enum.map(&elem(&1, 1)) |> Enum.sort()
  {crossed, beats} = Enum.reduce(done, {0, 0}, fn {c, b}, {ca, ba} -> {ca + c, ba + b} end)
  pauses = Enum.map(rs, &elem(&1, 2))

  IO.puts("#{n} drivers  [traffic: #{crossed} crossings, #{beats} positions in total]")
  IO.puts("  recounts: #{rs |> Enum.map(&elem(&1, 0)) |> Enum.frequencies() |> inspect()}")

  IO.puts(
    "  longest pause: median #{f2.(median.(pauses))} ms, worst #{f2.(Enum.max(pauses))} ms" <>
      " | pauses per recount #{median.(Enum.map(rs, &elem(&1, 3)))}" <>
      " | whole recount median #{f2.(median.(Enum.map(rs, &elem(&1, 1))))} ms"
  )

  IO.puts("  writer updates, NO recount:     #{lat_line.(base)}  (#{length(base)} updates)")
  IO.puts("  writer updates, recounting:     #{lat_line.(during)}  (#{length(during)} updates)")
  IO.puts("  one recount under traffic (#{heal_result}): big hexes fixed #{fixed}/100\n")

  :ets.delete(lat)
end

Hoodride.TestHelpers.scrub_live_state()
