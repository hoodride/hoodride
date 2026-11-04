# Where does one sweep's time go? Times the REAL pass functions one by one
# (no copies), untraced, over a big healthy world where every driver is also
# counted at altitude, so the hex recount does real work too.
# Pair with bench/sweeper_tprof.exs for call counts per function.
#
# Run: $env:MIX_ENV="test"; mix run bench/sweeper_profile_bench.exs [n]

alias Hoodride.{Chat, Geo, Requests, Sweeper}

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
  key = Chat.pair_key(id, rider)
  :ets.insert(:chat_conversations, {key, now})
  :ets.insert(:chat_by_user, [{{id, key}}, {{rider, key}}])
end

:ok = Geo.recompute_aggregates()

# realistic presence: everyone online holds a UserChannels registration (one
# holder process may register many keys in a duplicate registry), so
# presence checks take the "connected" path, as in production
parent = self()

holder =
  spawn(fn ->
    for id <- 1..n do
      Registry.register(Hoodride.UserChannels, id, nil)
      Registry.register(Hoodride.UserChannels, 1_000_000 + id, nil)
    end

    send(parent, :registered)
    receive do: (:stop -> :ok)
  end)

receive do: (:registered -> :ok)

phases = [
  {"expire_stale_requests", &Sweeper.expire_stale_requests/0},
  {"heal_orphan_ride_slots", &Sweeper.heal_orphan_ride_slots/0},
  {"sweep_stale_geo", &Sweeper.sweep_stale_geo/0},
  {"heal_geo_consistency (incl. cell index drift)", &Sweeper.heal_geo_consistency/0},
  {"  of which Geo.cell_index_drift", &Geo.cell_index_drift/0},
  {"heal_unlawful_requests", &Sweeper.heal_unlawful_requests/0},
  {"Requests.heal_index", fn -> Requests.heal_index(300) end},
  {"sweep_empty_room_chats", &Sweeper.sweep_empty_room_chats/0},
  {"Chat.heal_index", &Chat.heal_index/0},
  {"Geo.recompute_aggregates", &Geo.recompute_aggregates/0},
  {"WHOLE sweep_now", &Sweeper.sweep_now/0}
]

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end
IO.puts("#{n} drivers (+#{n} requests, conversations, seats, counted parents) | median of 7, ms\n")

for {name, fun} <- phases do
  # each run in a fresh process, like the sweeper's own
  runs =
    for _ <- 1..7 do
      Task.async(fn -> elem(:timer.tc(fun), 0) / 1000 end) |> Task.await(:infinity)
    end

  IO.puts(
    String.pad_trailing(name, 50) <>
      "min " <>
      String.pad_leading(:erlang.float_to_binary(Enum.min(runs), decimals: 1), 6) <>
      "   median " <> String.pad_leading(:erlang.float_to_binary(median.(runs), decimals: 1), 6)
  )
end

send(holder, :stop)
true = :ets.info(:geo_drivers, :size) == n
Hoodride.TestHelpers.scrub_live_state()
