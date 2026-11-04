# Worst-conditions benchmark for Phoenix.PubSub subscription layouts:
# group_by :pid (default) vs :key, across partition counts, with normal
# cells and a "stadium" cell every phone watches (optionally split into
# sub-topics), under mixed load (broadcasts while everyone pans) and a full
# disconnect/reconnect storm.
#
# Timing note: on Windows the BEAM clock steps in ~102 µs increments, so
# everything shorter is timed in BATCHES and divided — never per call.
#
# Run: mix run --no-start bench/pubsub_stress_bench.exs

Application.ensure_all_started(:phoenix_pubsub)

defmodule Stress.Watcher do
  # one phone's WorldChannel stand-in, after it has subscribed itself
  # (PubSub registers the CALLING process): drops broadcasts, obeys commands
  def loop(pubsub, cells, hot) do
    receive do
      {:hot_cycle, from, n} ->
        {us, _} =
          :timer.tc(fn ->
            for _ <- 1..n do
              Enum.each(hot, &Phoenix.PubSub.unsubscribe(pubsub, &1))
              Enum.each(hot, &Phoenix.PubSub.subscribe(pubsub, &1))
            end
          end)

        send(from, {:hot_cycled, us / n})
        loop(pubsub, cells, hot)

      {:pan, from, n} ->
        {us, cells} = :timer.tc(fn -> Enum.reduce(1..n, cells, fn _, c -> pan(pubsub, c) end) end)
        send(from, {:panned, us / n})
        loop(pubsub, cells, hot)

      {:churn, deadline, every_ms, from} ->
        {n, cells} = churn(pubsub, cells, deadline, every_ms, 0)
        send(from, {:churned, n})
        loop(pubsub, cells, hot)

      _broadcast ->
        loop(pubsub, cells, hot)
    end
  end

  # drop the first 20 cells, add 20 past the end (a pan)
  defp pan(pubsub, cells) do
    {drop, keep} = Enum.split(cells, 20)
    last = cells |> List.last() |> Stress.cell_index()
    add = for i <- (last + 1)..(last + 20), do: Stress.topic(i)
    Enum.each(drop, &Phoenix.PubSub.unsubscribe(pubsub, &1))
    Enum.each(add, &Phoenix.PubSub.subscribe(pubsub, &1))
    keep ++ add
  end

  # pan, then idle a random ~every_ms (±50%) — draining broadcasts meanwhile
  defp churn(pubsub, cells, deadline, every_ms, n) do
    now = System.monotonic_time(:millisecond)

    if now >= deadline do
      {n, cells}
    else
      cells = pan(pubsub, cells)
      idle(min(deadline, now + div(every_ms, 2) + :rand.uniform(every_ms)))
      churn(pubsub, cells, deadline, every_ms, n + 1)
    end
  end

  defp idle(until) do
    left = until - System.monotonic_time(:millisecond)

    if left > 0 do
      receive do
        _ -> idle(until)
      after
        left -> :ok
      end
    end
  end
end

