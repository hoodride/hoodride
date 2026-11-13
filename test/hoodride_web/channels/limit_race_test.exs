defmodule HoodrideWeb.LimitRaceTest do
  @moduledoc """
  Step 7 part 4 (owner, 2026-11-13: "do now with test to prove"). The
  per-account limits (Hoodride.Throttle) were LOOKED AT first and CHARGED
  only once the message or request had gone — two steps. One account has
  one live session, and a session handles its events one at a time; but
  during a hand-over (a new tab or device taking over) the old and the new
  session are both live for a moment, and both could pass the last allowed
  contact before either was charged: 21 new people in the hour, not 20.

  Now the allowance is taken FIRST, in one atomic step, and given back if
  the contact doesn't go through (a refusal still spends nothing).

  In a channel test the hand-over's "you moved" only reaches the test
  process, so both sessions stay live — the hand-over window, held open.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  @hour 3_600_000
  @minute 60_000
  @new_chats Hoodride.Limits.new_chats_per_hour()
  @messages Hoodride.Limits.messages_per_minute()
  @rounds 5

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user!(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  defp connect_as(user) do
    {:ok, s} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    s
  end

  defp tab(user) do
    {:ok, _, chan} = subscribe_and_join(connect_as(user), "user:#{user.id}", %{})
    chan
  end

  # strangers on the map in `cell`, and `user` watching it (a cold contact
  # must be on the sender's screen: HoodrideWeb.Reach)
  defp on_screen(user, strangers, cell) do
    for s <- strangers,
        do: Hoodride.Geo.driver_update(%{id: s.id, name: s.name, photo: nil}, cell, nil)

    {:ok, _, world} = subscribe_and_join(connect_as(user), "world", %{})
    ref = push(world, "sync", %{"geo" => [cell]})
    assert_reply ref, :ok
  end

  # both sessions send at the same instant; both answers
  defp at_once(tab1, to1, tab2, to2) do
    r1 = push(tab1, "send_msg", %{"to" => to1.id, "text" => "hi"})
    r2 = push(tab2, "send_msg", %{"to" => to2.id, "text" => "hi"})
    [answer(r1), answer(r2)]
  end

  defp answer(ref) do
    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: p} -> {status, p}
    after
      2_000 -> flunk("no answer")
    end
  end

  test "two live sessions at the last new contact of the hour: exactly one gets through" do
    a = user!("race-a")
    [t1, t2] = [tab(a), tab(a)]
    strangers = for i <- 1..(2 * @rounds), do: user!("race-s#{i}")
    on_screen(a, strangers, "cRace")

    for [s1, s2] <- Enum.chunk_every(strangers, 2) do
      # one short of the hour's limit
      Hoodride.RateLimit.set({:new_conv, a.id}, @hour, @new_chats - 1)

      answers = at_once(t1, s1, t2, s2)
      assert Enum.count(answers, &match?({:ok, _}, &1)) == 1, inspect(answers)
      assert Enum.count(answers, &match?({:error, %{reason: "too_many_new_chats"}}, &1)) == 1
      assert Hoodride.RateLimit.get({:new_conv, a.id}, @hour) == @new_chats

      # (the chats ended: the next round's are new again)
      for s <- [s1, s2], do: Hoodride.Chat.delete_conversation(Hoodride.Chat.pair_key(a.id, s.id))
    end
  end

  test "a new chat refused for having too many open: the allowances it took are back" do
    a = user!("race-room")
    t = tab(a)
    open = Hoodride.Limits.chats_started_open()
    strangers = for i <- 1..(open + 1), do: user!("race-r#{i}")
    on_screen(a, strangers, "cRaceR")

    for s <- Enum.take(strangers, open) do
      ref = push(t, "send_msg", %{"to" => s.id, "text" => "hi"})
      assert_reply ref, :ok, _
    end

    counts = fn ->
      {Hoodride.RateLimit.get({:new_conv, a.id}, @hour),
       Hoodride.RateLimit.get({:msg, a.id}, @minute)}
    end

    before = counts.()
    ref = push(t, "send_msg", %{"to" => List.last(strangers).id, "text" => "hi"})
    assert_reply ref, :error, %{reason: "too_many_chats"}
    assert counts.() == before
  end

  test "a give-back never goes below 0 and never starts a window (a free extra)" do
    key = {:new_conv, -42}
    assert Hoodride.RateLimit.give_back(key) == :ok
    assert :ets.lookup(Hoodride.RateLimit, key) == []

    Hoodride.RateLimit.set(key, @hour, 0)
    Hoodride.RateLimit.give_back(key)
    assert Hoodride.RateLimit.get(key, @hour) == 0

    Hoodride.RateLimit.set(key, @hour, 2)
    Hoodride.RateLimit.give_back(key)
    assert Hoodride.RateLimit.get(key, @hour) == 1
  end

  test "two live sessions at the last message of the minute: exactly one goes" do
    a = user!("race-m")
    [t1, t2] = [tab(a), tab(a)]
    [b, c] = [user!("race-mb"), user!("race-mc")]
    on_screen(a, [b, c], "cRaceM")

    for _ <- 1..@rounds do
      Hoodride.RateLimit.set({:msg, a.id}, @minute, @messages - 1)

      answers = at_once(t1, b, t2, c)
      assert Enum.count(answers, &match?({:ok, _}, &1)) == 1, inspect(answers)
      assert Enum.count(answers, &match?({:error, %{reason: "rate_limited"}}, &1)) == 1
      assert Hoodride.RateLimit.get({:msg, a.id}, @minute) == @messages
    end
  end
end
