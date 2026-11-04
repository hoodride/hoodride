# Batched recount: which batch size (cells per pause) — or which time
# budget per pause — is best? One 50k-user world under REALISTIC traffic
# for the whole run (a crossing per user every ~2 min, a same-cell position
# every 5 s), batch size changed between recounts, sizes interleaved round
# by round so background load hits them all alike.
#
# Per size: recount time, longest pause, number of pauses, big cells fixed
# by one recount (drift planted in all 100 big cells first), and the latency
# of the writers' own update calls while that size was recounting.
#
# Run:
#   $env:MIX_ENV="test"; mix run bench/batch_sweep_bench.exs              (coarse sweep)
#   $env:MIX_ENV="test"; mix run bench/batch_sweep_bench.exs fine 20 60   (every size 20..60)

alias Hoodride.RecountModel, as: M

n = 50_000
rounds = 3

sizes =
  case System.argv() do
    ["fine", a, b] ->
      for s <- String.to_integer(a)..String.to_integer(b), do: {s, false, :normal}

    # explicit list: "5 7 b250 s250 s250p allp" (bN = budget, sN = safe EWMA,
    # eN = EWMA, aN = AIMD, all / self; a trailing "p" sends the hold as a
    # PRIORITY message, OTP 28+)
    ["list" | items] ->
      for item <- items do
        # suffixes: "h" = writers + recount at HIGH process priority,
        # "p" = hold sent as a priority message (either order, both allowed)
        sched = if String.contains?(String.slice(item, -2, 2), "h"), do: :high, else: :normal
        prio = String.contains?(String.slice(item, -2, 2), "p")
        item = String.trim_trailing(item, "h") |> String.trim_trailing("p") |> String.trim_trailing("h")

        spec =
          case item do
            "b" <> us -> {:budget_us, String.to_integer(us)}
            "all" -> :all
            "self" -> :self_tune
            "s" <> us -> {:safe_ewma, String.to_integer(us)}
            "e" <> us -> {:ewma, String.to_integer(us)}
            "a" <> us -> {:aimd, String.to_integer(us)}
            size -> String.to_integer(size)
          end

        {spec, prio, sched}
      end

    _ ->
      ([1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, :all] ++
         [
           {:budget_us, 250},
           {:budget_us, 500},
           {:budget_us, 1000},
           {:budget_us, 2000},
           {:budget_us, 5000}
         ])
      |> Enum.map(&{&1, false, :normal})
  end

spec_label = fn
  :all -> "all (one pause)"
  {:budget_us, us} -> "budget #{us} µs"
  {:ewma, us} -> "EWMA #{us} µs"
  {:safe_ewma, us} -> "safe EWMA #{us} µs"
  {:aimd, us} -> "AIMD #{us} µs"
  :self_tune -> "self-tuning"
  s -> "#{s} cells"
end

label = fn {spec, prio, sched} ->
  spec_label.(spec) <> if(prio, do: " +prio", else: "") <> if(sched == :high, do: " +high", else: "")
end

batch_of = fn
  :all -> 1_000_000
  s -> s
end

m = M.start(:batched)
for u <- 1..n, do: M.update(m, u, ["c7-#{rem(u, 2000)}", "c5-#{rem(u, 100)}"])
:ok = M.recount(m).result |> then(fn :ok -> :ok end)

# writer latencies, tagged with the size being measured at the time
lat = :ets.new(:sweep_lat, [:duplicate_bag, :public, write_concurrency: true])
window = :atomics.new(1, [])
stop = :atomics.new(1, [])

