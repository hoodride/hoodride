defmodule Hoodride.MessageIdTest do
  @moduledoc """
  Ids people see never count what EVERYONE does (leftovers review,
  2026-11-13). A message's id was one counter for the whole server: two of
  your own messages' ids, minutes apart, told you how many messages the
  whole site sent in between. A ride's id likewise ("r4675": rides since
  the start).

    * a message's id is the time it was sent, in microseconds (one more
      than the last if two land in the same instant): still in order — the
      app sorts and pages by it — and it tells only the time, which the
      message's own `ts` already says. It keeps rising across restarts too
      (the counter started again at 1);
    * a ride's id is random.
  """
  use ExUnit.Case, async: false

  alias Hoodride.Chat

  @a 9_100_000_001
  @b 9_100_000_002
  @c 9_100_000_003
  @d 9_100_000_004

  setup do
    on_exit(fn ->
      Chat.delete_conversation(Chat.pair_key(@a, @b))
      Chat.delete_conversation(Chat.pair_key(@c, @d))
    end)
  end

  defp person(id), do: %{id: id, name: "x", photo: nil}
  defp send!(from, to), do: elem(Chat.send_message(person(from), to, "hi"), 1).id

  test "a message's id is its send time (µs) — not a count of everyone's messages" do
    before = System.os_time(:microsecond)
    first = send!(@a, @b)
    for _ <- 1..50, do: send!(@c, @d)
    second = send!(@a, @b)
    later = System.os_time(:microsecond)

    for id <- [first, second], do: assert(id >= before and id <= later + 1_000, "id #{id}")
  end

  test "still strictly in order, even many in the same instant" do
    ids = for _ <- 1..2_000, do: send!(@a, @b)
    assert ids == Enum.sort(ids)
    assert length(Enum.uniq(ids)) == length(ids)
  end

  test "still strictly in order across senders at once" do
    ids =
      1..8
      |> Task.async_stream(fn _ -> for _ <- 1..300, do: send!(@c, @d) end, timeout: :infinity)
      |> Enum.flat_map(fn {:ok, ids} -> ids end)

    assert length(Enum.uniq(ids)) == length(ids)
  end

  # (review 2026-11-14) a message into an EXISTING chat wrote the chat's row
  # again: an "End chat" landing between the check and that write brought
  # the ended chat back, uncounted (no "started by" row). Now it's touched
  # in place — gone meanwhile: a new chat, counted as one
  test "a message into an existing chat touches it in place; ended meanwhile: a new chat, counted" do
    [_, send] = String.split(File.read!("lib/hoodride/chat.ex"), "def send_message(", parts: 2)
    [send | _] = String.split(send, "\n  def ", parts: 2)
    assert send =~ ":ets.update_element(@conversations, key, {2, now})"
    refute send =~ ":ets.insert(@conversations, {key, now})"

    # an ordinary exchange still works, in one chat
    send!(@a, @b)
    send!(@b, @a)
    assert [_] = Chat.conversations_for(@a)
  end

  test "a ride's id is random, not a count of rides" do
    src = File.read!("lib/hoodride/rides.ex")
    refute src =~ ~s(id = "r" <> Integer.to_string(System.unique_integer)
    assert src =~ ":crypto.strong_rand_bytes"
  end
end
