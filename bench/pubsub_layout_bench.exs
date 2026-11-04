# Phoenix.PubSub subscription layout: group_by :pid (default) vs :key
# (Elixir 1.19+ key-partitioned Registry), on OUR traffic shape: many cell
# topics, each watcher holding ~80 contiguous cells, a handful of watchers
# per cell. No published benchmarks exist for this choice, so we measure.
#
# Run: mix run --no-start bench/pubsub_layout_bench.exs

Application.ensure_all_started(:phoenix_pubsub)

defmodule Bench.Watcher do
  # a stand-in for one phone's WorldChannel: subscribes itself (PubSub
  # registers the CALLING process), drops broadcasts, obeys commands
  def start(pubsub, topics) do
    parent = self()

    spawn(fn ->
      Enum.each(topics, &Phoenix.PubSub.subscribe(pubsub, &1))
      send(parent, {:ready, self()})
      loop(pubsub)
    end)
  end

  defp loop(pubsub) do
    receive do
      {:pan, from, drop, add} ->
        {us, _} =
          :timer.tc(fn ->
            Enum.each(drop, &Phoenix.PubSub.unsubscribe(pubsub, &1))
            Enum.each(add, &Phoenix.PubSub.subscribe(pubsub, &1))
          end)

        send(from, {:panned, us})
        loop(pubsub)

      _broadcast ->
        loop(pubsub)
    end
  end
end

defmodule Bench do
  @topics String.to_integer(System.get_env("TOPICS", "5000"))
  @watchers 1_000
  @per_watcher 80
  @pan 20

  def topic(i), do: "geo:" <> Integer.to_string(rem(i + @topics, @topics))

  def run(group_by, partitions) do
    name = :"bench_#{group_by}_#{partitions}"

    {:ok, sup} =
      Supervisor.start_link([{Phoenix.PubSub, name: name, group_by: group_by, registry_size: partitions}],
        strategy: :one_for_one
      )

    :rand.seed(:exsss, {1, 2, 3})
    starts = for _ <- 1..@watchers, do: :rand.uniform(@topics)

    watchers =
      for s <- starts do
        Bench.Watcher.start(name, for(i <- s..(s + @per_watcher - 1), do: topic(i)))
      end

    for _ <- watchers, do: receive(do: ({:ready, _} -> :ok))
    total = Registry.count(name)
    true = total == @watchers * @per_watcher

    # correctness: each topic's subscriber count matches the model
    expected = Enum.frequencies(for s <- starts, i <- s..(s + @per_watcher - 1), do: topic(i))

    for t <- Enum.take_random(Map.keys(expected), 200) do
      true = length(Registry.lookup(name, t)) == expected[t]
    end

    # 1. broadcasts from one process (a GeoWriter shard)
    keys = Enum.map(1..20_000, fn _ -> topic(:rand.uniform(@topics)) end)
    {b_us, _} = :timer.tc(fn -> Enum.each(keys, &Phoenix.PubSub.broadcast(name, &1, :update)) end)

    # 2. pans: every watcher drops 20 of its cells and adds 20 new ones
    pan_times =
      Enum.zip(watchers, starts)
      |> Enum.map(fn {w, s} ->
        drop = for i <- s..(s + @pan - 1), do: topic(i)
        add = for i <- (s + @per_watcher)..(s + @per_watcher + @pan - 1), do: topic(i)
        send(w, {:pan, self(), drop, add})
        receive do: ({:panned, us} -> us)
      end)

    # 3. concurrent broadcasts: 8 writers at once (our 8 GeoWriter shards)
    {c_us, _} =
      :timer.tc(fn ->
        1..8
        |> Enum.map(fn _ ->
          Task.async(fn ->
            for _ <- 1..5_000, do: Phoenix.PubSub.broadcast(name, topic(:rand.uniform(@topics)), :update)
          end)
        end)
        |> Enum.each(&Task.await(&1, :infinity))
      end)

    # 4. mass disconnect: every watcher dies at once; time until clean
    {d_us, _} =
      :timer.tc(fn ->
        Enum.each(watchers, &Process.exit(&1, :kill))
        wait_empty(name)
      end)

    Supervisor.stop(sup)

    %{
      broadcast_us: Float.round(b_us / length(keys), 2),
      pan_us: Float.round(Enum.sum(pan_times) / length(pan_times), 1),
      concurrent_40k_ms: Float.round(c_us / 1000, 1),
      disconnect_1000_ms: Float.round(d_us / 1000, 1)
    }
  end

  defp wait_empty(name) do
    if Registry.count(name) > 0 do
      Process.sleep(1)
      wait_empty(name)
    end
  end

  def median(results, key) do
    results |> Enum.map(& &1[key]) |> Enum.sort() |> Enum.at(div(length(results), 2))
  end
end

topics = String.to_integer(System.get_env("TOPICS", "5000"))

IO.puts(
  "#{System.schedulers_online()} schedulers | #{topics} topics, 1000 watchers x 80 cells " <>
    "(~#{div(80_000, topics)} watchers per cell) | median of 5 runs\n"
)

for partitions <- [2, 8], group_by <- [:pid, :key] do
  runs = for _ <- 1..5, do: Bench.run(group_by, partitions)
  m = &Bench.median(runs, &1)

  IO.puts(
    String.pad_trailing("partitions=#{partitions} group_by=#{inspect(group_by)}", 32) <>
      "broadcast #{m.(:broadcast_us)} us | pan (20 out, 20 in) #{m.(:pan_us)} us | " <>
      "8 writers x 5k broadcasts #{m.(:concurrent_40k_ms)} ms | 1000 disconnects #{m.(:disconnect_1000_ms)} ms"
  )
end
