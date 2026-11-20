defmodule Hoodride.ChatEndRaceTest do
  @moduledoc """
  A message sent at the instant its chat ends (End chat, the cleanup, a
  block) — the chat taken AFTER the send found it there but BEFORE its
  message was written (review, 2026-11-20). The message was still sent to
  the other person: their app made a chat for it that the server didn't
  have — opened, "none", gone (a ghost). Now the message starts a new chat,
  as one sent a moment later does (the rule already in send_message): the
  other person's chat is real. Made to happen every time with the send's
  test pause (`:chat_hook`, after its conversation and index are written).
  """
  use ExUnit.Case, async: false

  alias Hoodride.Chat

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    on_exit(fn -> Application.delete_env(:hoodride, :chat_hook) end)
    %{a: %{id: 920_001, name: "RaceA", photo: nil}, b: %{id: 920_002, name: "RaceB", photo: nil}}
  end

  # the chat ended (as End chat by `by`) at the send's pause — once
  defp end_at_pause(key, by) do
    me = self()

    Application.put_env(:hoodride, :chat_hook, fn
      :indexed ->
        if Process.get(:ended) != true do
          Process.put(:ended, true)
          Chat.delete_conversation(key, by)
          send(me, :ended_meanwhile)
        end

      _ ->
        :ok
    end)
  end

  test "a message whose chat ended mid-send: a NEW chat the other one can open — never a ghost",
       %{a: a, b: b} do
    key = Chat.pair_key(a.id, b.id)
    {:ok, _} = Chat.send_message(a, b.id, "first")
    HoodrideWeb.Endpoint.subscribe("user:#{b.id}")
    end_at_pause(key, b.id)

    assert {:ok, %{id: id}} = Chat.send_message(a, b.id, "racing")
    assert_received :ended_meanwhile

    # B is told the old chat ended, then gets the message…
    assert_receive %Phoenix.Socket.Broadcast{event: "chat_closed"}, 1_000
    assert_receive %Phoenix.Socket.Broadcast{event: "msg", payload: %{id: ^id}}, 1_000
    # …for a chat the server HAS: B opening it finds it, with that message
    assert Chat.exists?(a.id, b.id)
    assert {:ok, messages} = Chat.conversation_messages(b.id, Integer.to_string(a.id))
    assert Enum.map(messages, & &1.text) == ["racing"]
    # and it's counted as a chat A started (as any new one)
    assert Chat.started_open(a.id) == 1
  end

  # (the 2026-11-08 server review's "ghost empty chat around a deletion",
  # open until 2026-11-20) the delete TOOK the chat, then a whole send ran
  # before the delete wiped its messages: the send made the chat again, the
  # delete wiped its message — an empty chat left on the server, the
  # sender's message lost though they were told it went. The send and the
  # delete now run one at a time for the pair (a per-pair lock)
  test "a send in the middle of a delete: never an empty chat left with the message lost", %{
    a: a,
    b: b
  } do
    key = Chat.pair_key(a.id, b.id)
    {:ok, _} = Chat.send_message(a, b.id, "first")
    me = self()

    Application.put_env(:hoodride, :chat_hook, fn
      :taken ->
        # a whole send from elsewhere, as the delete pauses after its take
        sender = spawn(fn -> send(me, {:sent, Chat.send_message(a, b.id, "racing")}) end)
        # (without the lock it finishes here; with it, it waits for the delete)
        receive do
          {:sent, _} = done -> send(me, done)
        after
          200 -> send(me, {:waited, sender})
        end

      _ ->
        :ok
    end)

    :ok = Chat.delete_conversation(key)
    Application.delete_env(:hoodride, :chat_hook)
    assert_receive {:sent, {:ok, _}}, 2_000

    # either gone, or there WITH the message — never there and empty
    if Chat.exists?(a.id, b.id) do
      assert {:ok, messages} = Chat.conversation_messages(b.id, Integer.to_string(a.id))
      assert Enum.map(messages, & &1.text) == ["racing"], "the chat there, its message lost"
    end
  end

  test "a message with no pause: unchanged — the chat stays, nothing told closed", %{a: a, b: b} do
    {:ok, _} = Chat.send_message(a, b.id, "first")
    HoodrideWeb.Endpoint.subscribe("user:#{b.id}")
    assert {:ok, _} = Chat.send_message(a, b.id, "second")
    assert_receive %Phoenix.Socket.Broadcast{event: "msg"}, 1_000
    refute_receive %Phoenix.Socket.Broadcast{event: "chat_closed"}, 200
    assert Chat.exists?(a.id, b.id)
  end
end
