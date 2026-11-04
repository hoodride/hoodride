# How long the hex-count recount stalls the map writers, by world size —
# the batched recount (many short pauses, safeguarded EWMA, 250 µs target).
# Reported: the LONGEST single pause per recount, the number of pauses, the
# whole recount's wall time, and what one cell crossing costs a writer.
#
# For comparison, the single-pause recount this replaced measured (same
# bench, 2026-10-22): writers paused 0.6 ms at 1k, 4.0 ms at 10k and 27.6 ms
# at 50k people; whole recount 2.5 / 16.2 / 79.7 ms.
#
# Run: $env:MIX_ENV="test"; mix run bench/recount_pause_bench.exs

alias Hoodride.Geo

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end
f1 = fn x -> :erlang.float_to_binary(x / 1, decimals: 1) end
f2 = fn x -> :erlang.float_to_binary(x / 1, decimals: 2) end

IO.puts("#{System.schedulers_online()} schedulers | median of 7 | pause cap #{Geo.max_pause_ms()} ms\n")

for n <- [1_000, 10_000, 50_000] do
  Hoodride.TestHelpers.scrub_live_state()

  # through the real write paths (parents, counts, membership all in step):
  # half drivers, half hands, two parent cells each (res 7 + res 5)
  for id <- 1..n do
    parents = ["c7-#{rem(id, 2_000)}", "c5-#{rem(id, 100)}"]

    if rem(id, 2) == 0,
      do: Geo.driver_update(%{id: id, name: "d#{id}", photo: nil}, "c8-#{id}", nil, parents),
      else: Geo.hand_up(id, "c8-#{id}", "c9-#{id}", parents)
  end

  :ok = Geo.recompute_aggregates()

  runs =
    for _ <- 1..7 do
      {us, :ok} = :timer.tc(&Geo.recompute_aggregates/0)
      stats = Process.get({Geo, :last_recount})
      {us / 1000, stats.max_pause_us / 1000, stats.pauses}
    end

  ms = Enum.map(runs, &elem(&1, 0))
  pause = Enum.map(runs, &elem(&1, 1))

  IO.puts(
    String.pad_leading("#{n} people", 14) <>
      " | longest pause median #{f2.(median.(pause))} ms (worst #{f2.(Enum.max(pause))})" <>
      " | #{median.(Enum.map(runs, &elem(&1, 2)))} pauses" <>
      " | whole recount #{f1.(median.(ms))} ms"
  )
end

# a writer's cost per update, inside the shard (no GenServer round trip)
Hoodride.TestHelpers.scrub_live_state()
a = ["c7-a", "c5-a"]
b = ["c7-b", "c5-a"]
for u <- 1..1_000, do: Geo.driver_update(%{id: u, name: "w", photo: nil}, "c8", nil, a)

{cross, _} =
  :timer.tc(fn ->
    for i <- 1..100_000 do
      u = rem(i, 1_000) + 1
      Geo.driver_update_now(%{id: u, name: "w", photo: nil}, "c8", "c8", if(rem(div(i, 1_000), 2) == 0, do: b, else: a))
    end
  end)

{same, _} =
  :timer.tc(fn ->
    for i <- 1..100_000 do
      u = rem(i, 1_000) + 1
      Geo.driver_update_now(%{id: u, name: "w", photo: nil}, "c8", "c8", a)
    end
  end)

IO.puts(
  "\nwriter cost per update (100k, inside the shard): cell crossing #{f2.(cross / 100_000)} µs," <>
    " same cells #{f2.(same / 100_000)} µs"
)

Hoodride.TestHelpers.scrub_live_state()