writers =
  for w <- 1..8 do
    Task.async(fn ->
      :rand.seed(:exsss, {w, 9, 9})
      t0 = System.monotonic_time(:millisecond)
      cross_rate = n / 120 / 8 / 1000
      beat_rate = n / 5 / 8 / 1000

      timed = fn u, cells ->
        {us, :ok} = :timer.tc(fn -> M.update(m, u, cells) end)
        win = :atomics.get(window, 1)
        if win > 0, do: :ets.insert(lat, {win, us})
      end

      loop = fn loop, crossed, beat ->
        if :atomics.get(stop, 1) == 1 do
          :ok
        else
          el = System.monotonic_time(:millisecond) - t0

          crossed =
            Enum.reduce(crossed..(trunc(el * cross_rate) - 1)//1, crossed, fn _, c ->
              timed.(:rand.uniform(n), [
                "c7-#{:rand.uniform(2000) - 1}",
                "c5-#{:rand.uniform(100) - 1}"
              ])

              c + 1
            end)

          beat =
            Enum.reduce(beat..(trunc(el * beat_rate) - 1)//1, beat, fn _, b ->
              u = :rand.uniform(n)

              case :ets.lookup(m.parents, u) do
                [{_, cells}] -> timed.(u, cells)
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

# FLOOD=N adds N unpaced writers on top: each sends updates as fast as it
# can (90% same-cell positions, 10% crossings), so updates arrive faster
# than the shards drain them and real mailbox queues build — the case
# priority holds exist for
flooders =
  case System.get_env("FLOOD") do
    nil ->
      []

    k ->
      for w <- 1..String.to_integer(k) do
        Task.async(fn ->
          :rand.seed(:exsss, {w, 3, 3})

          Stream.repeatedly(fn ->
            u = :rand.uniform(n)

            cells =
              case :rand.uniform(10) == 1 or :ets.lookup(m.parents, u) do
                true -> ["c7-#{:rand.uniform(2000) - 1}", "c5-#{:rand.uniform(100) - 1}"]
                [{_, cells}] -> cells
                [] -> ["c7-0", "c5-0"]
              end

            {us, :ok} = :timer.tc(fn -> M.update(m, u, cells) end)
            win = :atomics.get(window, 1)
            if win > 0, do: :ets.insert(lat, {win, us})
          end)
          |> Enum.take_while(fn _ -> :atomics.get(stop, 1) == 0 end)

          :ok
        end)
      end
  end

writers = writers ++ flooders

Process.sleep(1_000)

queue_lens = for pid <- M.shard_pids(m), do: elem(Process.info(pid, :message_queue_len), 1)
IO.puts("shard mailbox queues at start: #{inspect(queue_lens)}")

# window id per {size index, round}
results =
  for round <- 1..rounds, {size, i} <- Enum.with_index(sizes), reduce: %{} do
    acc ->
      win = round * 1000 + i + 1
      :atomics.put(window, 1, win)
      {spec, prio, sched} = size
      mm = %{m | batch: batch_of.(spec), prio: prio}
      M.set_writer_priority(m, sched)
      Process.flag(:priority, sched)

      # recount 1: with drift planted in every big cell
      for c <- 0..99, do: M.bump(m, "c5-#{c}", 1000)
      {us1, r1} = :timer.tc(fn -> M.recount(mm) end)
      # recounts 2-3: clean-up and plain measurements
      Process.sleep(150)
      {us2, r2} = :timer.tc(fn -> M.recount(mm) end)
      Process.sleep(150)
      {us3, r3} = :timer.tc(fn -> M.recount(mm) end)
      :atomics.put(window, 1, 0)
      M.set_writer_priority(m, :normal)
      Process.flag(:priority, :normal)
      # leftovers fixed before the next size is measured
      M.recount(%{m | batch: 100})

      sample = %{
        times: [us1, us2, us3],
        pauses: Enum.map([r1, r2, r3], & &1.max_pause_us),
        acquires: Enum.map([r1, r2, r3], & &1.max_acquire_us),
        npauses: r2.pauses,
        healed: r1.healed,
        window: win
      }

      Map.update(acc, size, [sample], &[sample | &1])
  end

:atomics.put(stop, 1, 1)
Task.await_many(writers, 120_000)

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end
pct = fn sorted, p -> Enum.at(sorted, min(length(sorted) - 1, trunc(length(sorted) * p))) end
f1 = fn x -> :erlang.float_to_binary(x / 1, decimals: 1) end

IO.puts(
  "#{n} users, ~#{length(M.shard_pids(m))} shards, #{rounds} interleaved rounds x 3 recounts per size\n" <>
    String.pad_trailing("batch", 24) <>
    "recount ms   longest pause ms (median / worst)   of which waiting for writers   pauses   big fixed   writer p99 / p99.9 / max (µs)"
)

for size <- sizes do
  samples = results[size]
  times = samples |> Enum.flat_map(& &1.times) |> Enum.map(&(&1 / 1000))
  pauses = samples |> Enum.flat_map(& &1.pauses) |> Enum.map(&(&1 / 1000))
  acquires = samples |> Enum.flat_map(& &1.acquires) |> Enum.map(&(&1 / 1000))
  healed = samples |> Enum.map(& &1.healed)

  lats =
    samples
    |> Enum.flat_map(fn s -> :ets.lookup(lat, s.window) end)
    |> Enum.map(&elem(&1, 1))
    |> Enum.sort()

  IO.puts(
    String.pad_trailing(label.(size), 24) <>
      String.pad_leading(f1.(median.(times)), 9) <>
      String.pad_leading(f1.(median.(pauses)), 14) <>
      " / " <>
      String.pad_trailing(f1.(Enum.max(pauses)), 10) <>
      String.pad_trailing("#{f1.(median.(acquires))} / #{f1.(Enum.max(acquires))}", 22) <>
      String.pad_leading("#{median.(Enum.map(samples, & &1.npauses))}", 7) <>
      String.pad_leading("#{median.(healed)}/100", 11) <>
      "    #{pct.(lats, 0.99)} / #{pct.(lats, 0.999)} / #{List.last(lats)}"
  )
end

M.stop(m)
