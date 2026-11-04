# Untraced cost of the building blocks the tprof profile pointed at, on the
# same 50k world: raw ETS lookups/members (the exact counts one sweep makes),
# paging a table through each_match with a no-op, and the closure layer.
#
# Run: $env:MIX_ENV="test"; mix run bench/sweeper_cost_parts.exs

n = 50_000
Hoodride.TestHelpers.scrub_live_state()
now = System.system_time(:second)

for id <- 1..n do
  :ets.insert(:geo_drivers, {id, "c8", "c8", now})
  rider = 1_000_000 + id
  :ets.insert(:ride_requests, {rider, id, now})
  key = Hoodride.Chat.pair_key(id, rider)
  :ets.insert(:chat_conversations, {key, now})
  :ets.insert(:chat_by_user, [{{id, key}}, {{rider, key}}])
end

time = fn fun ->
  runs = for _ <- 1..5, do: elem(:timer.tc(fun), 0) / 1000
  runs |> Enum.sort() |> Enum.at(2)
end

line = fn label, ms -> IO.puts(String.pad_trailing(label, 62) <> :erlang.float_to_binary(ms, decimals: 1) <> " ms") end

line.("400k :ets.lookup on a set (hits)", time.(fn -> for i <- 1..400_000, do: :ets.lookup(:geo_drivers, rem(i, n) + 1) end))
line.("350k :ets.member on a set (hits)", time.(fn -> for i <- 1..350_000, do: :ets.member(:geo_drivers, rem(i, n) + 1) end))
line.("100k :ets.member on the ordered_set index", time.(fn ->
  for i <- 1..100_000 do
    id = rem(i, n) + 1
    :ets.member(:chat_by_user, {id, Hoodride.Chat.pair_key(id, 1_000_000 + id)})
  end
end))
line.("page 50k rows via each_match, no-op", time.(fn ->
  Hoodride.ETS.each_match(:geo_drivers, [{{:"$1", :_, :_, :_}, [], [:"$1"]}], fn _ -> :ok end)
end))
line.("page 100k index rows via each_match, no-op", time.(fn ->
  Hoodride.ETS.each_match(:chat_by_user, [{:"$1", [], [:"$1"]}], fn _ -> :ok end)
end))
line.("same 50k rows, one plain :ets.select (no paging), no-op", time.(fn ->
  :ets.select(:geo_drivers, [{{:"$1", :_, :_, :_}, [], [:"$1"]}]) |> Enum.each(fn _ -> :ok end)
end))
line.("one presence_of (Registry + ETS) x 100k", time.(fn -> for i <- 1..100_000, do: Hoodride.Geo.presence_of(i) end))

Hoodride.TestHelpers.scrub_live_state()
