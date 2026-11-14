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

  Limits (RFC 6819 §4.4.1.12): `state` is checked — and used up, once —
  before Google is asked anything; sign-in starts and returns have their
  own pool per address. Codes Google refuses are counted site-wide and
  WATCHED — no address is blocked any more (one person on a shared Wi-Fi
  could block it for an hour: review 2026-11-14,
  HoodrideWeb.SignInHardeningTest). Only Google or Facebook throttling us
  pauses the calls to them.
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
    do: init_test_session(conn, Hoodride.TestHelpers.session_for(user.id))

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

  # Google or Facebook throttling us (their 429): calls to them wait a
  # moment (their Retry-After, else backoff). Someone signed in and
  # refreshing goes back to the app with a note — never stranded on a bare
  # page; anyone else gets a short page saying try again in a moment
  describe "the providers throttling us, signed in" do
    setup do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 3,
        alert_window_ms: 180_000,
        backoff_ms: 1_000,
        backoff_max_ms: 32_000
      )

      on_exit(fn -> Application.put_env(:hoodride, :sign_in_failures, nil) end)
      :ok
    end

    defp throttled, do: Hoodride.SignInFailures.throttled("google", 60_000)

    test "a refresh goes back to the app with a note; Google isn't asked", %{conn: conn, g: g} do
      throttled()

      for mode <- ["1", "silent"] do
        c = conn |> signed_in(g) |> get("/auth/google?refresh=" <> mode)
        assert redirected_to(c, 302) == "/?refresh=blocked"
      end
    end

    test "any signed-in account refreshing then goes back to the app (not only Google)", %{
      conn: conn,
      d: d
    } do
      throttled()
      c = conn |> signed_in(d) |> get("/auth/google?refresh=silent")
      assert redirected_to(c, 302) == "/?refresh=blocked"
    end

    test "an ordinary sign-in gets the short 'busy' page, with Retry-After", %{conn: conn} do
      throttled()
      res = get(conn, "/auth/google")
      assert response(res, 503) =~ "Sign-in is busy right now"
      assert [_] = get_resp_header(res, "retry-after")
    end

    test "throttled between leaving and coming back: back to the app, still signed in", %{
      conn: conn,
      g: g
    } do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=silent")
      {_, q} = query(conn)
      throttled()
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(conn, 302) == "/?refresh=blocked"
      assert json_response(get(recycle(conn), "/api/me"), 200)["user"]["id"] == g.id
    end

    test "the wait over: sign-in reaches Google again", %{conn: conn} do
      throttled()
      assert response(get(conn, "/auth/google"), 503)
      :ets.delete(:sign_in_failures, :paused)
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

  # A2 (2026-11-11): the hint is only a hint — at Google's account picker
  # (the button) someone signed into two Google accounts can pick the
  # other one. A refresh completes ONLY as the account signed in now:
  # anything else signs no one in, makes no account and changes none —
  # "that's another Google account" (sign out first to switch).
  describe "a refresh that comes back as ANOTHER Google account" do
    defp google_users(sub),
      do:
        Hoodride.Repo.query!(
          "SELECT count(*) FROM users WHERE provider = 'google' AND provider_id = ?",
          [sub]
        ).rows

    defp refresh_back_as(conn, mode, info) do
      conn = get(conn, "/auth/google?refresh=" <> mode)
      {_, q} = query(conn)
      google_says(info)
      get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
    end

    test "a NEW Google account: not signed in, no account made — back, still the same person",
         %{conn: conn, g: g} do
      for mode <- ["1", "silent"] do
        c =
          build_conn()
          |> signed_in(g)
          |> refresh_back_as(mode, %{"sub" => "g-sub-new", "given_name" => "Newt"})

        assert redirected_to(c, 302) == "/?refresh=other", mode
        assert json_response(get(recycle(c), "/api/me"), 200)["user"]["id"] == g.id, mode
        assert google_users("g-sub-new") == [[0]], "#{mode}: an account was made"
      end

      _ = conn
    end

    test "an EXISTING other account: not signed in as it, and it isn't changed", %{
      conn: conn,
      g: g
    } do
      {:ok, h} =
        Accounts.upsert_oauth_user(%{provider: "google", provider_id: "g-sub-88", name: "Hal"})

      c =
        conn
        |> signed_in(g)
        |> refresh_back_as("1", %{"sub" => "g-sub-88", "given_name" => "Harold"})

      assert redirected_to(c, 302) == "/?refresh=other"
      assert json_response(get(recycle(c), "/api/me"), 200)["user"]["id"] == g.id
      assert Accounts.get_user(h.id).name == "Hal", "the other account was written"
      assert Accounts.get_user(g.id).name == "Gina"
    end

    test "the sign-in itself is untouched: still valid, no new one made for the other account",
         %{conn: conn, g: g} do
      {:ok, h} =
        Accounts.upsert_oauth_user(%{provider: "google", provider_id: "g-sub-88", name: "Hal"})

      conn = signed_in(conn, g)
      token = get_session(conn, :user_token)
      c = refresh_back_as(conn, "1", %{"sub" => "g-sub-88", "given_name" => "Hal"})
      assert get_session(c, :user_token) == token
      assert {:ok, _} = Hoodride.SessionTokens.lookup(token)
      refute Hoodride.SessionTokens.any?(h.id)
    end

    test "signed out meanwhile: another account comes back — no one signed in, nothing made",
         %{conn: conn, g: g} do
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(conn)
      {:ok, _} = Hoodride.SessionTokens.revoke_all(g.id)
      google_says(%{"sub" => "g-sub-new", "given_name" => "Newt"})
      c = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(c, 302) == "/"
      assert json_response(get(recycle(c), "/api/me"), 200)["user"] == nil
      assert google_users("g-sub-new") == [[0]]
    end

    # another tab of the same browser became account H after this refresh
    # left (signed out and in): the refresh coming back as G must not take
    # the browser back to G — it is H's now
    test "the browser is another account by the time it comes back: not switched back", %{g: g} do
      {:ok, h} =
        Accounts.upsert_oauth_user(%{provider: "google", provider_id: "g-sub-88", name: "Hal"})

      started = build_conn() |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(started)

      oauth =
        for k <- ["oauth_state", "oauth_verifier", "oauth_refresh", "oauth_provider", "oauth_at"],
            into: %{},
            do: {k, get_session(started, k)}

      now_h =
        init_test_session(build_conn(), Map.merge(Hoodride.TestHelpers.session_for(h.id), oauth))

      google_says(%{"sub" => "g-sub-77", "given_name" => "Gina"})
      c = get(now_h, "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(c, 302) == "/?refresh=other"
      assert json_response(get(recycle(c), "/api/me"), 200)["user"]["id"] == h.id
    end

    # (review, 2026-11-11: a state is not tied to its provider — a Google
    # refresh's state taken to the FACEBOOK callback crashed (500) on the
    # refresh's expected account)
    test "a refresh's state taken to the Facebook callback: no one signed in, no 500", %{
      conn: conn,
      g: g
    } do
      Application.put_env(:hoodride, :facebook_app_id, "fb-app")
      Application.put_env(:hoodride, :facebook_app_secret, "fb-secret")
      Application.put_env(:hoodride, :facebook_req, plug: {Req.Test, HoodrideWeb.Facebook})

      on_exit(fn ->
        for k <- [:facebook_app_id, :facebook_app_secret, :facebook_req],
            do: Application.delete_env(:hoodride, k)
      end)

      Req.Test.stub(HoodrideWeb.Facebook, fn c ->
        if c.request_path =~ "access_token",
          do: Req.Test.json(c, %{"access_token" => "at"}),
          else: Req.Test.json(c, %{"id" => "fb-9", "first_name" => "Fred"})
      end)

      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(conn)
      c = get(recycle(conn), "/auth/facebook/callback", %{"code" => "c", "state" => q["state"]})
      # (2026-11-14: a state now belongs to its provider — refused before
      # Facebook is even asked; still signed in as G, nothing written)
      assert redirected_to(c, 302) == "/?refresh=failed"
      assert json_response(get(recycle(c), "/api/me"), 200)["user"]["id"] == g.id

      assert Hoodride.Repo.query!("SELECT count(*) FROM users WHERE provider = 'facebook'").rows ==
               [[0]]
    end

    test "an ordinary sign-in (not a refresh) may still pick another account", %{conn: conn, g: g} do
      {:ok, h} =
        Accounts.upsert_oauth_user(%{provider: "google", provider_id: "g-sub-88", name: "Hal"})

      conn = conn |> signed_in(g) |> get("/auth/google")
      {_, q} = query(conn)
      google_says(%{"sub" => "g-sub-88", "given_name" => "Hal"})
      c = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(c, 302) == "/"
      assert json_response(get(recycle(c), "/api/me"), 200)["user"]["id"] == h.id
    end

    test "a code Google refuses during a refresh is still counted (never skipped)", %{
      conn: conn,
      g: g
    } do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 3,
        alert_window_ms: 180_000,
        backoff_ms: 1_000,
        backoff_max_ms: 32_000
      )

      on_exit(fn -> Application.put_env(:hoodride, :sign_in_failures, nil) end)
      conn = conn |> signed_in(g) |> get("/auth/google?refresh=1")
      {_, q} = query(conn)
      {:ok, _} = Hoodride.SessionTokens.revoke_all(g.id)

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        c |> Plug.Conn.put_status(400) |> Req.Test.json(%{"error" => "invalid_grant"})
      end)

      get(recycle(conn), "/auth/google/callback", %{"code" => "made-up", "state" => q["state"]})
      assert Hoodride.SignInFailures.count() == 1
    end
  end

  describe "failed sign-ins (made-up codes)" do
    setup do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 3,
        alert_window_ms: 180_000,
        backoff_ms: 1_000,
        backoff_max_ms: 32_000
      )

      on_exit(fn -> Application.put_env(:hoodride, :sign_in_failures, nil) end)

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

    defp reaches_google?,
      do: redirected_to(get(build_conn(), "/auth/google"), 302) =~ "accounts.google.com"

    test "codes Google refuses are counted (site-wide); the address is never blocked", %{conn: _} do
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert Hoodride.SignInFailures.count() == 5
      assert reaches_google?()
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
      assert Hoodride.SignInFailures.count() == 0
    end

    # only a code the provider REFUSES counts: Google down, a network
    # error, or a failure after the code was accepted
    defp not_counted?, do: Hoodride.SignInFailures.count() == 0

    test "Google down (5xx) isn't counted", %{conn: _} do
      Req.Test.stub(HoodrideWeb.Google, &(&1 |> Plug.Conn.put_status(503) |> Req.Test.json(%{})))
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_counted?()
    end

    test "an 'OK' reply without a token (malformed) isn't counted", %{conn: _} do
      Req.Test.stub(HoodrideWeb.Google, &Req.Test.json(&1, %{}))
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_counted?()
    end

    test "a network error isn't counted", %{conn: _} do
      Req.Test.stub(HoodrideWeb.Google, &Req.Test.transport_error(&1, :econnrefused))
      for _ <- 1..5, do: assert(response(fake_code(build_conn()), 502))
      assert not_counted?()
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
      assert not_counted?()
    end

    test "Facebook's refused codes count the same way (for when it's switched on)", %{conn: _} do
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

      assert Hoodride.SignInFailures.count() == 3
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
      l = Hoodride.Limits.refresh_budget()
      spend = fn t -> Hoodride.RateBudget.spend(4242, :refresh, l[:per_minute], l[:burst], t) end
      for _ <- 1..5, do: assert({:ok, _} = spend.(0))
      assert {:deny, _} = spend.(0)
      assert {:deny, _} = spend.(119_000)
      assert {:ok, _} = spend.(120_000)
      assert {:deny, _} = spend.(120_000)
    end
  end

  describe "the sweep" do
    test "the server's regular sweep forgets an ended pause and an old count" do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 99,
        alert_window_ms: 1,
        backoff_ms: 1,
        backoff_max_ms: 1
      )

      on_exit(fn -> Application.put_env(:hoodride, :sign_in_failures, nil) end)
      past = System.monotonic_time(:millisecond) - 10
      Hoodride.SignInFailures.record(past)
      Hoodride.SignInFailures.throttled("google", 1, past)
      Hoodride.SignInFailures.answered()
      assert :ets.tab2list(:sign_in_failures) != []
      Hoodride.Sweeper.sweep_now()
      assert :ets.tab2list(:sign_in_failures) == []
    end
  end

  describe "sign-in starts: their own pool" do
    # the numbers that ship (Hoodride.Limits), not test copies
    setup do
      Application.put_env(:hoodride, :sign_in_budget, Hoodride.Limits.sign_in_budget())
      on_exit(fn -> Application.put_env(:hoodride, :sign_in_budget, nil) end)
      :ok
    end

    test "a burst of starts from one address passes; the one past it is told to wait; the app's API isn't touched",
         %{conn: conn} do
      burst = Hoodride.Limits.sign_in_budget()[:burst]
      for _ <- 1..burst, do: assert(redirected_to(get(build_conn(), "/auth/google"), 302))
      # (it refills while the burst runs: a few more, quickly, meet the wait)
      codes = for _ <- 1..20, do: get(build_conn(), "/auth/google").status
      assert 429 in codes
      assert json_response(get(conn, "/api/me"), 200)
    end
  end
end
