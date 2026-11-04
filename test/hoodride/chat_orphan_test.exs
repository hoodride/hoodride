defmodule Hoodride.ChatOrphanTest do
  @moduledoc """
  A message sent at the instant its chat is closed (one person away past
  grace — Sweeper.sweep_empty_room_chats) can be written AFTER the chat and
  its messages were removed: a message with no conversation. Losing that
  message is the accepted trade-off (a message to someone away is lost with
  the chat), but its TEXT stayed in memory until the next restart — the
  repair pass removed orphan index rows and blocks from this race, not
  orphan messages — breaking the privacy page's "gone soon after". Found in
  the race audit, 2026-10-29; truly parallel, the race orphaned a message
  in about 340 of 500 rounds.
  """
  use ExUnit.Case

  alias Hoodride.Chat

  @moduletag timeout: 120_000

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    %{a: %{id: 910_001, name: "OrphA", photo: nil}, b: %{id: 910_002, name: "OrphB", photo: nil}}
  end

  defp orphans do
    for {key, _id, _from, _text, _ts} = row <- :ets.tab2list(:chat_messages),
        not :ets.member(:chat_conversations, key),
        do: row
  end

  test "the repair removes a message whose conversation is gone", %{a: a, b: b} do
    key = Chat.pair_key(a.id, b.id)
    :ets.insert(:chat_messages, {key, 1, a.id, "orphaned text", System.system_time(:second)})
    assert orphans() != []
    Chat.heal_index()
    assert orphans() == []
  end

  test "…and keeps every message whose conversation still exists", %{a: a, b: b} do
    {:ok, _} = Chat.send_message(a, b.id, "still here")
    Chat.heal_index()
    assert [{_, _, _, "still here", _}] = :ets.lookup(:chat_messages, Chat.pair_key(a.id, b.id))
  end

  # truly parallel (busy-wait to one shared moment — plain spawns hide races)
  defp wait_until(t), do: if(System.monotonic_time(:microsecond) < t, do: wait_until(t))

  test "a send racing the close: after one repair, no message text is left orphaned", %{
    a: a,
    b: b
  } do
    key = Chat.pair_key(a.id, b.id)

    for _ <- 1..500 do
      Chat.open(a.id, b.id)
      parent = self()
      start = System.monotonic_time(:microsecond) + 2_000

      for f <- [
            fn -> Chat.send_message(a, b.id, "racing") end,
            fn -> Chat.delete_conversation(key) end
          ] do
        spawn(fn ->
          wait_until(start)
          f.()
          send(parent, :done)
        end)
      end

      for _ <- 1..2, do: assert_receive(:done, 5_000)
      Chat.heal_index()
      assert orphans() == [], "an orphaned message survived the repair"
      Chat.delete_conversation(key)
      :ets.delete(:chat_messages, key)
    end
  end
end
