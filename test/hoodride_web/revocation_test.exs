defmodule HoodrideWeb.RevocationTest do
  @moduledoc """
  Revocations (sign-outs and deletions) must survive a RESTART. Both
  delete the account's sign-ins in the database FIRST (Hoodride.SessionTokens;
  a deletion by the cascade), then from memory; a live-connection pass names
  the sign-in it came from, so it's refused — and after a restart too, since
  memory is refilled from the table. (Once, a deleted account's leftover
  pass connected again after a restart: the refusal lived only in memory.)
  If the database step fails, nothing changed and a retry works.

  No record of a revocation is kept (the sign-out denylist, Hoodride.SignOuts,
  had no reader left once passes named their sign-in; the delete loop,
  2026-11-12, piled its rows up — removed).
  """
  use HoodrideWeb.ConnCase, async: false

  require Phoenix.ChannelTest

  alias Hoodride.{Accounts, Geo, Repo}

  @cell "882a1072c7fffff"

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

  # what a restart does to the sign-ins: memory gone, refilled from the
  # database
  defp restart! do
    :ets.delete_all_objects(:session_tokens)
    :ok = Hoodride.SessionTokens.load()
  end

  # a real database failure: every delete from `table` refused
  defp refuse_deletes(table),
    do:
      Repo.query!(
        "CREATE TRIGGER refuse_#{table} BEFORE DELETE ON #{table} BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )

  defp allow_deletes(table), do: Repo.query!("DROP TRIGGER refuse_#{table}")

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
             Hoodride.TestHelpers.post_json(signed_in(conn, u), "/api/account/delete", %{
               "confirm" => "DELETE"
             }),
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

    # a real database failure: the account's row can't be deleted
    refuse_deletes("users")

    conn1 =
      Hoodride.TestHelpers.post_json(signed_in(conn, u), "/api/account/delete", %{
        "confirm" => "DELETE"
      })

    assert json_response(conn1, 503) == %{"error" => "failed"}

    # nothing happened: the account, its sign-in, its car on the map
    assert Accounts.get_user(u.id)
    assert connects?(token), "not signed out by a delete that didn't happen"
    assert Geo.driver_cell(u.id) == @cell

    allow_deletes("users")

    assert json_response(
             Hoodride.TestHelpers.post_json(signed_in(build_conn(), u), "/api/account/delete", %{
               "confirm" => "DELETE"
             }),
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

      refuse_deletes("user_tokens")
      failed = post(conn, "/api/logout")
      assert json_response(failed, 503) == %{"error" => "failed"}

      # not half signed out: the session, the live connection
      assert json_response(get(recycle(failed), "/api/me"), 200)["user"]["id"] == u.id
      assert connects?(token)

      allow_deletes("user_tokens")
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
      token = Hoodride.TestHelpers.socket_token_for(u.id)
      refuse_deletes("user_tokens")
      assert Accounts.mark_logged_out(u.id) == {:error, :failed}
      assert connects?(token), "still signed in"
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

  test "the migration moves today's sign-outs into the table" do
    mod =
      Hoodride.TestHelpers.migration("priv/repo/migrations/20261027032653_create_sign_outs.exs")

    u = user("rv-mig")
    Repo.query!("UPDATE users SET logged_out_at = 12345 WHERE id = ?", [u.id])
    Repo.query!(mod.copy_sql())
    assert Repo.query!("SELECT at FROM sign_outs WHERE user_id = ?", [u.id]).rows == [[12345]]
  end

  test "the records already kept are cleared (the table stays for the version before)" do
    mod =
      Hoodride.TestHelpers.migration("priv/repo/migrations/20261112200023_clear_sign_outs.exs")

    Repo.query!("INSERT INTO sign_outs (user_id, at) VALUES (91, 1), (92, 2)")

    Repo.query!(mod.clear_sql())

    assert Repo.query!("SELECT count(*) FROM sign_outs").rows == [[0]]
  end
end
