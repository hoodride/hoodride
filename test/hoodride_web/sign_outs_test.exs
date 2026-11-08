defmodule HoodrideWeb.SignOutsTest do
  @moduledoc """
  Socket connects without the database (the capacity test: 3,000 people
  connecting at once ran the pool of 5 dry — every connect read the user to
  check the token against a sign-out — and ~half got HTTP 500).

  A DENYLIST instead (token revocation's usual answer: entries kept only
  while the tokens they revoke could still be valid): `Hoodride.SignOuts`
  holds, in memory, when each account signed out — only sign-outs from the
  last 30 days (every session and token issued before one is expired by
  then). The token carries the name and photo the socket needs, so a
  connect is a signature check and one memory lookup. Loaded at start-up
  (after migrations, before the web server), written FIRST on sign-out.

  Since 2026-11-08 a connection pass names its SIGN-IN (Hoodride.SessionTokens,
  also in memory): signing out deletes the sign-ins, so the pass is refused —
  still with no database read. The sign-out list stays written for the
  release before (a rollback keeps refusing).
  """
  use HoodrideWeb.ConnCase, async: false

  require Phoenix.ChannelTest

  alias Hoodride.{Accounts, SignOuts}

  @day_ms 86_400_000

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key, attrs \\ %{}) do
    {:ok, u} =
      Accounts.upsert_oauth_user(
        Map.merge(%{provider: "dev", provider_id: key, name: key}, attrs)
      )

    u
  end

  defp now_ms, do: System.system_time(:millisecond)

  defp connect(token),
    do:
      Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{}, connect_info: %{auth_token: token})

  # the database queries THIS process makes while `fun` runs
  defp queries_during(fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> if self() == me, do: send(me, {:query, meta.query}) end,
      nil
    )

    try do
      result = fun.()
      {result, collect([])}
    after
      :telemetry.detach(id)
    end
  end

  defp collect(acc) do
    receive do
      {:query, q} -> collect([q | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "a connect" do
    test "makes NO database query (signature + one memory lookup)" do
      u = user("so-noq")
      token = Hoodride.TestHelpers.socket_token_for(u.id)
      {result, queries} = queries_during(fn -> connect(token) end)
      assert {:ok, _} = result
      assert queries == []
    end

    test "carries the name and photo from the token to the socket (chat, ride requests use them)" do
      u = user("so-np", %{photo: "https://example.com/p.jpg"})
      {:ok, socket} = connect(Hoodride.TestHelpers.socket_token_for(u.id))
      assert socket.assigns.user == %{id: u.id, name: "so-np", photo: "https://example.com/p.jpg"}
    end

    test "after a sign-out: the old token is refused, a new one works — still with no query" do
      u = user("so-out")
      old = Hoodride.TestHelpers.socket_token_for(u.id)
      Process.sleep(2)
      :ok = Accounts.mark_logged_out(u.id)

      {result, queries} = queries_during(fn -> connect(old) end)
      assert result == :error
      assert queries == []

      Process.sleep(2)
      assert {:ok, _} = connect(Hoodride.TestHelpers.socket_token_for(u.id))
    end

    test "a token issued in the same millisecond as the sign-out is refused (strictly after)" do
      t = now_ms()
      SignOuts.put(4_294_967_311, t)
      refute SignOuts.allowed?(4_294_967_311, t)
      assert SignOuts.allowed?(4_294_967_311, t + 1)
      assert SignOuts.allowed?(4_294_967_312, t), "never signed out: allowed"
    end

    # everyone signed in once more at the switch to sign-in tokens (owner,
    # 2026-11-08): a pass naming no sign-in is no pass — the app fetches a
    # new one, and a browser no longer signed in shows the sign-in screen
    test "a pass from before the switch (no sign-in named) is refused, whatever it carries" do
      u = user("so-legacy")

      for old <- [
            %{u: u.id, iat: now_ms()},
            %{u: u.id, iat: now_ms(), n: "so-legacy", p: nil}
          ] do
        assert connect(Phoenix.Token.sign(HoodrideWeb.Endpoint, "user socket", old)) == :error
      end
    end
  end

  describe "the denylist" do
    test "of two sign-outs the LATER time wins, in either order" do
      SignOuts.put(4_294_967_321, 2_000)
      SignOuts.put(4_294_967_321, 1_000)
      refute SignOuts.allowed?(4_294_967_321, 1_500)

      SignOuts.put(4_294_967_322, 1_000)
      SignOuts.put(4_294_967_322, 2_000)
      refute SignOuts.allowed?(4_294_967_322, 1_500)
    end

    test "sign-out writes it (and the database: a restart keeps it)" do
      u = user("so-db")
      token = Hoodride.TestHelpers.socket_token_for(u.id)
      before = now_ms()
      Process.sleep(2)
      :ok = Accounts.mark_logged_out(u.id)
      refute SignOuts.allowed?(u.id, before)

      # a restart: the tables empty, the start-up loads refill them
      :ets.delete_all_objects(:sign_outs)
      :ets.delete_all_objects(:session_tokens)
      assert SignOuts.load() == :ok
      assert Hoodride.SessionTokens.load() == :ok
      assert connect(token) == :error
    end

    test "the start-up load takes the last 30 days' sign-outs, not older ones" do
      recent = user("so-29d")
      old = user("so-31d")
      now = now_ms()
      Accounts.mark_logged_out(recent.id, now - 29 * @day_ms)
      Accounts.mark_logged_out(old.id, now - 31 * @day_ms)
      :ets.delete_all_objects(:sign_outs)

      SignOuts.load(now)
      assert :ets.lookup(:sign_outs, recent.id) == [{recent.id, now - 29 * @day_ms}]
      assert :ets.lookup(:sign_outs, old.id) == []
    end

    test "the sweep drops rows older than 30 days, keeps newer ones" do
      now = now_ms()
      SignOuts.put(4_294_967_331, now - 31 * @day_ms)
      SignOuts.put(4_294_967_332, now - 29 * @day_ms)
      SignOuts.sweep(now)
      assert :ets.lookup(:sign_outs, 4_294_967_331) == []
      assert [_] = :ets.lookup(:sign_outs, 4_294_967_332)
    end

    test "the Sweeper's tick sweeps it" do
      SignOuts.put(4_294_967_341, now_ms() - 31 * @day_ms)
      Hoodride.Sweeper.sweep_now()
      assert :ets.lookup(:sign_outs, 4_294_967_341) == []
    end

    test "no table (never loaded): the check raises — a connect is refused, never let in" do
      assert_raise ArgumentError, fn -> SignOuts.allowed?(4_294_967_351, 1, :no_such_table) end
    end
  end

  describe "start-up" do
    test "the load runs after the migrations and before the web server" do
      # which_children lists the most recently started first
      ids = for {id, _, _, _} <- Supervisor.which_children(Hoodride.Supervisor), do: id
      pos = fn id -> Enum.find_index(ids, &(&1 == id)) end
      assert pos.(HoodrideWeb.Endpoint) < pos.(Hoodride.SignOuts)
      assert pos.(Hoodride.SignOuts) < pos.(Ecto.Migrator)
    end

    test "the index on users.logged_out_at exists (the start-up load stays fast)" do
      {:ok, %{rows: rows}} = Hoodride.Repo.query("PRAGMA index_list(users)")
      names = Enum.map(rows, &Enum.at(&1, 1))

      assert Enum.any?(names, fn name ->
               {:ok, %{rows: cols}} = Hoodride.Repo.query("PRAGMA index_info(#{name})")
               Enum.map(cols, &Enum.at(&1, 2)) == ["logged_out_at"]
             end)
    end
  end

  describe "the pool and the logs" do
    test "prod and loadtest: pool 5, a burst waits (queue_target 1 s), a write waits (busy_timeout 5 s)" do
      env = %{
        "DATABASE_PATH" => "/tmp/x.db",
        "SECRET_KEY_BASE" => String.duplicate("a", 64),
        "PHX_HOST" => "hood.example"
      }

      for {k, v} <- env, do: System.put_env(k, v)

      try do
        for e <- [:prod, :loadtest] do
          repo = Config.Reader.read!("config/runtime.exs", env: e)[:hoodride][Hoodride.Repo]
          assert repo[:pool_size] == 5
          assert repo[:queue_target] == 1000
          assert repo[:busy_timeout] == 5000
        end
      after
        for k <- Map.keys(env), do: System.delete_env(k)
      end
    end

    # the logger drops EVERYTHING past 200 queued messages (Erlang's
    # drop_mode_qlen): an info line per connect and join made a burst drown
    # its own errors
    test "a connect logs at debug, not info" do
      me = self()
      id = {__MODULE__, :socket_log}

      :telemetry.attach(
        id,
        [:phoenix, :socket_connected],
        fn _, _, meta, _ -> send(me, {:log, meta.log}) end,
        nil
      )

      try do
        {:ok, _} = connect(Hoodride.TestHelpers.socket_token_for(user("so-log").id))
        assert_received {:log, :debug}
      after
        :telemetry.detach(id)
      end
    end

    test "channel joins log at debug, not info" do
      for ch <- [HoodrideWeb.WorldChannel, HoodrideWeb.UserChannel, HoodrideWeb.RideChannel] do
        assert ch.__socket__(:private).log_join == :debug
      end
    end
  end
end
