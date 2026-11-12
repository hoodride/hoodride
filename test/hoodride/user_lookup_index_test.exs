defmodule Hoodride.UserLookupIndexTest do
  @moduledoc """
  Per-user lookups read only that user's rows, never the whole table:
  conversations on reload, a driver's pending requests, and the decline-all
  that runs every time a driver becomes unavailable.
  """
  use ExUnit.Case

  @moduletag timeout: 120_000

  alias Hoodride.{Chat, Requests}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp person(id), do: %{id: id, name: "P#{id}", photo: nil}

  defp on_map(id),
    do: Hoodride.Geo.driver_update(person(id), "cell8", nil)

  # How much a fresh process's memory grows while running `fun` — a full
  # table copy shows up as heap growth proportional to the table.
  defp heap_growth_bytes(fun) do
    parent = self()

    spawn(fn ->
      :erlang.garbage_collect()
      {:memory, before} = Process.info(self(), :memory)
      result = fun.()
      {:memory, aft} = Process.info(self(), :memory)
      send(parent, {:grew, aft - before, result})
    end)

    receive do
      {:grew, bytes, result} -> {bytes, result}
    end
  end

  defp table_bytes(table), do: :ets.info(table, :memory) * :erlang.system_info(:wordsize)

  # 10,000 conversations between OTHER people, plus one of ours
  defp crowd_of_conversations do
    for i <- 1..10_000, do: {:ok, _} = Chat.send_message(person(100_000 + i), 200_000 + i, "hi")
    {:ok, _} = Chat.send_message(person(1), 2, "ours")
  end

  # 10,000 open requests aimed at OTHER drivers, plus one at driver 1
  defp crowd_of_requests do
    for d <- 1..100, do: on_map(10_000 + d)
    for i <- 1..10_000, do: :ok = Requests.create(person(50_000 + i), 10_000 + rem(i, 100) + 1)
    on_map(1)
    :ok = Requests.create(person(2), 1)
  end

  describe "memory guards: a lookup must not copy the table" do
    test "conversations_for reads only the user's conversations" do
      crowd_of_conversations()

      {grew, [conv]} = heap_growth_bytes(fn -> Chat.conversations_for(1) end)
      assert conv.peer_id == 2

      assert grew < div(table_bytes(:chat_conversations), 10),
             "conversations_for grew #{grew} B — the conversations table is " <>
               "#{table_bytes(:chat_conversations)} B, so it copied the table"
    end

    test "pending_for_driver reads only that driver's requests" do
      crowd_of_requests()

      {grew, [%{rider_id: 2}]} = heap_growth_bytes(fn -> Requests.pending_for_driver(1) end)

      assert grew < div(table_bytes(:ride_requests), 10),
             "pending_for_driver grew #{grew} B of a #{table_bytes(:ride_requests)} B table"
    end

    test "decline_all_for_driver reads only that driver's requests" do
      crowd_of_requests()

      {grew, :ok} = heap_growth_bytes(fn -> Requests.decline_all_for_driver(1) end)
      assert Requests.open_request_of(2) == nil
      assert Requests.open_request_of(50_001) != nil

      assert grew < div(table_bytes(:ride_requests), 10),
             "decline_all_for_driver grew #{grew} B of a #{table_bytes(:ride_requests)} B table"
    end
  end

  # The ETS calls `fun` makes, in order, as {function, table} — via call
  # tracing, so a write-order rule is checked deterministically instead of
  # hoping a stress test hits a nanosecond-wide interleaving.
  defp ets_calls(fun, tables) do
    parent = self()
    funs = [:insert, :insert_new, :delete, :delete_object, :take]
    for f <- funs, do: :erlang.trace_pattern({:ets, f, 2}, true, [])

    worker =
      spawn(fn ->
        receive do: (:go -> fun.())
        send(parent, :done)
      end)

    :erlang.trace(worker, true, [:call])
    send(worker, :go)
    assert_receive :done, 5_000
    ref = :erlang.trace_delivered(worker)
    assert_receive {:trace_delivered, ^worker, ^ref}, 5_000
    for f <- funs, do: :erlang.trace_pattern({:ets, f, 2}, false, [])

    collect_calls(worker, tables, [])
  end

  defp collect_calls(worker, tables, acc) do
    receive do
      {:trace, ^worker, :call, {:ets, f, [table | _]}} ->
        acc = if table in tables, do: [{f, table} | acc], else: acc
        collect_calls(worker, tables, acc)
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp first_index(calls, pred), do: Enum.find_index(calls, pred)

  describe "write-order contracts (traced)" do
    test "chat: a send writes the conversation BEFORE its index rows" do
      calls =
        ets_calls(fn -> Chat.send_message(person(1), 2, "x") end, [
          :chat_conversations,
          :chat_by_user
        ])

      # (a new chat's first write is insert_new — who started it is known by
      # it, Chat @started; the chat fix, 2026-11-12)
      conv =
        first_index(
          calls,
          &(&1 in [{:insert, :chat_conversations}, {:insert_new, :chat_conversations}])
        )

      idx = first_index(calls, &(&1 == {:insert, :chat_by_user}))
      assert conv && idx && conv < idx, "send order was #{inspect(calls)}"
    end

    test "chat: a delete removes the index rows BEFORE the conversation" do
      {:ok, _} = Chat.send_message(person(1), 2, "x")

      calls =
        ets_calls(fn -> Chat.delete_conversation(Chat.pair_key(1, 2)) end, [
          :chat_conversations,
          :chat_by_user
        ])

      idx_dels = for {{:delete, :chat_by_user}, i} <- Enum.with_index(calls), do: i
      # (the conversation is TAKEN, so only the call that removed it
      # announces chat_closed — the order rule is the same)
      conv =
        first_index(
          calls,
          &(&1 in [{:delete, :chat_conversations}, {:take, :chat_conversations}])
        )

      assert (length(idx_dels) == 2 and conv) && Enum.max(idx_dels) < conv,
             "delete order was #{inspect(calls)}"
    end

    test "requests: a create indexes BEFORE inserting; a cancel takes BEFORE un-indexing" do
      on_map(10)
      tables = [:ride_requests, :requests_by_driver]

      calls = ets_calls(fn -> :ok = Requests.create(person(1), 10) end, tables)
      idx = first_index(calls, &(&1 == {:insert, :requests_by_driver}))
      main = first_index(calls, &(&1 == {:insert_new, :ride_requests}))
      assert idx && main && idx < main, "create order was #{inspect(calls)}"

      calls = ets_calls(fn -> :ok = Requests.cancel(1) end, tables)
      take = first_index(calls, &(&1 == {:take, :ride_requests}))
      unidx = first_index(calls, &(&1 == {:delete_object, :requests_by_driver}))
      assert take && unidx && take < unidx, "cancel order was #{inspect(calls)}"
    end
  end

  describe "chat index" do
    test "both sides see the conversation, with the right peer; delete removes it for both" do
      {:ok, _} = Chat.send_message(person(1), 2, "a")
      {:ok, _} = Chat.send_message(person(3), 1, "b")
      {:ok, _} = Chat.send_message(person(4), 5, "not ours")

      assert Enum.sort(Enum.map(Chat.conversations_for(1), & &1.peer_id)) == [2, 3]
      assert [%{peer_id: 1}] = Chat.conversations_for(2)
      assert [%{peer_id: 1}] = Chat.conversations_for(3)

      Chat.delete_conversation(Chat.pair_key(1, 2))
      assert [%{peer_id: 3}] = Chat.conversations_for(1)
      assert Chat.conversations_for(2) == []

      # its index rows went too (not merely hidden by the confirm-on-read)
      gone = Chat.pair_key(1, 2)
      assert :ets.match_object(:chat_by_user, {{:_, gone}}) == []
    end

    test "a leftover index row never shows a ghost, and the sweep removes it" do
      ghost = Chat.pair_key(1, 9)
      :ets.insert(:chat_by_user, [{{1, ghost}}, {{9, ghost}}])

      assert Chat.conversations_for(1) == []
      Chat.heal_index()
      assert :ets.tab2list(:chat_by_user) == []
    end

    test "a conversation missing its index rows is re-indexed by the sweep" do
      key = Chat.pair_key(1, 2)
      :ets.insert(:chat_conversations, {key, System.system_time(:second)})
      assert Chat.conversations_for(1) == []

      Chat.heal_index()
      assert [%{peer_id: 2}] = Chat.conversations_for(1)
      assert [%{peer_id: 1}] = Chat.conversations_for(2)
    end

    test "race: sends and deletes on the SAME conversation never leave it unindexed" do
      # the write order's guarantee, no sweep involved: whatever the
      # interleaving, a surviving conversation has both index rows
      key = Chat.pair_key(1, 2)

      senders =
        for from <- [1, 2, 1, 2] do
          Task.async(fn ->
            for _ <- 1..1_500, do: Chat.send_message(person(from), 3 - from, "x")
          end)
        end

      deleters =
        for _ <- 1..2 do
          Task.async(fn -> for _ <- 1..1_500, do: Chat.delete_conversation(key) end)
        end

      Task.await_many(senders ++ deleters, 60_000)

      if :ets.member(:chat_conversations, key) do
        assert :ets.member(:chat_by_user, {1, key}) and :ets.member(:chat_by_user, {2, key})
        assert [%{peer_id: 2}] = Chat.conversations_for(1)
      end
    end
  end

  describe "request index" do
    defp index_row(driver, rider), do: :ets.lookup(:requests_by_driver, {driver, rider})

    test "every way a request ends removes its index row; put-backs keep it" do
      for d <- [10, 20, 30, 40], do: on_map(d)

      # cancel
      :ok = Requests.create(person(1), 10)
      :ok = Requests.cancel(1)
      assert index_row(10, 1) == []

      # decline by the right driver
      :ok = Requests.create(person(2), 10)
      :ok = Requests.decline(10, 2)
      assert index_row(10, 2) == []

      # decline / accept by the WRONG driver: put back, still indexed
      :ok = Requests.create(person(3), 20)
      {:error, :not_yours} = Requests.decline(99, 3)
      {:error, :not_yours} = Requests.accept(person(99), 3)
      assert [_] = index_row(20, 3)

      # decline-all (the driver goes offline)
      Hoodride.Geo.driver_offline(20)
      assert index_row(20, 3) == []

      # expiry
      :ok = Requests.create(person(4), 30)
      Requests.expire_older_than(-1)
      assert index_row(30, 4) == []
    end

    test "accepting (ride starts) removes the index row" do
      {:ok, r} =
        Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ix-r", name: "IxR"})

      {:ok, d} =
        Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ix-d", name: "IxD"})

      on_map(d.id)

      :ok = Requests.create(person(r.id), d.id)
      assert {:ok, _ride} = Requests.accept(person(d.id), r.id)
      assert index_row(d.id, r.id) == []
    end

    test "consuming a request deletes only ITS row, never a newer one for the same pair" do
      on_map(10)
      :ok = Requests.create(person(1), 10)
      [{_, ts}] = index_row(10, 1)

      # a newer request between the same pair has already re-written the row
      :ets.insert(:requests_by_driver, {{10, 1}, ts + 1})
      :ok = Requests.cancel(1)

      assert [{_, newer}] = index_row(10, 1)
      assert newer == ts + 1
    end

    test "a losing create restores the standing request's own index row" do
      on_map(10)
      :ok = Requests.create(person(1), 10)

      # make the standing request visibly older than any new attempt
      ts = System.system_time(:second) - 100
      :ets.insert(:ride_requests, {1, 10, ts})
      :ets.insert(:requests_by_driver, {{10, 1}, ts})

      # same rider asks the same driver again: refused, and the index row
      # still carries the STANDING request's ts (the attempt overwrote it)
      assert {:error, :already_requested} = Requests.create(person(1), 10)
      assert [{_, ^ts}] = index_row(10, 1)

      # same rider asks ANOTHER driver: refused, and leaves no stray row
      on_map(20)
      assert {:error, :already_requested} = Requests.create(person(1), 20)
      assert index_row(20, 1) == []
    end

    test "a leftover index row never shows, and the sweep removes it only past the TTL" do
      now = System.system_time(:second)
      # an old leftover (no request behind it) and a young one (could be a
      # create still in flight: index written, main row not yet)
      :ets.insert(:requests_by_driver, {{10, 1}, now - 1_000})
      :ets.insert(:requests_by_driver, {{10, 2}, now})

      assert Requests.pending_for_driver(10) == []

      Requests.heal_index(300)
      assert index_row(10, 1) == []
      assert [_] = index_row(10, 2)
    end

    test "a request missing its index row is re-indexed by the sweep" do
      now = System.system_time(:second)
      :ets.insert(:ride_requests, {1, 10, now})
      assert Requests.pending_for_driver(10) == []

      Requests.heal_index(300)
      assert [%{rider_id: 1, ts: ^now}] = Requests.pending_for_driver(10)
    end
  end
end
