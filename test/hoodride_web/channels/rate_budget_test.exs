defmodule HoodrideWeb.RateBudgetTest do
  @moduledoc """
  Rate budgets belong to the USER, not to a channel process. When they
  lived in the channel's assigns, leaving and rejoining refilled them (a
  probe got 210 syncs through in 15 ms against 60/min), and a ride channel
  opened on several connections had a budget on each, all at once.

  Plus a per-user JOIN budget: joins were free and unlimited, and a user
  channel join kicks the account's other session — so a join loop was
  free work and a kick loop.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.RateBudget

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    %{a: user("sl-a"), b: user("sl-b")}
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  defp connect_as(u),
    do:
      (
        {:ok, s} =
          connect(HoodrideWeb.UserSocket, %{},
            connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
          )

        s
      )

  defp reply(chan, event, payload) do
    ref = push(chan, event, payload)

    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: p} -> {status, p}
    after
      1_000 -> :timeout
    end
  end

  defp limited?(r), do: match?({:error, %{reason: "rate_limited"}}, r)

  defp rejoin(chan, socket, topic) do
    Process.unlink(chan.channel_pid)
    ref = leave(chan)
    assert_reply ref, :ok
    {:ok, _, chan} = subscribe_and_join(socket, topic, %{})
    chan
  end

  test "map: leaving and rejoining does NOT refill the sync budget", %{a: a} do
    socket = connect_as(a)
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    results = for i <- 1..30, do: reply(world, "sync", %{"geo" => ["c#{i}"]})
    assert Enum.any?(results, &limited?/1), "the budget never ran out"

    world = rejoin(world, socket, "world")
    assert limited?(reply(world, "sync", %{"geo" => ["fresh"]}))
  end

  test "map: a reveal after a rejoin spends the same budget", %{a: a} do
    socket = connect_as(a)
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    for i <- 1..30, do: reply(world, "sync", %{"geo" => ["c#{i}"]})

    world = rejoin(world, socket, "world")
    assert limited?(reply(world, "reveal", %{"id" => 1}))
  end

  test "user channel: rejoining does NOT refill the event budget", %{a: a} do
    socket = connect_as(a)
    {:ok, _, chan} = subscribe_and_join(socket, "user:#{a.id}", %{})
    results = for _ <- 1..40, do: reply(chan, "cancel_request", %{})
    assert Enum.any?(results, &limited?/1)

    chan = rejoin(chan, socket, "user:#{a.id}")
    assert limited?(reply(chan, "cancel_request", %{}))
  end

  test "ride: two connections share ONE budget", %{a: a, b: b} do
    {:ok, ride_id} = Hoodride.Rides.start_ride(a.id, b.id)
    {:ok, _, c1} = subscribe_and_join(connect_as(a), "ride:#{ride_id}", %{})
    {:ok, _, c2} = subscribe_and_join(connect_as(a), "ride:#{ride_id}", %{})

    # an unknown event spends the ride budget and answers bad_request — or
    # rate_limited once the budget is gone
    results =
      for i <- 1..40 do
        reply(if(rem(i, 2) == 0, do: c1, else: c2), "__probe", %{})
      end

    passed = Enum.count(results, &match?({:error, %{reason: "bad_request"}}, &1))
    # 120/min, burst 30 → 31 at once: for the USER, not per connection
    assert passed == 31, "#{passed} passed across two connections"
  end

  test "the shared budget is atomic: parallel spends never overshoot" do
    # 16 processes released at the same instant (a barrier), each spending
    # 20 times, in 50 rounds: a read-then-write would let two racing spends
    # both pass somewhere. Burst 10 → exactly 11 at one instant, every round.
    for round <- 1..50 do
      user = 9_000_000 + round
      parent = self()

      pids =
        for _ <- 1..16 do
          spawn_link(fn ->
            receive do: (:go -> :ok)

            oks =
              Enum.count(1..20, fn _ ->
                match?({:ok, _}, RateBudget.spend(user, :test, 60, 10, 0))
              end)

            send(parent, {:oks, oks})
          end)
        end

      Enum.each(pids, &send(&1, :go))
      total = Enum.sum(for _ <- pids, do: receive(do: ({:oks, n} -> n)))
      assert total == 11, "round #{round}: #{total} spends passed (11 allowed)"
    end
  end

  describe "joins" do
    test "a burst of 31 joins passes; then refused with the exact wait", %{a: a} do
      socket = connect_as(a)
      results = for _ <- 1..40, do: subscribe_and_join(socket, "world", %{})

      assert Enum.count(results, &match?({:ok, _, _}, &1)) == 31

      assert [{:error, %{reason: "rate_limited", retry_ms: wait}} | _] =
               Enum.drop(results, 31)

      assert wait > 0 and wait <= 2_000
    end

    test "a refused user-channel join does no work: the live user channel is not kicked",
         %{a: a} do
      socket = connect_as(a)
      {:ok, _, first} = subscribe_and_join(socket, "user:#{a.id}", %{})
      for _ <- 1..30, do: subscribe_and_join(socket, "world", %{})

      # an allowed second join would hand the live channel over
      # (session_moved); a refused one must not touch it
      assert {:error, %{reason: "rate_limited"}} =
               subscribe_and_join(socket, "user:#{a.id}", %{})

      refute_push "session_moved", %{}, 100
      assert Process.alive?(first.channel_pid)
    end

    test "a refused ride join does no work either", %{a: a, b: b} do
      {:ok, ride_id} = Hoodride.Rides.start_ride(a.id, b.id)
      socket = connect_as(a)
      for _ <- 1..31, do: subscribe_and_join(socket, "world", %{})

      assert {:error, %{reason: "rate_limited"}} =
               subscribe_and_join(socket, "ride:#{ride_id}", %{})
    end

    test "joins are one budget per user: another user is unaffected", %{a: a, b: b} do
      socket = connect_as(a)
      for _ <- 1..31, do: subscribe_and_join(socket, "world", %{})
      assert {:ok, _, _} = subscribe_and_join(connect_as(b), "world", %{})
    end
  end

  test "an ordinary reconnect is unaffected: all three channels join, budgets carry on",
       %{a: a, b: b} do
    {:ok, ride_id} = Hoodride.Rides.start_ride(a.id, b.id)

    for _round <- 1..3 do
      socket = connect_as(a)
      assert {:ok, _, _} = subscribe_and_join(socket, "user:#{a.id}", %{})
      assert {:ok, _, world} = subscribe_and_join(socket, "world", %{})
      assert {:ok, _, _} = subscribe_and_join(socket, "ride:#{ride_id}", %{})
      assert {:ok, _} = reply(world, "sync", %{"geo" => ["home"]})
    end
  end

  # ----- one socket per account (HoodrideWeb.UserSocket) -----
  # Phoenix.ChannelTest runs connect/3 but no real socket process, so an
  # "older socket" is a process subscribed to the account's socket topic —
  # exactly what a real socket process is — reporting what it receives.
  defp fake_socket(user) do
    test = self()

    spawn_link(fn ->
      Phoenix.PubSub.subscribe(Hoodride.PubSub, "user_socket:#{user.id}")
      send(test, {:subscribed, self()})
      relay(test)
    end)
    |> tap(fn pid -> assert_receive {:subscribed, ^pid} end)
  end

  defp relay(test) do
    receive do
      msg ->
        send(test, {:socket_got, self(), msg})
        relay(test)
    end
  end

  # a user channel registered against `transport`, as the real one is
  defp fake_user_channel(user, transport) do
    test = self()

    spawn_link(fn ->
      {:ok, _} = Registry.register(Hoodride.UserChannels, user.id, transport)
      send(test, {:registered, self()})
      relay(test)
    end)
    |> tap(fn pid -> assert_receive {:registered, ^pid} end)
  end

  defp closed?(pid),
    do:
      match?({:socket_got, ^pid, %Phoenix.Socket.Broadcast{event: "disconnect"}}, next_from(pid))

  defp next_from(pid) do
    receive do
      {:socket_got, ^pid, _} = m -> m
    after
      150 -> nil
    end
  end

  describe "one socket per account" do
    test "a new connect closes an older socket that holds no user channel", %{a: a} do
      old = fake_socket(a)
      connect_as(a)
      assert closed?(old)
    end

    test "an older socket WITH a user channel gets the hand-over, not a bare close",
         %{a: a} do
      old = fake_socket(a)
      chan = fake_user_channel(a, old)
      connect_as(a)

      assert {:socket_got, ^chan, :session_moved} = next_from(chan)
      # its own channel closes it after telling the app — never we, first
      assert next_from(old) == nil
    end

    test "another user's sockets are untouched", %{a: a, b: b} do
      theirs = fake_socket(b)
      connect_as(a)
      assert next_from(theirs) == nil
    end

    test "connects are budgeted: 21 at once, then refused — and a refused one kicks no one",
         %{a: a} do
      results =
        for _ <- 1..21,
            do:
              connect(HoodrideWeb.UserSocket, %{},
                connect_info: %{session: Hoodride.TestHelpers.session_for(a.id)}
              )

      assert Enum.all?(results, &match?({:ok, _}, &1))
      old = fake_socket(a)

      assert {:error, :rate_limited} =
               connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{session: Hoodride.TestHelpers.session_for(a.id)}
               )

      assert next_from(old) == nil
    end
  end

  describe "the join deadline" do
    setup do
      before = Application.get_env(:hoodride, :join_deadline_ms)
      Application.put_env(:hoodride, :join_deadline_ms, 100)

      on_exit(fn ->
        if before,
          do: Application.put_env(:hoodride, :join_deadline_ms, before),
          else: Application.delete_env(:hoodride, :join_deadline_ms)
      end)
    end

    test "a socket that never joins its user channel is closed", %{a: a} do
      connect_as(a)
      # the new socket (subscribes right after connect, like the real one)
      mine = fake_socket(a)
      assert_receive {:socket_got, ^mine, %Phoenix.Socket.Broadcast{event: "disconnect"}}, 500
    end

    # a deploy: the old server stops, and deadlines still pending fire after
    # the user-channel registry has already shut down. They used to crash
    # ("unknown registry: Hoodride.UserChannels" — 124 errors in one second
    # of a 4,000-person deploy, burying any real one); the server is going
    # away, so there is nothing to enforce.
    test "a deadline firing while the server shuts down does nothing — no crash", %{a: a} do
      token = make_ref()
      :ets.insert(:socket_slots, {a.id, token})
      mine = fake_socket(a)

      assert :ok =
               HoodrideWeb.UserSocket.enforce_join_deadline(
                 a.id,
                 token,
                 :registry_already_stopped
               )

      refute_receive {:socket_got, ^mine, %Phoenix.Socket.Broadcast{event: "disconnect"}}, 100
    end

    test "a socket that joined its user channel stays", %{a: a} do
      connect_as(a)
      mine = fake_socket(a)
      fake_user_channel(a, mine)
      refute_receive {:socket_got, ^mine, %Phoenix.Socket.Broadcast{event: "disconnect"}}, 300
    end

    test "an older connect's deadline is void: only the latest connect's counts", %{a: a} do
      connect_as(a)
      Process.sleep(60)
      # a newer connect: from here, the first deadline (due at ~100 ms) must
      # not close the newer socket, which joins its user channel at ~120 ms
      connect_as(a)
      mine = fake_socket(a)
      Process.sleep(60)
      fake_user_channel(a, mine)
      refute_receive {:socket_got, ^mine, %Phoenix.Socket.Broadcast{event: "disconnect"}}, 300
    end
  end

  test "the sweeper forgets budgets that have fully refilled, and only those" do
    now = System.monotonic_time(:millisecond)
    :ets.insert(:rate_budgets, {{:sync, 1}, now - 5_000})
    :ets.insert(:rate_budgets, {{:sync, 2}, now + 60_000})

    Hoodride.Sweeper.sweep_now()

    assert :ets.lookup(:rate_budgets, {:sync, 1}) == []
    assert [_] = :ets.lookup(:rate_budgets, {:sync, 2})
  end

  test "the very FIRST spends race too: a fresh allowance is never handed out twice" do
    # a fresh row every round, 32 processes released at once, ONE spend
    # each: the "no row yet" moment is where they collide. A blind insert
    # (instead of insert_new) lets two first spends both pass while the row
    # counts one — measured on this machine: 164 of 500 such rounds.
    for round <- 1..300 do
      user = 9_200_000 + round
      parent = self()

      pids =
        for _ <- 1..32 do
          spawn_link(fn ->
            receive do: (:go -> :ok)
            send(parent, {:spent, elem(RateBudget.spend(user, :test, 60, 10, 0), 0)})
          end)
        end

      Enum.each(pids, &send(&1, :go))
      oks = Enum.count(pids, fn _ -> receive(do: ({:spent, r} -> r)) == :ok end)
      assert oks == 11, "round #{round}: #{oks} first spends passed (11 allowed)"
    end
  end

  # ---------- the cleanup: every row, every kind, only once it's full ----------

  test "the Sweeper's tick drops full rows and keeps rows still in use" do
    now = System.monotonic_time(:millisecond)
    # full again long ago: its row is the same as none
    for _ <- 1..3, do: RateBudget.spend(9_200_001, :test, 60, 10, now - 3_600_000)
    # in use right now: 5 spends → its allowance refills over the next ~5 s
    for _ <- 1..5, do: RateBudget.spend(9_200_002, :test, 60, 10, now)

    Hoodride.Sweeper.sweep_now()

    assert :ets.lookup(:rate_budgets, {:test, 9_200_001}) == [], "a full allowance's row is swept"
    assert [_] = :ets.lookup(:rate_budgets, {:test, 9_200_002}), "a row in use is kept"
  end

  test "a sweep while an allowance is still partly used leaves it — and its count", %{a: _} do
    user = 9_200_003
    for _ <- 1..11, do: RateBudget.spend(user, :test, 60, 10, 0)
    # 5 s later: 5 slots refilled, 6 still to go — the row must survive with
    # its count: exactly 5 more pass (a wrongly swept row would give 11)
    RateBudget.sweep(5_000)
    assert [_] = :ets.lookup(:rate_budgets, {:test, user})
    results = for _ <- 1..6, do: elem(RateBudget.spend(user, :test, 60, 10, 5_000), 0)
    assert results == [:ok, :ok, :ok, :ok, :ok, :deny]
  end

  test "the HTTP and handshake rows, as the real code writes them, are swept once full", %{a: a} do
    # restore, not delete: tests run with config.exs budgets ON — a delete
    # switched them off for every test after this one (order-dependent)
    saved = for k <- [:http_budget, :ws_budget], do: {k, Application.get_env(:hoodride, k)}
    Application.put_env(:hoodride, :http_budget, per_minute: 60, burst: 120)
    Application.put_env(:hoodride, :ws_budget, per_minute: 60, burst: 120)
    on_exit(fn -> Hoodride.TestHelpers.restore_env(saved) end)

    signed_out = %{Phoenix.ConnTest.build_conn() | remote_ip: {198, 51, 100, 90}}
    Phoenix.ConnTest.dispatch(signed_out, @endpoint, :get, "/api/me")

    signed_in =
      Phoenix.ConnTest.build_conn()
      |> Phoenix.ConnTest.init_test_session(Hoodride.TestHelpers.session_for(a.id))

    Phoenix.ConnTest.dispatch(signed_in, @endpoint, :get, "/api/me")

    connect(HoodrideWeb.UserSocket, %{},
      connect_info: %{
        peer_data: %{address: {0x2001, 0xDB8, 4, 4, 1, 1, 1, 1}, port: 1, ssl_cert: nil},
        x_headers: [],
        auth_token: "x"
      }
    )

    keys = :ets.tab2list(:rate_budgets) |> Enum.map(&elem(&1, 0))
    assert {:http, {:http, {198, 51, 100, 90}}} in keys
    assert {:http, {:http_user, a.id}} in keys
    assert {:ws, {:ws, {:v6_64, 0x2001, 0xDB8, 4, 4}}} in keys

    # an hour on, all three are full again: swept
    RateBudget.sweep(System.monotonic_time(:millisecond) + 3_600_000)
    assert :ets.tab2list(:rate_budgets) == []
  end

  test "a row swept away mid-use: the next spend starts a fresh allowance and is counted" do
    user = 9_100_001
    # spend everything at t=0 (burst 10 → 11)
    for _ <- 1..11, do: assert({:ok, _} = RateBudget.spend(user, :test, 60, 10, 0))
    assert {:deny, _} = RateBudget.spend(user, :test, 60, 10, 0)

    # an hour later the allowance is full again and the sweeper drops the row
    hour = 3_600_000
    RateBudget.sweep(hour)
    assert :ets.lookup(:rate_budgets, {:test, user}) == []

    # the next spend recreates the row (insert_new) and is COUNTED: a fresh
    # burst, then refused exactly as before
    results = for _ <- 1..12, do: elem(RateBudget.spend(user, :test, 60, 10, hour), 0)
    assert Enum.count(results, &(&1 == :ok)) == 11
    assert List.last(results) == :deny
  end

  test "a sweep racing live spends never loses one (they retry onto a fresh row)" do
    user = 9_100_002
    parent = self()

    # spenders at t=0 while a sweeper with a clock far ahead keeps deleting
    # the row under them: every spend either lands or is refused — and the
    # row only ever holds counted spends, so no more than one burst can
    # pass between two sweeps
    sweeper =
      spawn_link(fn ->
        receive do: (:go -> :ok)
        for _ <- 1..200, do: RateBudget.sweep(3_600_000)
        send(parent, :swept)
      end)

    spenders =
      for _ <- 1..8 do
        spawn_link(fn ->
          receive do: (:go -> :ok)
          results = for _ <- 1..50, do: elem(RateBudget.spend(user, :test, 60, 10, 0), 0)
          send(parent, {:spent, results})
        end)
      end

    Enum.each([sweeper | spenders], &send(&1, :go))
    assert_receive :swept, 5_000
    all = Enum.flat_map(spenders, fn _ -> receive(do: ({:spent, r} -> r)) end)

    # no crash, every spend answered — and with the sweeper gone, the budget
    # is enforced again: whatever the row holds (or a fresh one), 12 spends
    # in a row at one instant always end in a refusal
    assert length(all) == 400
    assert Enum.all?(all, &(&1 in [:ok, :deny]))
    after_race = for _ <- 1..12, do: elem(RateBudget.spend(user, :test, 60, 10, 0), 0)
    assert List.last(after_race) == :deny
  end
end
