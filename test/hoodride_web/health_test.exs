defmodule HoodrideWeb.HealthTest do
  @moduledoc """
  GET /api/health (the 2026-11-08 server review's note, open until
  2026-11-20): the deploy's own check asked /api/me — with no session it
  reads nothing, so a release whose database couldn't be WRITTEN (read-only,
  locked by something else) passed it, and every sign-in then failed. This
  takes the database's write lock (an empty IMMEDIATE transaction: nothing
  written) — 200 or 503. At most once a second: the rest of that second gets
  the same answer, so the address can't be used to keep taking the lock.
  """
  use HoodrideWeb.ConnCase, async: false

  alias HoodrideWeb.Health

  setup do
    Health.forget()
    on_exit(fn -> Health.forget() end)
    :ok
  end

  test "a database that can be written: 200", %{conn: conn} do
    conn = get(conn, "/api/health")
    assert conn.status == 200
    assert %{"ok" => true} = json_response(conn, 200)
  end

  test "a database that can't be written (read-only): 503 — never a pass", %{conn: conn} do
    Hoodride.Repo.query!("PRAGMA query_only = ON")

    try do
      conn = get(conn, "/api/health")
      assert conn.status == 503
      assert %{"ok" => false} = json_response(conn, 503)
    after
      Hoodride.Repo.query!("PRAGMA query_only = OFF")
    end
  end

  test "at most once a second: the same answer for the rest of it", %{conn: conn} do
    assert get(conn, "/api/health").status == 200
    Hoodride.Repo.query!("PRAGMA query_only = ON")

    try do
      # (within the second: last answer — the lock not taken again)
      assert get(build_conn(), "/api/health").status == 200
      Health.forget()
      assert get(build_conn(), "/api/health").status == 503
    after
      Hoodride.Repo.query!("PRAGMA query_only = OFF")
    end
  end

  test "the deploy's switch and the check ask it" do
    switch = File.read!("deploy/switch.sh")
    assert switch =~ "hoodride-socket-get --status /api/health"
    assert File.read!("deploy/check.sh") =~ "/api/health"
    # (a rollback to a release from before /api/health: its 404 isn't a
    # failure — checked the old way; the new release never is)
    assert switch =~ ~s(if healthy previous; then say "switched back)
    assert switch =~ ~s([ "${1:-}" = previous ] && [ "$code" = 404 ])
  end
end
