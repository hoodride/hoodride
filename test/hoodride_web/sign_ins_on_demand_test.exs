defmodule HoodrideWeb.SignInsOnDemandTest do
  @moduledoc """
  Sign-ins read on demand (Hoodride.SessionTokens — owner, 2026-11-17), as
  the app meets it: every way in after a restart (a request, the page, a
  connection, a channel join, a ride's start) — read once, then memory; and
  the database unable to answer for someone not in memory: "try again"
  (503 — the app retries), NEVER "signed out" (401 — the app would show
  the sign-in screen), a connection refused without counting against the
  address. Someone in memory is answered with no read at all.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Accounts, Geo, Requests, Rides, SessionTokens}
  alias Hoodride.TestHelpers

  setup do
    TestHelpers.scrub_live_state()
    on_exit(fn -> Application.delete_env(:hoodride, :session_tokens_hook) end)
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    u
  end

  defp restart, do: :ok = SessionTokens.reset_memory()

  defp signed_in(conn, u) do
    session = TestHelpers.session_for(u.id) |> Map.put("terms_version", Hoodride.Terms.version())
    init_test_session(conn, session)
  end

  defp down, do: Application.put_env(:hoodride, :session_tokens_hook, &down/1)
  defp down(step) when step in [:read, :owner], do: raise(DBConnection.ConnectionError, "down")
  defp down(_), do: :ok
  defp up, do: Application.delete_env(:hoodride, :session_tokens_hook)

  defp token_reads(fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> if meta.query =~ "user_tokens", do: send(me, :q) end,
      nil
    )

    try do
      r = fun.()
      {r, count(0)}
    after
      :telemetry.detach(id)
    end
  end

  defp count(n) do
    receive do
      :q -> count(n + 1)
    after
      0 -> n
    end
  end

  defp connect_with(token, ip \\ nil) do
    info =
      if ip,
        do: %{
          peer_data: %{address: ip, port: 40_000, ssl_cert: nil},
          x_headers: [],
          auth_token: token
        },
        else: %{auth_token: token}

    Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{}, connect_info: info)
  end

  describe "a request" do
    test "after a restart: signed in — one read, then none", %{conn: conn} do
      u = user("wo-req")
      conn = signed_in(conn, u)
      restart()
      {res, n} = token_reads(fn -> get(conn, "/api/me") end)
      assert json_response(res, 200)["user"]["id"] == u.id
      assert n == 1
      {res, n} = token_reads(fn -> get(conn, "/api/me") end)
      assert json_response(res, 200)["user"]["id"] == u.id
      assert n == 0
    end

    test "the database down, not in memory: 503 'try again' — never 401", %{conn: conn} do
      u = user("wo-503")
      conn = signed_in(conn, u)
      restart()
      down()

      for path <- ["/api/me", "/api/socket_token", "/api/state"] do
        res = get(conn, path)
        assert res.status == 503, path
        assert Jason.decode!(res.resp_body) == %{"error" => "unavailable"}, path
        assert [secs] = get_resp_header(res, "retry-after"), path
        assert secs in ["2", "3"], path
      end

      up()
      assert json_response(get(conn, "/api/me"), 200)["user"]["id"] == u.id
    end

    test "the database down, but in memory: answered — no read", %{conn: conn} do
      u = user("wo-mem")
      conn = signed_in(conn, u)
      assert json_response(get(conn, "/api/me"), 200)["user"]["id"] == u.id
      down()
      {res, n} = token_reads(fn -> get(conn, "/api/me") end)
      assert json_response(res, 200)["user"]["id"] == u.id
      assert n == 0
    end

    test "signed out elsewhere, after a restart: signed out here (the read finds none)", %{
      conn: conn
    } do
      u = user("wo-out")
      conn = signed_in(conn, u)
      {:ok, _} = SessionTokens.revoke_all(u.id)
      restart()
      assert json_response(get(conn, "/api/me"), 200)["user"] == nil
      assert get(conn, "/api/socket_token").status == 401
    end

    test "a cookie naming another account than its token's: not signed in", %{conn: conn} do
      [ann, bob] = [user("wo-mix-a"), user("wo-mix-b")]
      session = TestHelpers.session_for(ann.id) |> Map.put("user_id", bob.id)
      restart()
      assert json_response(get(init_test_session(conn, session), "/api/me"), 200)["user"] == nil
    end

    test "the page: starts neutral for someone signed in — read on demand, and when the database is down",
         %{conn: conn} do
      u = user("wo-page")
      conn = signed_in(conn, u)
      restart()
      assert get(conn, "/").resp_body =~ ~s(class="resuming")
      restart()
      down()
      # (a hint only — the app decides once /api/state answers)
      assert get(conn, "/").resp_body =~ ~s(class="resuming")
    end
  end

  describe "a connection" do
    defp pass_for(u) do
      %{"user_token" => raw} = s = TestHelpers.session_for(u.id)
      {:ok, info} = SessionTokens.lookup_as(raw, u.id)

      HoodrideWeb.Auth.socket_token(%{id: u.id, name: s["name"], photo: nil, token: info})
    end

    test "after a restart: connects (read once), and its channel joins" do
      u = user("wo-sock")
      pass = pass_for(u)
      restart()
      {res, n} = token_reads(fn -> connect_with(pass) end)
      assert {:ok, socket} = res
      assert n == 1
      assert {:ok, _, _} = subscribe_and_join(socket, "user:#{u.id}", %{})
    end

    test "a join after its person was dropped from memory: read again, joined" do
      u = user("wo-join")
      pass = pass_for(u)
      {:ok, socket} = connect_with(pass)
      restart()
      assert {:ok, _, _} = subscribe_and_join(socket, "world", %{})
    end

    test "the database down: refused — not counted against the address; fine once it answers" do
      saved = TestHelpers.save_env([:ws_budget, :trusted_proxies])
      Application.put_env(:hoodride, :ws_budget, per_minute: 60, burst: 2)
      on_exit(fn -> TestHelpers.restore_env(saved) end)
      ip = {198, 51, 100, 77}

      u = user("wo-sock-down")
      pass = pass_for(u)
      restart()
      down()
      for _ <- 1..5, do: assert(connect_with(pass, ip) == :error)
      up()
      # the address's failures untouched: junk gets exactly the allowance a
      # fresh address gets
      assert allowance(ip) == allowance({198, 51, 100, 78})
      assert {:ok, _} = connect_with(pass, ip)
    end

    # junk connects from `ip` refused as failures before "rate_limited"
    defp allowance(ip), do: allowance(ip, 0)

    defp allowance(ip, n) when n < 50 do
      case connect_with("junk", ip) do
        :error -> allowance(ip, n + 1)
        {:error, :rate_limited} -> n
      end
    end

    test "signed out meanwhile, after a restart: refused" do
      u = user("wo-sock-out")
      pass = pass_for(u)
      {:ok, _} = SessionTokens.revoke_all(u.id)
      restart()
      assert connect_with(pass) == :error
    end
  end

  describe "a ride's start" do
    test "the rider not in memory: read — the ride starts" do
      [rider, driver] = [user("wo-ride-r"), user("wo-ride-d")]
      {:ok, _} = SessionTokens.create(rider.id)
      Geo.driver_update(%{id: driver.id, name: driver.name, photo: nil}, "cell8", nil)
      :ok = Requests.create(%{id: rider.id, name: rider.name, photo: nil}, driver.id)
      restart()

      assert {:ok, _} =
               Requests.accept(%{id: driver.id, name: driver.name, photo: nil}, rider.id, fn ->
                 true
               end)

      assert Rides.ride_id_of_user(rider.id) != nil
    end

    test "the rider signed out (none left, read to be sure): no ride" do
      [rider, driver] = [user("wo-ride-out-r"), user("wo-ride-out-d")]
      {:ok, _} = SessionTokens.create(rider.id)
      Geo.driver_update(%{id: driver.id, name: driver.name, photo: nil}, "cell8", nil)
      :ok = Requests.create(%{id: rider.id, name: rider.name, photo: nil}, driver.id)
      Hoodride.Repo.query!("DELETE FROM user_tokens WHERE user_id = ?", [rider.id])
      restart()

      refute match?(
               {:ok, _},
               Requests.accept(%{id: driver.id, name: driver.name, photo: nil}, rider.id, fn ->
                 true
               end)
             )

      assert Rides.ride_id_of_user(rider.id) == nil
    end
  end

  # (owner, 2026-11-20: "make sure nowhere in code got a hardcoded wait")
  # every phone opening the app in a database stall was told "2": all asked
  # again on one beat. 2 or 3 s (whole seconds: the header's own unit)
  test "the 'try again' wait is spread: 2 or 3 s, never one beat for everyone" do
    waits = for _ <- 1..60, do: HoodrideWeb.CurrentUser.retry_after()
    assert Enum.all?(waits, &(&1 in ["2", "3"])), inspect(Enum.uniq(waits))
    assert Enum.sort(Enum.uniq(waits)) == ["2", "3"]
  end
end
