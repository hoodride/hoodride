defmodule HoodrideWeb.SignOutsTest do
  @moduledoc """
  Socket connects without the database (the capacity test: 3,000 people
  connecting at once ran the pool of 5 dry — every connect read the user to
  check the token against a sign-out — and ~half got HTTP 500).

  The token carries the name and photo the socket needs, and names its
  SIGN-IN (Hoodride.SessionTokens, in memory, loaded at start-up before the
  web server): a connect is a signature check and one memory lookup.
  Signing out or deleting the account deletes the sign-ins, so the pass is
  refused — with no database read, and after a restart too.

  (A sign-out DENYLIST, Hoodride.SignOuts, did this before 2026-11-08 and
  was kept, read by nothing, until the delete loop (2026-11-12): sign in,
  delete, again — a 30-day record each, piled up by a script. Removed: no
  record of a sign-out or a deletion is kept.)
  """
  use HoodrideWeb.ConnCase, async: false

  require Phoenix.ChannelTest

  alias Hoodride.{AccountDeletion, Accounts, Repo}

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

  defp kept(table), do: hd(hd(Repo.query!("SELECT count(*) FROM #{table}").rows))

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

  describe "nothing kept after a sign-out or a deletion" do
    test "signed out: the old pass stays refused after a restart (its sign-ins are gone from the table)" do
      u = user("so-restart")
      token = Hoodride.TestHelpers.socket_token_for(u.id)
      :ok = Accounts.mark_logged_out(u.id)

      # a restart: memory empty, the start-up load refills it
      :ets.delete_all_objects(:session_tokens)
      assert Hoodride.SessionTokens.load() == :ok
      assert connect(token) == :error
    end

    test "deleted: the old pass stays refused after a restart too" do
      u = user("so-del-restart")
      token = Hoodride.TestHelpers.socket_token_for(u.id)
      :ok = AccountDeletion.delete(u.id)

      :ets.delete_all_objects(:session_tokens)
      assert Hoodride.SessionTokens.load() == :ok
      assert connect(token) == :error
    end

    # (the delete loop, 2026-11-12: each round a new account and a record
    # kept 30 days — a million from one script)
    test "the loop — sign in, sign out, delete, ten times over: nothing piles up" do
      for i <- 1..10 do
        u = user("so-loop")
        Hoodride.TestHelpers.socket_token_for(u.id)
        :ok = Accounts.mark_logged_out(u.id)
        Hoodride.TestHelpers.socket_token_for(u.id)
        :ok = AccountDeletion.delete(u.id)
        assert Accounts.get_user(u.id) == nil, "round #{i}"
      end

      assert kept("sign_outs") == 0
      assert kept("user_tokens") == 0
      assert kept("users WHERE provider_id = 'so-loop'") == 0
      assert :ets.whereis(:sign_outs) == :undefined, "no sign-out list in memory"
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
