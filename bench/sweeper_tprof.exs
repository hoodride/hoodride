# Function-level profile of ONE real Hoodride.Sweeper.sweep_now over a big
# healthy world (every driver also counted at altitude, so the recount does
# real work). tprof call_time: own time per function, every call traced —
# including ETS BIFs — in the sweeping process and anything it spawns.
#
# Run: $env:MIX_ENV="test"; mix run bench/sweeper_tprof.exs [n]

Mix.ensure_application!(:tools)

n = String.to_integer(List.first(System.argv()) || "50000")

Hoodride.TestHelpers.scrub_live_state()
now = System.system_time(:second)

for id <- 1..n do
  cell = "c8-#{rem(id, 500)}"
  :ets.insert(:geo_drivers, {id, cell, cell, now})
  :ets.insert(:geo_by_cell, {{cell, id}, :driver})
  :ets.insert(:geo_parents, {id, :driver, ["c7-#{rem(id, 2000)}", "c5-#{rem(id, 100)}"]})
  :ets.insert(:geo_presence, {id, :online, now})
  rider = 1_000_000 + id
  :ets.insert(:geo_presence, {rider, :online, now})
  :ets.insert(:ride_requests, {rider, id, now})
  :ets.insert(:requests_by_driver, {{id, rider}, now})
  :ets.insert(:rides_by_user, {2_000_000 + id, :pending})
  key = Hoodride.Chat.pair_key(id, rider)
  :ets.insert(:chat_conversations, {key, now})
  :ets.insert(:chat_by_user, [{{id, key}}, {{rider, key}}])
end

# build the tallies so the profiled sweep finds a consistent world
:ok = Hoodride.Geo.recompute_aggregates()

# realistic presence: everyone online holds a UserChannels registration
parent = self()

spawn(fn ->
  for id <- 1..n do
    Registry.register(Hoodride.UserChannels, id, nil)
    Registry.register(Hoodride.UserChannels, 1_000_000 + id, nil)
  end

  send(parent, :registered)
  receive do: (:stop -> :ok)
end)

receive do: (:registered -> :ok)

{us, :ok} = :timer.tc(fn -> Hoodride.Sweeper.sweep_now() end)
IO.puts("#{n} drivers | one untraced sweep_now: #{Float.round(us / 1000, 1)} ms\n")

raw =
  :tprof.profile(fn -> Hoodride.Sweeper.sweep_now() end, %{type: :call_time, report: :return})

# raw: {:ok, {:call_time, [{module, function, arity, [{pid, calls, microseconds}]}]}}
{:ok, {:call_time, per_fun}} = raw

entries =
  for {m, f, a, per_pid} <- per_fun do
    calls = per_pid |> Enum.map(&elem(&1, 1)) |> Enum.sum()
    t = per_pid |> Enum.map(&elem(&1, 2)) |> Enum.sum()
    {m, {m, f, a}, calls, t, nil, nil}
  end

total = entries |> Enum.map(&elem(&1, 3)) |> Enum.sum()

IO.puts("traced total own time: #{Float.round(total / 1000, 1)} ms (tracing adds overhead; shares are what matter)\n")

IO.puts(
  String.pad_trailing("function", 56) <>
    String.pad_leading("calls", 10) <>
    String.pad_leading("own ms", 10) <> String.pad_leading("share", 8)
)

entries
|> Enum.sort_by(fn {_mod, _mfa, _calls, t, _pc, _pct} -> -t end)
|> Enum.take(30)
|> Enum.each(fn {_mod, {m, f, a}, calls, t, _pc, _pct} ->
  IO.puts(
    String.pad_trailing(String.slice("#{inspect(m)}.#{f}/#{a}", 0, 55), 56) <>
      String.pad_leading("#{calls}", 10) <>
      String.pad_leading("#{Float.round(t / 1000, 1)}", 10) <>
      String.pad_leading("#{Float.round(100 * t / total, 1)}%", 8)
  )
end)

Hoodride.TestHelpers.scrub_live_state()
