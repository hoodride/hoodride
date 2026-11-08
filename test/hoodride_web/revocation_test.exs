defmodule HoodrideWeb.RevocationTest do
  @moduledoc """
  Revocations (sign-outs and deletions) must survive a RESTART. The
  denylist (Hoodride.SignOuts) lives in memory and is refilled at start-up
  from the database. It used to be refilled from `users.logged_out_at` —
  deleted WITH the account — so after any restart within a day a deleted
  account's leftover socket token (it carries name and photo; a connect
  reads no database) connected again. Now revocations have their own
  table, and deleting an account is ONE database step (row gone +
  revocation saved) done FIRST: if it fails, nothing changed and a retry
  works.
  """
  use HoodrideWeb.ConnCase, async: false

  require Phoenix.ChannelTest

  alias Hoodride.{Accounts, Geo, Repo, SignOuts}

  @cell "882a1072c7fffff"
  @day 86_400_000

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp signed_in(conn, u),
    do: init_test_session(conn, Hoodride.TestHelpers.session_for(u.id))

  # what a restart does to the denylist and the sign-ins: memory gone,
  # refilled from the database
  defp restart! do
    :ets.delete_all_objects(:sign_outs)
    :ets.delete_all_objects(:session_tokens)
    :ok = SignOuts.load()
    :ok = Hoodride.SessionTokens.load()
  end

  defp connects?(token),
    do:
      match?(
        {:ok, _},
        Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{auth_token: token}
        )
      )

  test "a deleted account's old token stays refused after a restart", %{conn: conn} do
    u = user("rv-del")
    token = Hoodride.TestHelpers.socket_token_for(u.id)
    Process.sleep(2)

    assert json_response(
             post(signed_in(conn, u), "/api/account/delete", %{"confirm" => "DELETE"}),
             200
           )

    restart!()
    refute connects?(token), "a deleted account must not come back after a restart"
  end

  test "a delete that can't reach the database changes NOTHING — and a retry works", %{conn: conn} do
    u = user("rv-fail")
    Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, nil)
    token = Hoodride.TestHelpers.socket_token_for(u.id)
    Process.sleep(2)

    # a real database failure: the revocation can't be saved
    Repo.query!("ALTER TABLE sign_outs RENAME TO sign_outs_away")
    conn1 = post(signed_in(conn, u), "/api/account/delete", %{"confirm" => "DELETE"})
    assert json_response(conn1, 503) == %{"error" => "failed"}

    # nothing happened: the account, its sign-in, its car on the map
    assert Accounts.get_user(u.id)
    assert connects?(token), "not signed out by a delete that didn't happen"
    assert Geo.driver_cell(u.id) == @cell

    Repo.query!("ALTER TABLE sign_outs_away RENAME TO sign_outs")

    assert json_response(
             post(signed_in(build_conn(), u), "/api/account/delete", %{"confirm" => "DELETE"}),
             200
           )

    assert Accounts.get_user(u.id) == nil
    refute connects?(token)
  end

  describe "signing out when the database can't" do
    test "NOTHING changes — still signed in everywhere — and a retry works", %{conn: conn} do
      u = user("rv-so")
      token = Hoodride.TestHelpers.socket_token_for(u.id)
      Process.sleep(2)
      conn = signed_in(conn, u)

      Repo.query!("ALTER TABLE sign_outs RENAME TO sign_outs_away")
      failed = post(conn, "/api/logout")
      assert json_response(failed, 503) == %{"error" => "failed"}

      # not half signed out: the session, the live connection, the record
      assert json_response(get(recycle(failed), "/api/me"), 200)["user"]["id"] == u.id
      assert connects?(token)
      assert Accounts.get_user(u.id).logged_out_at == nil

      Repo.query!("ALTER TABLE sign_outs_away RENAME TO sign_outs")
      done = post(recycle(failed), "/api/logout")
      assert json_response(done, 200) == %{"ok" => true}
      refute connects?(token)
      assert json_response(get(recycle(done), "/api/me"), 200)["user"] == nil
    end

    test "a sign-out that worked disconnects every device", %{conn: conn} do
      u = user("rv-so2")
      HoodrideWeb.Endpoint.subscribe("user_socket:#{u.id}")
      assert json_response(post(signed_in(conn, u), "/api/logout"), 200) == %{"ok" => true}
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "Accounts.mark_logged_out says so instead of half-doing it" do
      u = user("rv-so3")
      Repo.query!("ALTER TABLE sign_outs RENAME TO sign_outs_away")
      assert Accounts.mark_logged_out(u.id) == {:error, :failed}
      assert SignOuts.allowed?(u.id, System.system_time(:millisecond) - 1)
    end
  end

  test "a sign-out survives a restart" do
    u = user("rv-out")
    token = Hoodride.TestHelpers.socket_token_for(u.id)
    Process.sleep(2)
    :ok = Accounts.mark_logged_out(u.id)

    restart!()
    refute connects?(token)
  end

  test "a newer revocation wins; an older one never overwrites it" do
    now = System.system_time(:millisecond)
    :ok = SignOuts.persist(77, now - 1_000)
    :ok = SignOuts.persist(77, now - 2_000)
    restart!()
    refute SignOuts.allowed?(77, now - 1_500)
    assert SignOuts.allowed?(77, now - 999)
  end

  defp rows(ids),
    do:
      Repo.query!(
        "SELECT user_id FROM sign_outs WHERE user_id IN (#{Enum.join(ids, ",")}) ORDER BY user_id"
      ).rows

  test "each new revocation drops the table's rows older than 30 days" do
    now = System.system_time(:millisecond)

    Repo.query!("INSERT INTO sign_outs (user_id, at) VALUES (81, ?), (82, ?)", [
      now - 31 * @day,
      now - 29 * @day
    ])

    :ok = SignOuts.persist(84, now, now)
    assert rows([81, 82, 84]) == [[82], [84]]
  end

  test "start-up drops the table's rows older than 30 days" do
    now = System.system_time(:millisecond)

    Repo.query!("INSERT INTO sign_outs (user_id, at) VALUES (85, ?), (86, ?)", [
      now - 31 * @day,
      now - 29 * @day
    ])

    :ok = SignOuts.load(now)
    assert rows([85, 86]) == [[86]]
  end

  test "the Sweeper never touches the database: it trims memory only" do
    now = System.system_time(:millisecond)
    Repo.query!("INSERT INTO sign_outs (user_id, at) VALUES (87, ?)", [now - 31 * @day])
    SignOuts.put(87, now - 31 * @day)

    :ok = SignOuts.sweep(now)
    assert :ets.lookup(:sign_outs, 87) == []
    assert rows([87]) == [[87]], "the table is trimmed by writes and start-up, not the sweep"
  end

  test "the migration moves today's sign-outs into the table" do
    mod =
      Hoodride.TestHelpers.migration("priv/repo/migrations/20261027032653_create_sign_outs.exs")

    u = user("rv-mig")
    Repo.query!("UPDATE users SET logged_out_at = 12345 WHERE id = ?", [u.id])
    Repo.query!(mod.copy_sql())
    assert Repo.query!("SELECT at FROM sign_outs WHERE user_id = ?", [u.id]).rows == [[12345]]
  end
end
