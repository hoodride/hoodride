# Old vs live index heals, interleaved round by round over a 50k healthy
# world. "old" is the previous code verbatim (stale pass always runs).
#
# Run: $env:MIX_ENV="test"; mix run bench/heal_ab_bench.exs

import Hoodride.ETS, only: [each_match: 3, fold_match: 4]

n = 50_000
Hoodride.TestHelpers.scrub_live_state()
now = System.system_time(:second)

for id <- 1..n do
  rider = 1_000_000 + id
  :ets.insert(:ride_requests, {rider, id, now})
  :ets.insert(:requests_by_driver, {{id, rider}, now})
  key = Hoodride.Chat.pair_key(id, rider)
  :ets.insert(:chat_conversations, {key, now})
  :ets.insert(:chat_by_user, [{{id, key}}, {{rider, key}}])
end

old_chat = fn ->
  stale =
    fold_match(:chat_by_user, [{{{:_, :"$1"}}, [], [:"$_"]}], [], fn {{_u, key}} = row, acc ->
      if :ets.member(:chat_conversations, key), do: acc, else: [row | acc]
    end)

  for {{_u, key}} = row <- stale, not :ets.member(:chat_conversations, key),
      do: :ets.delete_object(:chat_by_user, row)

  each_match(:chat_conversations, [{{:"$1", :_}, [], [:"$1"]}], fn {a, b} = key ->
    unless :ets.member(:chat_by_user, {a, key}) and :ets.member(:chat_by_user, {b, key}),
      do: :ets.insert(:chat_by_user, [{{a, key}}, {{b, key}}])
  end)
end

old_req = fn ->
  each_match(:ride_requests, [{:"$1", [], [:"$1"]}], fn {r, d, ts} ->
    unless :ets.member(:requests_by_driver, {d, r}),
      do: :ets.insert(:requests_by_driver, {{d, r}, ts})
  end)

  cutoff = System.system_time(:second) - 300

  stale =
    fold_match(:requests_by_driver, [{{:_, :"$1"}, [{:<, :"$1", cutoff}], [:"$_"]}], [], fn
      {{d, r}, _} = row, acc ->
        if match?([{_, ^d, _}], :ets.lookup(:ride_requests, r)), do: acc, else: [row | acc]
    end)

  Enum.each(stale, &:ets.delete_object(:requests_by_driver, &1))
end

variants = [
  {"chat heal  old", old_chat},
  {"chat heal  now", &Hoodride.Chat.heal_index/0},
  {"req heal   old", old_req},
  {"req heal   now", fn -> Hoodride.Requests.heal_index(300) end}
]

run = fn f -> Task.async(fn -> elem(:timer.tc(f), 0) / 1000 end) |> Task.await(:infinity) end

times =
  for _ <- 1..15, {name, f} <- variants, reduce: %{} do
    acc -> Map.update(acc, name, [run.(f)], &[run.(f) | &1])
  end

IO.puts("index heals, #{n} conversations + #{n} requests | 15 interleaved rounds\n")

for {name, _} <- variants do
  ts = Enum.sort(times[name])

  IO.puts(
    String.pad_trailing(name, 18) <>
      "min #{:erlang.float_to_binary(hd(ts), decimals: 1)} ms" <>
      "   median #{:erlang.float_to_binary(Enum.at(ts, 7), decimals: 1)} ms"
  )
end

# the heals changed nothing on a healthy world
true = :ets.info(:chat_by_user, :size) == 2 * n
true = :ets.info(:requests_by_driver, :size) == n
Hoodride.TestHelpers.scrub_live_state()
