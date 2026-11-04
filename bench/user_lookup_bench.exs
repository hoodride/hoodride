# Per-user lookups before vs after the per-user indexes: one user's
# conversations, and one driver's pending requests, among N UNRELATED rows.
# "before" is the old code (copy the whole table, filter), kept here verbatim.
#
# Run: $env:MIX_ENV="test"; mix run bench/user_lookup_bench.exs

alias Hoodride.{Chat, Requests}

defmodule Before do
  def conversations_for(user_id) do
    :chat_conversations
    |> :ets.tab2list()
    |> Enum.filter(fn {{a, b}, _} -> a == user_id or b == user_id end)
  end

  def pending_for_driver(driver_id) do
    :ride_requests
    |> :ets.tab2list()
    |> Enum.filter(fn {_rider, d, _ts} -> d == driver_id end)
  end
end

measure = fn fun ->
  parent = self()

  spawn(fn ->
    :erlang.garbage_collect()
    {:memory, m0} = Process.info(self(), :memory)
    {us, _} = :timer.tc(fn -> for _ <- 1..100, do: fun.() end)
    {:memory, m1} = Process.info(self(), :memory)
    send(parent, {:done, us / 100, (m1 - m0) / 1024})
  end)

  receive do
    {:done, us, kb} -> {us, kb}
  end
end

fmt = fn {us, kb} -> "#{Float.round(us, 1)} µs, +#{round(kb)} KB" end
p = fn id -> %{id: id, name: "P#{id}", photo: nil} end

IO.puts("#{System.schedulers_online()} schedulers | mean of 100 calls\n")

for n <- [1_000, 10_000, 50_000] do
  Hoodride.TestHelpers.scrub_live_state()

  for i <- 1..n, do: {:ok, _} = Chat.send_message(p.(1_000_000 + i), 2_000_000 + i, "hi")
  for i <- 1..5, do: {:ok, _} = Chat.send_message(p.(1), 10 + i, "ours")

  for d <- 1..100, do: Hoodride.Geo.driver_update(p.(3_000_000 + d), "c8", nil)
  for i <- 1..n, do: :ok = Requests.create(p.(4_000_000 + i), 3_000_000 + rem(i, 100) + 1)
  Hoodride.Geo.driver_update(p.(7), "c8", nil)
  for i <- 1..3, do: :ok = Requests.create(p.(20 + i), 7)

  IO.puts(String.pad_leading("#{n} other rows", 16))

  IO.puts(
    "    conversations_for  before #{fmt.(measure.(fn -> Before.conversations_for(1) end))}" <>
      " | after #{fmt.(measure.(fn -> Chat.conversations_for(1) end))}"
  )

  IO.puts(
    "    pending_for_driver before #{fmt.(measure.(fn -> Before.pending_for_driver(7) end))}" <>
      " | after #{fmt.(measure.(fn -> Requests.pending_for_driver(7) end))}"
  )
end

Hoodride.TestHelpers.scrub_live_state()