defmodule Stress do
  @cells 5_000
  @watchers 1_000
  @per_watcher 80

  def topic(i), do: "geo:" <> Integer.to_string(rem(i + @cells * 1000, @cells))
  def cell_index("geo:" <> n), do: String.to_integer(n)

  # the stadium cell as `split` sub-topics (split 1 = one plain hot topic)
  def hot_topics(split), do: for(i <- 0..(split - 1), do: "geo:HOT##{i}")
  # a watcher in the stadium joins exactly ONE of them, picked by its pid
  def hot_for(pid, split), do: ["geo:HOT##{:erlang.phash2(pid, split)}"]

  def run(layout, partitions, crowd, split) do
    name =
      :"stress_#{layout}_#{partitions}_#{crowd}_#{split}_#{System.unique_integer([:positive])}"

    {:ok, sup} =
      Supervisor.start_link(
        [{Phoenix.PubSub, name: name, group_by: layout, registry_size: partitions}],
        strategy: :one_for_one
      )

    :rand.seed(:exsss, {7, 7, 7})
    starts = for _ <- 1..@watchers, do: :rand.uniform(@cells)
    watchers = spawn_all(name, starts, crowd, split)
    hot = if crowd == :stadium, do: hot_topics(split), else: []

    # sanity: the stadium really has every phone in it
    if hot != [] do
      true = Enum.sum(for t <- hot, do: length(Registry.lookup(name, t))) == @watchers
    end

    # 1. broadcasts — normal cells, and one update to the stadium (all sub-topics)
    normal_keys = for _ <- 1..20_000, do: topic(:rand.uniform(@cells))
    {bn, _} = :timer.tc(fn -> Enum.each(normal_keys, &Phoenix.PubSub.broadcast(name, &1, :u)) end)

    bh =
      if hot != [] do
        {us, _} =
          :timer.tc(fn ->
            for _ <- 1..300, t <- hot, do: Phoenix.PubSub.broadcast(name, t, :u)
          end)

        us / 300
      end

    # 2. leave + rejoin the stadium, 10× per phone, 200 phones
    hc =
      if hot != [] do
        Enum.take(watchers, 200)
        |> Enum.map(fn w ->
          send(w, {:hot_cycle, self(), 10})
          receive do: ({:hot_cycled, us} -> us)
        end)
        |> avg()
      end

    # 3. pans: 5 per phone, every phone, one phone at a time
    pan =
      watchers
      |> Enum.map(fn w ->
        send(w, {:pan, self(), 5})
        receive do: ({:panned, us} -> us)
      end)
      |> avg()

    # 4. mixed load: everyone pans every ~100 ms while 8 writers broadcast
    {b_avg, b_p99, bps, pps} = mixed(name, watchers, hot)

    # 5. storm: everyone disconnects at once, then everyone reconnects at once
    {down, _} =
      :timer.tc(fn ->
        Enum.each(watchers, &Process.exit(&1, :kill))
        wait_until(fn -> Registry.count(name) == 0 end)
      end)

    {up, _} = :timer.tc(fn -> spawn_all(name, starts, crowd, split) end)

    Supervisor.stop(sup)

    %{
      bcast_normal: bn / length(normal_keys),
      bcast_hot: bh,
      hot_cycle: hc,
      pan: pan,
      mixed_avg: b_avg,
      mixed_p99: b_p99,
      mixed_bcast_per_s: bps,
      mixed_pans_per_s: pps,
      storm_down_ms: down / 1000,
      storm_up_ms: up / 1000
    }
  end

  defp spawn_all(name, starts, crowd, split) do
    parent = self()

    ws =
      for s <- starts do
        cells = for i <- s..(s + @per_watcher - 1), do: topic(i)

        spawn(fn ->
          hot = if crowd == :stadium, do: hot_for(self(), split), else: []
          Enum.each(cells ++ hot, &Phoenix.PubSub.subscribe(name, &1))
          send(parent, {:ready, self()})
          Stress.Watcher.loop(name, cells, hot)
        end)
      end

    for _ <- ws, do: receive(do: ({:ready, _} -> :ok))
    ws
  end

  # broadcasters time batches of 50 updates; 5% of updates go to the stadium
  defp mixed(name, watchers, hot) do
    ms = 2_000
    deadline = System.monotonic_time(:millisecond) + ms
    me = self()
    Enum.each(watchers, &send(&1, {:churn, deadline, 100, me}))

    batches =
      1..8
      |> Enum.map(fn _ -> Task.async(fn -> broadcaster(name, hot, deadline, []) end) end)
      |> Enum.flat_map(&Task.await(&1, :infinity))
      |> Enum.sort()

    pans = for _ <- watchers, reduce: 0, do: (acc -> acc + receive(do: ({:churned, n} -> n)))
    sent = length(batches) * 50

    {avg(batches), pct(batches, 0.99), round(sent / (ms / 1000)), round(pans / (ms / 1000))}
  end

  defp broadcaster(name, hot, deadline, acc) do
    if System.monotonic_time(:millisecond) >= deadline do
      acc
    else
      {us, _} =
        :timer.tc(fn ->
          for _ <- 1..50 do
            topics =
              if hot != [] and :rand.uniform(20) == 1,
                do: hot,
                else: [topic(:rand.uniform(@cells))]

            Enum.each(topics, &Phoenix.PubSub.broadcast(name, &1, :u))
          end
        end)

      broadcaster(name, hot, deadline, [us / 50 | acc])
    end
  end

  defp pct([], _), do: nil
  defp pct(sorted, p), do: Enum.at(sorted, min(length(sorted) - 1, trunc(length(sorted) * p)))
  defp avg([]), do: nil
  defp avg(xs), do: Enum.sum(xs) / length(xs)

  defp wait_until(f) do
    unless f.() do
      Process.sleep(1)
      wait_until(f)
    end
  end
end

defmodule Stress.Median do
  def of(runs, key) do
    vals = runs |> Enum.map(& &1[key]) |> Enum.reject(&is_nil/1) |> Enum.sort()
    if vals == [], do: nil, else: Enum.at(vals, div(length(vals), 2))
  end
end

fmt = fn
  nil -> "      -"
  v when is_float(v) -> :io_lib.format("~7.1f", [v]) |> to_string()
  v -> String.pad_leading(to_string(v), 7)
end

IO.puts(
  "#{System.schedulers_online()} schedulers | 1000 phones x 80 cells over 5000 cells | median of 3 runs"
)

IO.puts(
  "µs per operation unless noted | stadium = every phone also watches one cell (split = sub-topics)"
)

IO.puts(
  "mixed = every phone pans every ~100 ms (≈10k pans/s offered) while 8 writers broadcast\n"
)

IO.puts(
  "layout  P crowd   split|  bcast stadiumBC leave+join   pan |  mixed avg   p99  bcast/s  pans/s | storm down ms  up ms"
)

for crowd <- [:normal, :stadium],
    split <- if(crowd == :stadium, do: [1, 4], else: [1]),
    partitions <- [1, 2, 8, 16],
    layout <- [:pid, :key] do
  runs = for _ <- 1..3, do: Stress.run(layout, partitions, crowd, split)
  m = &Stress.Median.of(runs, &1)

  IO.puts(
    "#{String.pad_trailing(inspect(layout), 6)} #{String.pad_leading(to_string(partitions), 2)} " <>
      "#{String.pad_trailing(to_string(crowd), 7)} #{split}  |" <>
      "#{fmt.(m.(:bcast_normal))} #{fmt.(m.(:bcast_hot))} #{fmt.(m.(:hot_cycle))} #{fmt.(m.(:pan))} |" <>
      "#{fmt.(m.(:mixed_avg))} #{fmt.(m.(:mixed_p99))} #{fmt.(m.(:mixed_bcast_per_s))} #{fmt.(m.(:mixed_pans_per_s))} |" <>
      "#{fmt.(m.(:storm_down_ms))} #{fmt.(m.(:storm_up_ms))}"
  )
end
