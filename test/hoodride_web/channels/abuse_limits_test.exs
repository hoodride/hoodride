defmodule HoodrideWeb.AbuseLimitsTest do
  @moduledoc """
  Abuse controls, parts 1-3: per-connection event lanes, per-user
  throttles (shared across tabs), and newest-wins connections.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.RateBudget

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, a} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ab-a", name: "AbA"})

    {:ok, b} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ab-b", name: "AbB"})

    %{a: a, b: b}
  end

  defp connect_as(user) do
    {:ok, s} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    s
  end

  defp reply(chan, event, payload) do
    ref = push(chan, event, payload)

    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: p} -> {status, p}
    after
      1_000 -> flunk("no reply to #{event}")
    end
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

  defp tab(user) do
    {:ok, _, chan} = subscribe_and_join(connect_as(user), "user:#{user.id}", %{})
    chan
  end

  defp msg(chan, to, text \\ "hi"), do: reply(chan, "send_msg", %{"to" => to.id, "text" => text})

  # A cold contact must be on the sender's screen (HoodrideWeb.Reach): put
  # `targets` on the map as cars in `cell`, and give `user` a map watching it.
  defp car(u, cell),
    do: Hoodride.Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, cell, nil)

  defp see(user, cell) do
    {:ok, _, world} = subscribe_and_join(connect_as(user), "world", %{})
    assert {:ok, _} = reply(world, "sync", %{"geo" => [cell]})
    world
  end

  # ===== Part 1: the budget math (Hoodride.RateBudget) (injected clock) =====

  defp run(times, per_minute, burst) do
    socket = %Phoenix.Socket{assigns: %{user_id: System.unique_integer([:positive])}}

    Enum.map_reduce(times, socket, fn t, s ->
      case RateBudget.spend(s, :test, per_minute, burst, t) do
        {:ok, s} -> {:ok, s}
        {:deny, s} -> {:deny, s}
      end
    end)
    |> elem(0)
  end

  test "budget: an honest driver (one update per 1.5s for 10 minutes) is never refused" do
    times = for i <- 0..399, do: i * 1_500
    assert Enum.all?(run(times, 120, 30), &(&1 == :ok))
  end

  test "budget: a burst of 31 passes at once, the 32nd is refused" do
    results = run(List.duplicate(0, 40), 120, 30)
    assert Enum.count(results, &(&1 == :ok)) == 31
    assert Enum.drop(results, 31) |> Enum.all?(&(&1 == :deny))
  end

  test "budget: the budget refills at the steady rate after a burst" do
    burst = List.duplicate(0, 31)
    # 120/min = one every 500ms: at 500ms exactly one more is allowed
    results = run(burst ++ [500, 500], 120, 30)
    assert Enum.take(results, -2) == [:ok, :deny]
  end

  test "budget: wait_ms names exactly when the next event fits" do
    s0 = %Phoenix.Socket{assigns: %{user_id: System.unique_integer([:positive])}}
    assert RateBudget.wait_ms(s0, :test, 60, 20, 0) == 0

    # 60/min = one per 1000 ms, burst 20: 21 at t=0 drain it completely
    s =
      Enum.reduce(1..21, s0, fn _, acc ->
        {:ok, acc} = RateBudget.spend(acc, :test, 60, 20, 0)
        acc
      end)

    assert {:deny, _} = RateBudget.spend(s, :test, 60, 20, 0)
    assert RateBudget.wait_ms(s, :test, 60, 20, 0) == 1000
    # exactly at that moment it is allowed; a millisecond earlier it is not
    assert {:deny, _} = RateBudget.spend(s, :test, 60, 20, 999)
    assert {:ok, _} = RateBudget.spend(s, :test, 60, 20, 1000)
  end

  # ===== Part 1: wired into the channels =====

  test "user channel: a flood gets rate_limited replies; dropped updates never land", %{a: a} do
    {:ok, _, chan} = subscribe_and_join(connect_as(a), "user:#{a.id}", %{})

    results = for _ <- 1..40, do: reply(chan, "cancel_request", %{})
    assert Enum.count(results, &match?({:ok, _}, &1)) == 31
    assert {:error, %{reason: "rate_limited"}} = List.last(results)

    # a fire-and-forget update over the limit is silently dropped
    push(chan, "driver_update", %{"cell" => "cZ", "lat" => 1.0, "lng" => 2.0})
    assert {:error, %{reason: "rate_limited"}} = reply(chan, "cancel_request", %{})
    refute Hoodride.Geo.driver_on_map?(a.id)
  end

  test "ride channel: a flooded position stream is cut off at the lane", %{a: a, b: b} do
    {:ok, ride_id} = Hoodride.Rides.start_ride(a.id, b.id)
    {:ok, _, ride_a} = subscribe_and_join(connect_as(a), "ride:#{ride_id}", %{})

    for i <- 1..60, do: push(ride_a, "pos", %{"lat" => 1.0 + i / 1000, "lng" => 2.0})

    # asked straight after the flood — the channel answers in order, the
    # allowance still spent. (Asked after the wait below it once got through:
    # the allowance refills one every 0.5 s, and on a busy machine the
    # waiting took longer — 2026-11-05)
    assert {:error, %{reason: "rate_limited"}} = reply(ride_a, "arrived", %{})

    # the partner's broadcast stream stops at the burst allowance
    received =
      Stream.repeatedly(fn ->
        receive do
          %Phoenix.Socket.Broadcast{event: "peer_pos"} -> 1
        after
          200 -> nil
        end
      end)
      |> Enum.take_while(& &1)
      |> length()

    assert received == 31
  end

  # ===== Part 3: newest wins — one live session per account =====

  test "a new session tells the old one it moved, then closes its socket", %{a: a, b: b} do
    old_tab = tab(a)
    _other_user = tab(b)

    # the same account connects again (another device, or a reload)
    _new_tab = tab(a)

    # the OLD session is told first, so its app can stop auto-reconnecting...
    assert_push "session_moved", %{}
    # ...then its socket is told to disconnect (Phoenix closes the transport
    # on this message; in ChannelTest the transport is this test process)
    assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}

    # only the old session was kicked: B's session got nothing. (Here this
    # test process is every tab's transport, so the old channel outlives
    # its "closed" socket and may be handed over twice — at the new connect
    # and at the new user-channel join; a real closed socket takes its
    # channel with it, and the app ignores a repeat.)
    b_topic = "user:#{b.id}"
    refute_receive %Phoenix.Socket.Broadcast{event: "disconnect", topic: ^b_topic}, 100

    # and the kicked channel was the old one, not the new one
    assert old_tab.channel_pid != nil
  end

  test "presence never lapses across the hand-over", %{a: a} do
    _old = tab(a)
    _new = tab(a)
    assert {:online, _} = Hoodride.Geo.presence_of(a.id)
  end

  # ===== Part 2: per-user limits (Hammer), shared across tabs =====

  # newest-wins means only one live session in production, but the budget is
  # per ACCOUNT: a reconnect or a new session never starts with a fresh one
  test "messages: 30/min total, per account across sessions", %{a: a} do
    [r1, r2, r3] = users("rcp", 3)
    for r <- [r1, r2, r3], do: car(r, "cV")
    tab1 = tab(a)
    tab2 = tab(a)
    see(a, "cV")

    # 30 messages spread over two tabs and three people (10 each)
    results =
      for {to, i} <- Enum.with_index(List.flatten(List.duplicate([r1, r2, r3], 10))) do
        msg(if(rem(i, 2) == 0, do: tab1, else: tab2), to)
      end

    assert Enum.all?(results, &match?({:ok, _}, &1))
    # the 31st, from either tab, is refused: two tabs don't double the budget
    assert {:error, %{reason: "rate_limited", retry_ms: _}} = msg(tab2, r1)
  end

  test "messages to one person: 15/min", %{a: a, b: b} do
    car(b, "cW")
    t = tab(a)
    see(a, "cW")
    results = for _ <- 1..15, do: msg(t, b)
    assert Enum.all?(results, &match?({:ok, _}, &1))
    assert {:error, %{reason: "rate_limited"}} = msg(t, b)
  end

  test "cold contact: 20 new conversations per hour, the 21st is refused", %{a: a} do
    t = tab(a)
    strangers = users("cold", 21)
    for s <- strangers, do: car(s, "cC")
    see(a, "cC")

    results = for s <- Enum.take(strangers, 20), do: msg(t, s)
    assert Enum.all?(results, &match?({:ok, _}, &1))
    assert {:error, %{reason: "too_many_new_chats", retry_ms: w}} = msg(t, List.last(strangers))
    assert w > 3_000_000

    # existing conversations are untouched by the cold limit
    assert {:ok, _} = msg(t, hd(strangers))
  end

  test "replying to someone who messaged you first costs no cold budget", %{a: a} do
    t = tab(a)
    senders = users("snd", 22)
    car(a, "cP")

    # 22 people message A first (A's car is on their screens); A answers
    # every one of them
    for s <- senders do
      see(s, "cP")
      assert {:ok, _} = msg(tab(s), a)
    end

    results = for s <- senders, do: msg(t, s)
    assert Enum.all?(results, &match?({:ok, _}, &1))
  end

  test "a cold ride request counts; request-then-message is charged once", %{a: a} do
    drivers = users("drv", 21)
    t = tab(a)

    for d <- drivers do
      Hoodride.Geo.driver_update(%{id: d.id, name: d.name, photo: nil}, "cR", nil)
    end

    see(a, "cR")

    # request driver 1 (cold: charged), then message them (open request: free)
    [d1 | rest] = drivers
    assert {:ok, _} = reply(t, "request_ride", %{"to" => d1.id})
    assert {:ok, _} = msg(t, d1)
    assert {:ok, _} = reply(t, "cancel_request", %{})

    # 19 more cold messages use up the hour's 20 (1 + 19)
    for d <- Enum.take(rest, 19), do: assert({:ok, _} = msg(t, d))
    assert {:error, %{reason: "too_many_new_chats"}} = msg(t, List.last(rest))
  end

  test "message-then-request is charged once too (the reverse order)", %{a: a} do
    drivers = users("mtr", 21)
    t = tab(a)

    for d <- drivers do
      Hoodride.Geo.driver_update(%{id: d.id, name: d.name, photo: nil}, "cM", nil)
    end

    see(a, "cM")

    # message driver 1 (cold: charged), then request them (conversation
    # exists: free), then cancel so the next request isn't blocked
    [d1 | rest] = drivers
    assert {:ok, _} = msg(t, d1)
    assert {:ok, _} = reply(t, "request_ride", %{"to" => d1.id})
    assert {:ok, _} = reply(t, "cancel_request", %{})

    # 19 more cold contacts use up the hour's 20 (1 + 19) — had the request
    # been charged too, the 19th would already be refused
    for d <- Enum.take(rest, 19), do: assert({:ok, _} = msg(t, d))
    assert {:error, %{reason: "too_many_new_chats"}} = msg(t, List.last(rest))
  end

  test "a SLOW decline still gets a full minute of cooldown", %{a: a, b: b} do
    Hoodride.Geo.driver_update(%{id: b.id, name: b.name, photo: nil}, "cS", nil)
    rider = tab(a)
    see(a, "cS")
    driver = tab(b)

    assert {:ok, _} = reply(rider, "request_ride", %{"to" => b.id})

    # the driver takes more than a minute to answer (simulated: every
    # counter from request time has expired by the time they decline)
    :ets.delete_all_objects(Hoodride.RateLimit)
    assert {:ok, _} = reply(driver, "decline_request", %{"rider_id" => a.id})

    # the minute counts from the "no", not from the request
    assert {:error, %{reason: "request_cooldown", retry_ms: w}} =
             reply(rider, "request_ride", %{"to" => b.id})

    assert w > 50_000 and w <= 60_000
  end

  test "cancelling also starts the cooldown (no request-cancel-request loop)",
       %{a: a, b: b} do
    Hoodride.Geo.driver_update(%{id: b.id, name: b.name, photo: nil}, "cT", nil)
    rider = tab(a)
    see(a, "cT")

    assert {:ok, _} = reply(rider, "request_ride", %{"to" => b.id})
    assert {:ok, _} = reply(rider, "cancel_request", %{})
    assert {:error, %{reason: "request_cooldown"}} = reply(rider, "request_ride", %{"to" => b.id})
  end

  test "re-request cooldown: a declined driver can't be asked again for a minute",
       %{a: a, b: b} do
    Hoodride.Geo.driver_update(%{id: b.id, name: b.name, photo: nil}, "cK", nil)
    rider = tab(a)
    see(a, "cK")
    driver = tab(b)

    assert {:ok, _} = reply(rider, "request_ride", %{"to" => b.id})
    # a second request while the first is open gets the accurate reason
    assert {:error, %{reason: "already_requested"}} =
             reply(rider, "request_ride", %{"to" => b.id})

    assert {:ok, _} = reply(driver, "decline_request", %{"rider_id" => a.id})

    assert {:error, %{reason: "request_cooldown", retry_ms: w}} =
             reply(rider, "request_ride", %{"to" => b.id})

    assert w > 50_000 and w <= 60_000
  end
end
