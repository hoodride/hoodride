defmodule HoodrideWeb.SignInRefreshTest do
  @moduledoc """
  "Refresh from Google" and the sign-in limits (owner, 2026-10-29).

  Refresh: someone changed their name or photo at Google; Hood Ride keeps its
  own copy, made at sign-in, so a quick Google round trip fetches the new
  one — no sign-out. `?refresh=1` (the button) and `?refresh=silent` (the
  app, on return: `prompt=none`, so Google never shows a screen; any
  failure comes back here, still signed in). `login_hint` is the account's
  Google ID from the SERVER's session — Google's docs: "either an email
  address or the sub string". Not during a ride (the page reload would
  interrupt it); 5 per 10 minutes per account.

  Limits (RFC 6819 §4.4.1.12): `state` is checked before Google is asked
  anything; sign-in starts have their own pool (30 a minute per address);
  30 codes refused by Google in 3 minutes block the address for an hour
  (GitLab's numbers) — Google isn't called while blocked.
  """
  use HoodrideWeb.ConnCase

  alias Hoodride.Accounts

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    Application.put_env(:hoodride, :google_client_id, "test-client")
    Application.put_env(:hoodride, :google_client_secret, "test-secret")
    Application.put_env(:hoodride, :google_req, plug: {Req.Test, HoodrideWeb.Google})

    on_exit(fn ->
      for k <- [:google_client_id, :google_client_secret, :google_req],
          do: Application.delete_env(:hoodride, k)
    end)

    {:ok, g} =
      Accounts.upsert_oauth_user(%{provider: "google", provider_id: "g-sub-77", name: "Gina"})

    {:ok, d} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "d-1", name: "Dev"})
    %{g: g, d: d}
  end

  defp signed_in(conn, user),
    do:
      init_test_session(conn, %{user_id: user.id, signed_in_at: System.system_time(:millisecond)})

  defp query(conn) do
    %URI{host: host, query: q} = URI.parse(redirected_to(conn, 302))
    {host, URI.decode_query(q || "")}
  end

  describe "the refresh request" do
    test "?refresh=1: Google, with the account's own Google ID as the hint, no prompt", %{
      conn: conn,
      g: g
    } do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {host, q} = query(conn)
      assert host == "accounts.google.com"
      assert q["login_hint"] == "g-sub-77"
      refute Map.has_key?(q, "prompt")
      assert q["state"] == get_session(conn, :oauth_state), "state + PKCE as always"
      assert q["code_challenge_method"] == "S256"
    end

    test "?refresh=silent: the same, plus prompt=none (Google shows nothing)", %{conn: conn, g: g} do
      {_, q} = query(conn |> signed_in(g) |> get("/auth/google?refresh=silent"))
      assert q["prompt"] == "none"
      assert q["login_hint"] == "g-sub-77"
    end

    test "a hint written into the URL is ignored: only the session's account", %{conn: conn, g: g} do
      {_, q} =
        query(conn |> signed_in(g) |> get("/auth/google?refresh=1&login_hint=someone-else"))

      assert q["login_hint"] == "g-sub-77"
    end

    test "signed out, or not a Google account: an ordinary sign-in (no hint, no prompt)", %{
      conn: conn,
      d: d
    } do
      for c <- [
            get(conn, "/auth/google?refresh=silent"),
            conn |> signed_in(d) |> get("/auth/google?refresh=silent")
          ] do
        {host, q} = query(c)
        assert host == "accounts.google.com"
        refute Map.has_key?(q, "login_hint")
        refute Map.has_key?(q, "prompt")
      end
    end

    test "in a ride: back to the app, Google never asked", %{conn: conn, g: g} do
      :ets.insert(:rides_by_user, {g.id, "ride-1"})
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=silent")
      assert redirected_to(conn, 302) == "/?refresh=ride"
    end

    test "waiting on a ride request counts as in a ride", %{conn: conn, g: g} do
      :ets.insert(:ride_requests, {g.id, 999, System.system_time(:second)})
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      assert redirected_to(conn, 302) == "/?refresh=ride"
    end

    test "5 refreshes in a row go to Google; the 6th is refused", %{conn: conn, g: g} do
      for _ <- 1..5 do
        {host, _} = query(build_conn() |> signed_in(g) |> get("/auth/google?refresh=1"))
        assert host == "accounts.google.com"
      end

      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      assert redirected_to(conn, 302) == "/?refresh=limit"
    end

    # (the one line no test ran — mix test --cover, 2026-10-29)
    test "the refresh limit switched off (dev): refreshes are never refused", %{g: g} do
      # restore, not delete: the test default comes from config.exs
      saved = Application.get_env(:hoodride, :refresh_budget)
      Application.put_env(:hoodride, :refresh_budget, nil)
      on_exit(fn -> Hoodride.TestHelpers.restore_env(refresh_budget: saved) end)

      for _ <- 1..10 do
        {host, _} = query(build_conn() |> signed_in(g) |> get("/auth/google?refresh=1"))
        assert host == "accounts.google.com"
      end
    end

    test "refusals in a ride don't use up the refreshes", %{g: g} do
      :ets.insert(:rides_by_user, {g.id, "ride-1"})

      for _ <- 1..8 do
        c = build_conn() |> signed_in(g) |> get("/auth/google?refresh=1")
        assert redirected_to(c, 302) == "/?refresh=ride"
      end

      :ets.delete(:rides_by_user, g.id)

      for _ <- 1..5 do
        {host, _} = query(build_conn() |> signed_in(g) |> get("/auth/google?refresh=1"))
        assert host == "accounts.google.com", "all 5 still there after the ride"
      end
    end

    test "an unknown refresh value is an ordinary sign-in", %{conn: conn, g: g} do
      for v <- ["2", "true", "SILENT", ""] do
        {_, q} = query(conn |> signed_in(g) |> get("/auth/google?refresh=" <> v))
        refute Map.has_key?(q, "login_hint")
        refute Map.has_key?(q, "prompt")
      end
    end

    test "an account deleted meanwhile: an ordinary sign-in, no hint", %{conn: conn, g: g} do
      conn = signed_in(conn, g)
      Hoodride.Repo.delete!(Accounts.get_user(g.id))
      {_, q} = query(get(conn, "/auth/google?refresh=silent"))
      refute Map.has_key?(q, "login_hint")
      refute Map.has_key?(q, "prompt")
    end
  end

  # someone else's made-up codes can block a SHARED address (a carrier's
  # CGNAT): a signed-in person refreshing there goes back to the app with a
  # note — never stranded on the bare 429 text page (found in review)
  describe "a blocked address, signed in" do
    setup do
      Application.put_env(:hoodride, :sign_in_failures,
        max: 1,
        window_ms: 180_000,
        block_ms: 3_600_000
      )

      on_exit(fn -> Application.delete_env(:hoodride, :sign_in_failures) end)
      :ok
    end

    defp block_here, do: Hoodride.SignInFailures.record({127, 0, 0, 1})

    test "a refresh goes back to the app with a note; Google isn't asked", %{conn: conn, g: g} do
      block_here()

      for mode <- ["1", "silent"] do
        c = conn |> signed_in(g) |> get("/auth/google?refresh=" <> mode)
        assert redirected_to(c, 302) == "/?refresh=blocked"
      end
    end

    test "any signed-in account refreshing there goes back to the app (not only Google)", %{
      conn: conn,
      d: d
    } do
      block_here()
      c = conn |> signed_in(d) |> get("/auth/google?refresh=silent")
      assert redirected_to(c, 302) == "/?refresh=blocked"
    end

    test "an ordinary sign-in there still gets the 429 page (no app to go back to)", %{conn: conn} do
      block_here()
      assert response(get(conn, "/auth/google"), 429) =~ "Too many failed sign-ins"
    end

    test "blocked between leaving and coming back: back to the app, still signed in", %{
      conn: conn,
      g: g
    } do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=silent")
      {_, q} = query(conn)
      block_here()
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(conn, 302) == "/?refresh=blocked"
      assert json_response(get(recycle(conn), "/api/me"), 200)["user"]["id"] == g.id
    end

    test "an hour later the block has lifted: sign-in reaches Google again", %{conn: conn} do
      block_here()
      assert response(get(conn, "/auth/google"), 429)
      # an hour passes: the block's end time is now in the past
      now = System.monotonic_time(:millisecond)
      :ets.insert(:sign_in_failures, {{:block, {127, 0, 0, 1}}, now - 1})
      assert redirected_to(get(build_conn(), "/auth/google"), 302) =~ "accounts.google.com"
    end
  end

  describe "the callback" do
    test "a silent refresh Google couldn't do comes back still signed in, flagged", %{
      conn: conn,
      g: g
    } do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=silent")

      conn =
        get(recycle(conn), "/auth/google/callback", %{"error" => "login_required", "state" => "x"})

      assert redirected_to(conn, 302) == "/?refresh=failed"
      assert json_response(get(recycle(conn), "/api/me"), 200)["user"]["id"] == g.id
    end

    test "an ordinary sign-in cancelled at Google: back to the start, as before", %{conn: conn} do
      conn = get(conn, "/auth/google")
      conn = get(recycle(conn), "/auth/google/callback", %{"error" => "access_denied"})
      assert redirected_to(conn, 302) == "/"
    end

    test "a refresh that works updates the photo and name, still the same account", %{
      conn: conn,
      g: g
    } do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(conn)

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" ->
            Req.Test.json(c, %{"access_token" => "at"})

          "/oauth2/v3/userinfo" ->
            Req.Test.json(c, %{"sub" => "g-sub-77", "given_name" => "Georgina"})
        end
      end)

      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(conn, 302) == "/"
      assert Accounts.get_user(g.id).name == "Georgina"
    end
  end

  describe "failed sign-ins (made-up codes)" do
    setup do
      Application.put_env(:hoodride, :sign_in_failures,
        max: 3,
        window_ms: 180_000,
        block_ms: 3_600_000
      )

      on_exit(fn -> Application.delete_env(:hoodride, :sign_in_failures) end)

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        send(self(), :google_called)
        c |> Plug.Conn.put_status(400) |> Req.Test.json(%{"error" => "invalid_grant"})
      end)

      :ok
    end

    defp fake_code(conn) do
      conn = get(conn, "/auth/google")
      {_, q} = query(conn)
      get(recycle(conn), "/auth/google/callback", %{"code" => "made-up", "state" => q["state"]})
    end

    test "codes Google refuses are counted; at the limit the address is blocked", %{conn: conn} do
      for _ <- 1..3, do: assert(response(fake_code(build_conn()), 502))
      # blocked: the start refuses, and Google isn't asked
      blocked = get(conn, "/auth/google")
      assert response(blocked, 429) =~ "Too many failed sign-ins"
    end

    test "while blocked, a callback is refused before Google is asked", %{conn: conn} do
      started = get(conn, "/auth/google")
      {_, q} = query(started)
      for _ <- 1..3, do: fake_code(build_conn())
      flush_google()

      conn =
        get(recycle(started), "/auth/google/callback", %{
          "code" => "made-up",
          "state" => q["state"]
        })

      assert response(conn, 429)
      refute_received :google_called
    end

    test "a wrong state is refused before Google is asked (and isn't a Google failure)", %{
      conn: conn
    } do
      started = get(conn, "/auth/google")

      for _ <- 1..5 do
        c = get(recycle(started), "/auth/google/callback", %{"code" => "x", "state" => "forged"})
        assert response(c, 403)
      end

      refute_received :google_called
      # never reached Google, so nothing was counted
      assert redirected_to(get(build_conn(), "/auth/google"), 302) =~ "accounts.google.com"
    end

    defp flush_google do
      receive do
        :google_called -> flush_google()
      after
        0 -> :ok
      end
    end

    # only a code the provider REFUSES counts: Google down, a network error,
    # or a failure after the code was accepted must never block a shared
    # address (a carrier's CGNAT) for an hour
    defp not_blocked?,
      do: redirected_to(get(build_conn(), "/auth/google"), 302) =~ "accounts.google.com"

    test "Google down (5xx) isn't counted", %{conn: _} do
      Req.Test.stub(HoodrideWeb.Google, &(&1 |> Plug.Conn.put_status(503) |> Req.Test.json(%{})))
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_blocked?()
    end

    test "an 'OK' reply without a token (malformed) isn't counted", %{conn: _} do
      Req.Test.stub(HoodrideWeb.Google, &Req.Test.json(&1, %{}))
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_blocked?()
    end

    test "a network error isn't counted", %{conn: _} do
      Req.Test.stub(HoodrideWeb.Google, &Req.Test.transport_error(&1, :econnrefused))
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_blocked?()
    end

    test "a failure after Google accepted the code (reading the profile) isn't counted", %{
      conn: _
    } do
      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" -> Req.Test.json(c, %{"access_token" => "at"})
          _ -> c |> Plug.Conn.put_status(401) |> Req.Test.json(%{})
        end
      end)

      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_blocked?()
    end

    # an IPv6 /64 is ONE address for the block (HoodrideWeb.ClientIp, as the
    # other budgets): hopping inside it doesn't dodge the hour
    test "IPv6: one /64 network is one address", %{conn: _} do
      at = fn last -> %{build_conn() | remote_ip: {0x2001, 0xDB8, 1, 2, 0, 0, 0, last}} end

      for n <- 1..3 do
        started = get(at.(n), "/auth/google")
        {_, q} = query(started)
        cb = %{recycle(started) | remote_ip: {0x2001, 0xDB8, 1, 2, 0, 0, 0, n}}
        get(cb, "/auth/google/callback", %{"code" => "made-up", "state" => q["state"]})
      end

      assert response(get(at.(99), "/auth/google"), 429), "another address in the same /64"

      elsewhere = %{build_conn() | remote_ip: {0x2001, 0xDB8, 1, 3, 0, 0, 0, 1}}
      assert redirected_to(get(elsewhere, "/auth/google"), 302) =~ "accounts.google.com"
    end

    test "Facebook's refused codes count the same way (for when it's switched on)", %{conn: conn} do
      Application.put_env(:hoodride, :facebook_app_id, "fb-app")
      Application.put_env(:hoodride, :facebook_app_secret, "fb-secret")
      Application.put_env(:hoodride, :facebook_req, plug: {Req.Test, HoodrideWeb.Facebook})

      on_exit(fn ->
        for k <- [:facebook_app_id, :facebook_app_secret, :facebook_req],
            do: Application.delete_env(:hoodride, k)
      end)

      Req.Test.stub(
        HoodrideWeb.Facebook,
        &(&1 |> Plug.Conn.put_status(400) |> Req.Test.json(%{"error" => %{"code" => 100}}))
      )

      for _ <- 1..3 do
        started = get(build_conn(), "/auth/facebook")
        {_, q} = query(started)

        get(recycle(started), "/auth/facebook/callback", %{
          "code" => "made-up",
          "state" => q["state"]
        })
      end

      assert response(get(conn, "/auth/facebook"), 429)
    end
  end

  describe "after a refresh" do
    defp google_says(info) do
      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" -> Req.Test.json(c, %{"access_token" => "at"})
          "/oauth2/v3/userinfo" -> Req.Test.json(c, info)
        end
      end)
    end

    test "an ABANDONED refresh leaves no flag: a later ordinary sign-in, cancelled, isn't 'Couldn't refresh'",
         %{conn: conn, g: g} do
      # start a refresh, never come back from Google…
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=silent")
      assert get_session(conn, :oauth_refresh) == "silent"
      # …later an ordinary sign-in from the same browser, cancelled at Google
      conn = get(recycle(conn), "/auth/google")
      assert get_session(conn, :oauth_refresh) == nil
      conn = get(recycle(conn), "/auth/google/callback", %{"error" => "access_denied"})
      assert redirected_to(conn, 302) == "/"
    end

    test "no refresh flag is left behind: a later cancelled sign-in isn't 'Couldn't refresh'", %{
      conn: conn,
      g: g
    } do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(conn)
      google_says(%{"sub" => "g-sub-77", "given_name" => "Gina"})
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(conn, 302) == "/"
      assert get_session(conn, :oauth_refresh) == nil

      # an ordinary sign-in later, cancelled at Google
      conn = get(recycle(conn), "/auth/google")
      conn = get(recycle(conn), "/auth/google/callback", %{"error" => "access_denied"})
      assert redirected_to(conn, 302) == "/"
    end

    test "the new photo is copied too, not only the name", %{conn: conn, g: g} do
      dir = Path.join(System.tmp_dir!(), "hoodride-refresh-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      saved = for k <- [:avatar_dir, :avatar_req], do: {k, Application.get_env(:hoodride, k)}
      Application.put_env(:hoodride, :avatar_dir, dir)
      Application.put_env(:hoodride, :avatar_req, plug: {Req.Test, Hoodride.Avatars})

      on_exit(fn ->
        for {k, v} <- saved, do: Application.put_env(:hoodride, k, v)
        File.rm_rf!(dir)
      end)

      jpeg = <<0xFF, 0xD8, 0xFF, 0xE0>> <> String.duplicate("n", 200)
      Req.Test.stub(Hoodride.Avatars, &Plug.Conn.send_resp(&1, 200, jpeg))
      assert Accounts.get_user(g.id).photo == nil

      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(conn)

      google_says(%{
        "sub" => "g-sub-77",
        "given_name" => "Gina",
        "picture" => "https://lh3.googleusercontent.com/a/new=s96-c"
      })

      get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert "/avatars/" <> name = Accounts.get_user(g.id).photo
      assert File.read!(Path.join(dir, name)) == jpeg
    end

    test "a Facebook account asking to refresh gets an ordinary sign-in (Google only)", %{
      conn: conn
    } do
      Application.put_env(:hoodride, :facebook_app_id, "fb-app")
      Application.put_env(:hoodride, :facebook_app_secret, "fb-secret")

      on_exit(fn ->
        for k <- [:facebook_app_id, :facebook_app_secret],
            do: Application.delete_env(:hoodride, k)
      end)

      {:ok, f} =
        Accounts.upsert_oauth_user(%{provider: "facebook", provider_id: "f-1", name: "Fay"})

      for path <- ["/auth/facebook?refresh=silent", "/auth/google?refresh=silent"] do
        {_, q} = query(conn |> signed_in(f) |> get(path))
        refute Map.has_key?(q, "login_hint")
        refute Map.has_key?(q, "prompt")
      end
    end

    test "the refresh limit refills: one more every 2 minutes (the shipped numbers)" do
      l = Config.Reader.read!("config/config.exs", env: :prod)[:hoodride][:refresh_budget]
      spend = fn t -> Hoodride.RateBudget.spend(4242, :refresh, l[:per_minute], l[:burst], t) end
      for _ <- 1..5, do: assert({:ok, _} = spend.(0))
      assert {:deny, _} = spend.(0)
      assert {:deny, _} = spend.(119_000)
      assert {:ok, _} = spend.(120_000)
      assert {:deny, _} = spend.(120_000)
    end
  end

  describe "the sweep" do
    test "the server's regular sweep clears lifted sign-in blocks" do
      Application.put_env(:hoodride, :sign_in_failures, max: 1, window_ms: 1, block_ms: 1)
      on_exit(fn -> Application.delete_env(:hoodride, :sign_in_failures) end)
      Hoodride.SignInFailures.record({203, 0, 113, 9}, System.monotonic_time(:millisecond) - 10)
      assert :ets.tab2list(:sign_in_failures) != []
      Hoodride.Sweeper.sweep_now()
      assert :ets.tab2list(:sign_in_failures) == []
    end
  end

  describe "sign-in starts: their own pool" do
    # the numbers that ship (config.exs as prod reads it), not test copies
    setup do
      prod = Config.Reader.read!("config/config.exs", env: :prod)[:hoodride]
      Application.put_env(:hoodride, :sign_in_budget, prod[:sign_in_budget])
      on_exit(fn -> Application.delete_env(:hoodride, :sign_in_budget) end)
      :ok
    end

    test "30 starts from one address pass; the 31st is told to wait; the app's API isn't touched",
         %{conn: conn} do
      for _ <- 1..30, do: assert(redirected_to(get(build_conn(), "/auth/google"), 302))
      assert response(get(build_conn(), "/auth/google"), 429)
      assert json_response(get(conn, "/api/me"), 200)
    end
  end
end
