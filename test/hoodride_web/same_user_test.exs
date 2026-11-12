defmodule HoodrideWeb.SameUserTest do
  @moduledoc """
  One account per tab (owner, 2026-11-08). All tabs share one sign-in
  cookie: if the browser becomes account B while a tab still shows A, that
  tab's requests used to act on B — delete account deleted B, save car saved
  to B, sign out signed B out, /api/state drew B's data as A's. Every app
  request now says which account the tab shows (`x-hood-user`); a mismatch is
  refused (409 other_account, marked by the `x-hood-other-account` header) and
  nothing happens. No header (an old app copy, the signed-out screen) or
  signed out: unchanged.
  """
  use HoodrideWeb.ConnCase, async: false

  @moduletag :capture_log

  alias Hoodride.Accounts

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    %{a: user("su-a", "Ada"), b: user("su-b", "Bo")}
  end

  defp user(pid, name) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: pid, name: name})
    :ok = Accounts.agree_to_terms(u.id)
    Accounts.get_user(u.id)
  end

  # this browser signed in as `signed`, the tab showing `shown`
  defp tab(signed, shown) do
    build_conn()
    |> init_test_session(Hoodride.TestHelpers.session_for(signed.id))
    |> put_req_header("x-hood-user", Integer.to_string(shown.id))
  end

  defp json_post(conn, path, body),
    do:
      conn
      |> put_req_header("content-type", "application/json")
      |> post(path, Jason.encode!(body))

  defp other_account?(conn) do
    conn.status == 409 and Jason.decode!(conn.resp_body) == %{"error" => "other_account"} and
      get_resp_header(conn, "x-hood-other-account") == ["1"]
  end

  describe "a tab showing another account than the one signed in: refused, nothing done" do
    test "reading the state or a connection pass", %{a: a, b: b} do
      assert other_account?(get(tab(b, a), "/api/state"))
      assert other_account?(get(tab(b, a), "/api/socket_token"))
      assert other_account?(get(tab(b, a), "/api/car"))
    end

    test "delete account: B is NOT deleted", %{a: a, b: b} do
      assert other_account?(json_post(tab(b, a), "/api/account/delete", %{"confirm" => "DELETE"}))
      assert Accounts.get_user(b.id)
      assert Accounts.get_user(a.id)
    end

    test "save car: B's car is NOT changed", %{a: a, b: b} do
      car = %{"color" => "Gray", "make" => "Honda", "model" => "Civic"}
      assert other_account?(json_post(tab(b, a), "/api/car", car))
      assert Accounts.car_of(b.id) == {:ok, nil}
      assert Accounts.car_of(a.id) == {:ok, nil}
    end

    test "sign out: B stays signed in", %{a: a, b: b} do
      session = Hoodride.TestHelpers.session_for(b.id)
      refused = build_conn() |> init_test_session(session)
      refused = put_req_header(refused, "x-hood-user", Integer.to_string(a.id))
      assert other_account?(json_post(refused, "/api/logout", %{}))

      # the same sign-in still works afterwards
      kept = build_conn() |> init_test_session(session) |> get("/api/state")
      assert json_response(kept, 200)["user"]["id"] == b.id
    end

    test "agree to the Terms", %{a: a, b: b} do
      assert other_account?(json_post(tab(b, a), "/api/terms/accept", %{}))
    end

    test "the header sent twice (never by the app): refused", %{a: a} do
      conn = %{tab(a, a) | req_headers: tab(a, a).req_headers ++ [{"x-hood-user", "1"}]}
      assert other_account?(get(conn, "/api/state"))
    end
  end

  describe "everything else: as before" do
    test "the tab showing the account signed in", %{a: a} do
      assert json_response(get(tab(a, a), "/api/state"), 200)["user"]["id"] == a.id
      assert json_response(get(tab(a, a), "/api/socket_token"), 200)["token"]
    end

    test "no header (an old app copy, the first load): unchanged", %{a: a} do
      conn = build_conn() |> init_test_session(Hoodride.TestHelpers.session_for(a.id))
      assert json_response(get(conn, "/api/state"), 200)["user"]["id"] == a.id
    end

    test "signed out with a header: the existing answers (401 / user nil)", %{a: a} do
      conn = put_req_header(build_conn(), "x-hood-user", Integer.to_string(a.id))
      assert json_response(get(conn, "/api/socket_token"), 401)
      assert json_response(get(conn, "/api/state"), 200)["user"] == nil
    end

    test "ordinary answers are never marked other-account", %{a: a} do
      # logout's own 409s (a ride or request waiting) are read by the app to
      # say "end your ride first": only the other-account refusal is marked
      for conn <- [get(tab(a, a), "/api/state"), json_post(tab(a, a), "/api/logout", %{})] do
        assert get_resp_header(conn, "x-hood-other-account") == []
      end
    end

    test "a refused request still spends the budget (as every refusal)", %{a: a, b: b} do
      saved = Hoodride.TestHelpers.save_env([:http_budget])
      Application.put_env(:hoodride, :http_budget, per_minute: 1, burst: 1)
      on_exit(fn -> Hoodride.TestHelpers.restore_env(saved) end)

      assert other_account?(get(tab(b, a), "/api/state"))
      assert other_account?(get(tab(b, a), "/api/state"))
      assert get(tab(b, a), "/api/state").status == 429
    end
  end
end
