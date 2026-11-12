defmodule HoodrideWeb.ChatLimitsTest do
  @moduledoc """
  The chat fix (owner, 2026-11-12; abuse review: about 50 accounts chatting
  among themselves could fill the server's 1 GB — 50 messages × 20 KB kept
  per chat, any number of chats, each message also holding its whole
  frame). Now:

    * a chat keeps its newest #{Hoodride.Limits.chat_history()} messages
      AND at most #{Hoodride.Limits.chat_history_bytes()} bytes of them (the
      newest always kept);
    * a message keeps only its own text, never the frame it came in;
    * at most #{Hoodride.Limits.chats_started_open()} open chats each person
      STARTED (a first message) — chats others start, and a ride's own chat,
      never count; the next is refused "too_many_chats";
    * "End chat": either person ends a chat — gone for both, the other told
      who ended it, a slot freed — except with your ride partner mid-ride.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Chat, Limits}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp users(prefix, n) do
    for i <- 1..n do
      {:ok, u} =
        Hoodride.Accounts.upsert_oauth_user(%{
          provider: "dev",
          provider_id: "#{prefix}-#{i}",
          name: "#{prefix}#{i}"
        })

      u
    end
  end

  defp user(name), do: hd(users(name, 1))

  defp tab(user) do
    {:ok, s} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(s, "user:#{user.id}", %{})
    {s, chan}
  end

  defp reply(chan, event, payload) do
    ref = push(chan, event, payload)

    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: p} -> {status, p}
    after
      1_000 -> flunk("no reply to #{event}")
    end
  end

  defp msg(chan, to, text \\ "hi"), do: reply(chan, "send_msg", %{"to" => to.id, "text" => text})

  # a cold contact must be on the sender's screen (HoodrideWeb.Reach)
  @cell "8a2a1072b59ffff"
  defp cars(us),
    do:
      for(
        u <- us,
        do: Hoodride.Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, nil)
      )

  defp watching(socket) do
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    assert {:ok, _} = reply(world, "sync", %{"geo" => [@cell]})
    world
  end

  defp kept(a, b) do
    {:ok, msgs} = Chat.conversation_messages(a.id, Integer.to_string(b.id))
    msgs
  end

  # ---------- what a chat keeps ----------

  test "a chat keeps its newest #{Limits.chat_history()} messages" do
    [a, b] = users("cl-hist", 2)
    for i <- 1..25, do: Chat.send_message(a, b.id, "m#{i}")
    texts = for m <- kept(a, b), do: m.text
    assert length(texts) == Limits.chat_history()
    assert List.last(texts) == "m25"
    assert hd(texts) == "m#{25 - Limits.chat_history() + 1}"
  end

  test "…and at most #{Limits.chat_history_bytes()} bytes of them, the newest always kept" do
    [a, b] = users("cl-bytes", 2)
    big = fn i -> "#{i}" <> String.duplicate("x", 20_000) end
    for i <- 1..6, do: Chat.send_message(a, b.id, big.(i))

    msgs = kept(a, b)
    total = msgs |> Enum.map(&byte_size(&1.text)) |> Enum.sum()
    assert total <= Limits.chat_history_bytes()
    assert String.starts_with?(List.last(msgs).text, "6"), "the newest kept"
    assert length(msgs) == 3

    # one message as big as allowed still fits on its own
    [c, d] = users("cl-one", 2)
    Chat.send_message(c, d.id, String.duplicate("y", Limits.message_bytes()))
    assert [_] = kept(c, d)
  end

  # (the lightreload2 journey, 2026-11-12: older SMALL messages were kept
  # past a big one that no longer fit — a history with a hole in it)
  test "what's kept is always the newest run: no hole where a big one was dropped" do
    [a, b] = users("cl-run", 2)
    for i <- 1..5, do: Chat.send_message(a, b.id, "small#{i}")
    for i <- 1..4, do: Chat.send_message(a, b.id, "#{i}" <> String.duplicate("x", 20_000))

    texts = for m <- kept(a, b), do: m.text
    assert length(texts) == 3, "only the newest 3 big ones fit"
    refute Enum.any?(texts, &String.starts_with?(&1, "small")), "no older message past the gap"
  end

  test "a kept message holds only its own text, never the frame it came in" do
    [a, b] = users("cl-copy", 2)
    frame = String.duplicate("z", 64_000)
    # (over 64 bytes: the runtime copies smaller slices by itself)
    text = binary_part(frame, 0, 1_000)

    assert :binary.referenced_byte_size(text) == 64_000,
           "(the test's premise: a slice of the frame)"

    Chat.send_message(a, b.id, text)

    [{_, _, _, stored, _}] = :ets.lookup(:chat_messages, Chat.pair_key(a.id, b.id))
    assert stored == text
    assert :binary.referenced_byte_size(stored) == 1_000
  end

  # ---------- at most 10 chats you started ----------

  test "an 11th chat you start is refused; your open ones still work" do
    [me | others] = users("cl-cap", Limits.chats_started_open() + 2)
    cars(others)
    {s, chan} = tab(me)
    watching(s)

    {first10, [eleventh | _]} = Enum.split(others, Limits.chats_started_open())
    for o <- first10, do: assert({:ok, _} = msg(chan, o))
    assert Chat.started_open(me.id) == Limits.chats_started_open()

    assert {:error, %{reason: "too_many_chats"}} = msg(chan, eleventh)
    refute Chat.exists?(me.id, eleventh.id), "nothing made"
    assert {:ok, _} = msg(chan, hd(first10), "still talking"), "an open chat still works"
  end

  test "chats others start, and a ride's own chat, never count" do
    [me | others] = users("cl-incoming", Limits.chats_started_open() + 2)

    for o <- Enum.take(others, Limits.chats_started_open()),
        do: Chat.send_message(o, me.id, "hey")

    rider = List.last(others)
    Chat.open(me.id, rider.id)
    assert Chat.started_open(me.id) == 0

    cars([Enum.at(others, -2)])
    {s, chan} = tab(me)
    watching(s)
    assert {:ok, _} = msg(chan, Enum.at(others, -2)), "still free to start one"
  end

  test "a chat that ended frees its slot" do
    [me | others] = users("cl-free", Limits.chats_started_open() + 1)
    for o <- Enum.take(others, Limits.chats_started_open()), do: Chat.send_message(me, o.id, "hi")
    assert Chat.started_open(me.id) == Limits.chats_started_open()
    Chat.delete_conversation(Chat.pair_key(me.id, hd(others).id))
    assert Chat.started_open(me.id) == Limits.chats_started_open() - 1
  end

  # ---------- End chat ----------

  test "End chat: gone for both; the other told who ended it; you're told nothing more" do
    [a, b] = users("cl-end", 2)
    Chat.send_message(b, a.id, "hello")
    {_sa, ca} = tab(a)
    {_sb, _cb} = tab(b)
    a_id = a.id
    b_id = b.id

    assert {:ok, _} = reply(ca, "end_chat", %{"peer" => b.id})
    refute Chat.exists?(a.id, b.id)
    assert :ets.lookup(:chat_messages, Chat.pair_key(a.id, b.id)) == []
    assert_push "chat_closed", %{peer_id: ^a_id, ended_by: ^a_id}
    assert_push "chat_closed", %{peer_id: ^b_id, ended_by: ^a_id}
  end

  test "End chat with your ride partner mid-ride: refused, the chat stays" do
    [a, b] = users("cl-ride", 2)
    Chat.open(a.id, b.id)
    :ets.insert(:rides_by_user, [{a.id, "ride-cl"}, {b.id, "ride-cl"}])
    {_s, ca} = tab(a)

    assert {:error, %{reason: "in_ride"}} = reply(ca, "end_chat", %{"peer" => b.id})
    assert Chat.exists?(a.id, b.id)
  end

  test "End chat with someone you have no chat with, or nonsense: nothing happens" do
    [a, b] = users("cl-none", 2)
    {_s, ca} = tab(a)
    assert {:error, %{reason: "none"}} = reply(ca, "end_chat", %{"peer" => b.id})
    assert {:error, %{reason: "bad_request"}} = reply(ca, "end_chat", %{"peer" => "x"})
    assert {:error, %{reason: "bad_request"}} = reply(ca, "end_chat", %{})
  end

  test "ending frees the slot of whoever started it" do
    me = user("cl-endfree")
    [o | _] = users("cl-endfree-o", 1)
    Chat.send_message(me, o.id, "hi")
    assert Chat.started_open(me.id) == 1
    {_s, co} = tab(o)
    assert {:ok, _} = reply(co, "end_chat", %{"peer" => me.id})
    assert Chat.started_open(me.id) == 0
  end

  test "the sweeper's repair drops a started-chat row whose chat is gone (a send racing a delete)" do
    [a, b] = users("cl-heal", 2)
    :ets.insert(:chat_started, {a.id, Chat.pair_key(a.id, b.id)})
    :ok = Chat.heal_index()
    assert :ets.lookup(:chat_started, a.id) == []
  end
end
