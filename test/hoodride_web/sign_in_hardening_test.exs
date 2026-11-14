defmodule HoodrideWeb.SignInHardeningTest do
  @moduledoc """
  Sign-in on shared networks, and our standing with Google and Facebook
  (review 2026-11-14, checked against RFC 9700, OWASP, NIST 800-63B and the
  providers' docs by three reviewers).

    * the `state` is ONE-TIME (RFC 9700): the session is a cookie the
      browser keeps, so a saved copy replayed the same state over and over
      — each a call to Google. Now it's used up, on the server, before the
      provider is asked; it lives 15 minutes and belongs to its provider.
      A repeat (a double submit, a lost reply then a retry) leaves the
      session alone and goes home — it must not sign out the winner;
    * only the provider saying THE CODE is bad counts (Google's
      `invalid_grant`, Facebook's code 100) — never our own setup errors
      (logged loudly) or their throttling (a short pause);
    * no per-address block: one person on a café's Wi-Fi could block
      sign-in there for an hour. The count is site-wide: an alarm in the
      log, then a pause of calls to the providers;
    * every sign-in start and return counts against the address — signed
      in or not (a signed-in user spent their own budget: a few accounts
      could flood an address) — except the silent refresh, which has its
      own per-account limit;
    * the session cookie is encrypted, not only signed.
  """
  use HoodrideWeb.ConnCase
  import ExUnit.CaptureLog

  alias Hoodride.{Accounts, SignInFailures}

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    Application.put_env(:hoodride, :google_client_id, "test-client")
    Application.put_env(:hoodride, :google_client_secret, "test-secret")
    Application.put_env(:hoodride, :google_req, plug: {Req.Test, HoodrideWeb.Google})
    Application.put_env(:hoodride, :facebook_app_id, "fb-app")
    Application.put_env(:hoodride, :facebook_app_secret, "fb-secret")
    Application.put_env(:hoodride, :facebook_req, plug: {Req.Test, HoodrideWeb.Facebook})

    on_exit(fn ->
      for k <- [
            :google_client_id,
            :google_client_secret,
            :google_req,
            :facebook_app_id,
            :facebook_app_secret,
            :facebook_req
          ],
          do: Application.delete_env(:hoodride, k)

      # (off in tests — config/test.exs: put back, not deleted, or the real
      # limits would apply to the tests after)
      Application.put_env(:hoodride, :sign_in_failures, nil)
      Application.put_env(:hoodride, :sign_in_budget, nil)
    end)

    :ok
  end

  # how many times the provider was called
  defp counting(name, reply) do
    calls = :counters.new(1, [])

    Req.Test.stub(name, fn c ->
      :counters.add(calls, 1, 1)
      reply.(c)
    end)

    fn -> :counters.get(calls, 1) end
  end

  defp refused(c),
    do: c |> Plug.Conn.put_status(400) |> Req.Test.json(%{"error" => "invalid_grant"})

  defp started(provider \\ "google") do
    conn = get(build_conn(), "/auth/#{provider}")
    %URI{query: q} = URI.parse(redirected_to(conn, 302))
    {conn, URI.decode_query(q)["state"]}
  end

  defp back(conn, provider, state, code \\ "made-up"),
    do: get(recycle(conn), "/auth/#{provider}/callback", %{"code" => code, "state" => state})

  describe "the state is one-time" do
    test "a saved session replayed: the provider is asked once; the repeat goes home, session untouched" do
      calls = counting(HoodrideWeb.Google, &refused/1)
      {conn, state} = started()
      first = back(conn, "google", state)
      assert first.status in [502, 302]

      # the SAME cookie (as an attacker would save it), again
      again = back(conn, "google", state)
      assert calls.() == 1, "the provider was asked again"
      assert redirected_to(again, 302) == "/"
      assert get_resp_header(again, "set-cookie") == [], "the repeat must not touch the session"
    end

    test "a state older than 15 minutes: refused, the provider never asked" do
      calls = counting(HoodrideWeb.Google, &refused/1)
      {conn, state} = started()
      old = System.os_time(:second) - 16 * 60
      conn = conn |> recycle() |> Plug.Test.init_test_session(%{}) |> put_old(state, old)
      res = get(conn, "/auth/google/callback", %{"code" => "c", "state" => state})
      assert res.status == 403
      assert calls.() == 0
    end

    test "a Google state brought to Facebook's return: refused, Facebook never asked" do
      fb = counting(HoodrideWeb.Facebook, &refused/1)
      {conn, state} = started("google")
      res = back(conn, "facebook", state)
      assert res.status == 403
      assert fb.() == 0
    end
  end

  # a session as the start makes it, with an old start time
  defp put_old(conn, state, at) do
    Plug.Test.init_test_session(conn, %{
      "oauth_state" => state,
      "oauth_verifier" => "v",
      "oauth_provider" => "google",
      "oauth_at" => at
    })
  end

  describe "only a bad CODE counts" do
    setup do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 2,
        alert_window_ms: 600_000,
        backoff_ms: 1_000,
        backoff_max_ms: 32_000
      )

      :ok
    end

    test "Google's invalid_grant counts" do
      counting(HoodrideWeb.Google, &refused/1)
      {conn, state} = started()
      back(conn, "google", state)
      assert SignInFailures.count() == 1
    end

    test "Facebook's code 100 counts; its throttling (4, 17, 32, 613) doesn't" do
      counting(HoodrideWeb.Facebook, fn c ->
        c
        |> Plug.Conn.put_status(400)
        |> Req.Test.json(%{"error" => %{"type" => "OAuthException", "code" => 100}})
      end)

      {conn, state} = started("facebook")
      back(conn, "facebook", state)
      assert SignInFailures.count() == 1

      for code <- [4, 17, 32, 613] do
        counting(HoodrideWeb.Facebook, fn c ->
          c |> Plug.Conn.put_status(400) |> Req.Test.json(%{"error" => %{"code" => code}})
        end)

        # (each throttling pauses the calls: as if that wait were over)
        :ets.delete(:sign_in_failures, :paused)
        {conn, state} = started("facebook")
        back(conn, "facebook", state)
      end

      assert SignInFailures.count() == 1
    end

    test "our own setup error (invalid_client): not counted, logged loudly" do
      counting(HoodrideWeb.Google, fn c ->
        c |> Plug.Conn.put_status(401) |> Req.Test.json(%{"error" => "invalid_client"})
      end)

      {conn, state} = started()
      log = capture_log(fn -> back(conn, "google", state) end)
      assert SignInFailures.count() == 0
      assert log =~ "sign-in: google refused our request"
    end

    test "Google's Retry-After is honored" do
      counting(HoodrideWeb.Google, fn c ->
        c
        |> Plug.Conn.put_resp_header("retry-after", "7")
        |> Plug.Conn.put_status(429)
        |> Req.Test.json(%{})
      end)

      {conn, state} = started()
      back(conn, "google", state)
      assert SignInFailures.wait_ms() in 6_000..7_000
    end

    test "no Retry-After: backoff that doubles, at most 32 s; a success starts it over" do
      for _ <- 1..8, do: SignInFailures.throttled("google")
      assert SignInFailures.wait_ms() in 31_000..33_000
      SignInFailures.answered()
      # (a success only comes once the pause is over)
      :ets.delete(:sign_in_failures, :paused)
      SignInFailures.throttled("google")
      assert SignInFailures.wait_ms() in 1..2_000
    end

    test "Google throttling (429): not counted; calls paused briefly" do
      calls =
        counting(HoodrideWeb.Google, &(&1 |> Plug.Conn.put_status(429) |> Req.Test.json(%{})))

      {conn, state} = started()
      back(conn, "google", state)
      assert SignInFailures.count() == 0
      assert SignInFailures.paused?()
      # a new sign-in is told at once (no trip to Google that would end the same way)
      res = get(build_conn(), "/auth/google")
      assert res.status == 503
      assert get_resp_header(res, "retry-after") != []
      assert calls.() == 1, "asked again while paused"
    end

    test "many refused codes: an alarm in the log for the owner" do
      counting(HoodrideWeb.Google, &refused/1)

      log =
        capture_log(fn ->
          for _ <- 1..2 do
            {conn, state} = started()
            back(conn, "google", state)
          end
        end)

      assert log =~ "sign-in: 2 codes refused"
    end
  end

  describe "no block anywhere: per-address limits, a site-wide alarm only" do
    setup do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 3,
        alert_window_ms: 600_000,
        backoff_ms: 1_000,
        backoff_max_ms: 32_000
      )

      :ok
    end

    test "made-up codes never lock an address out: after them, a real start still reaches Google" do
      counting(HoodrideWeb.Google, &refused/1)

      for _ <- 1..40 do
        {conn, state} = started()
        back(conn, "google", state)
      end

      assert redirected_to(get(build_conn(), "/auth/google"), 302) =~ "accounts.google.com"
    end

    # a site-wide count that refused sign-ins would be an off switch anyone
    # could flip: it only warns (telemetry), never pauses
    test "many refused codes site-wide: a warning — and sign-in still reaches Google" do
      calls = counting(HoodrideWeb.Google, &refused/1)

      log =
        capture_log(fn ->
          for _ <- 1..10 do
            {conn, state} = started()
            back(conn, "google", state)
          end
        end)

      assert length(Regex.scan(~r/sign-in: 3 codes refused/, log)) == 1
      refute SignInFailures.paused?()
      assert calls.() == 10
    end
  end

  describe "the address budget for sign-in" do
    setup do
      Application.put_env(:hoodride, :sign_in_budget, per_minute: 60, burst: 3)
      :ok
    end

    test "signed-in people's sign-in starts count against the ADDRESS too" do
      {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "sh-1", name: "Sh"})
      session = Hoodride.TestHelpers.session_for(u.id)

      codes =
        for _ <- 1..5,
            do: (build_conn() |> init_test_session(session) |> get("/auth/google")).status

      assert 429 in codes
      # …and that address is spent for a signed-out visitor too
      assert get(build_conn(), "/auth/google").status == 429
    end

    test "a signed-in person's silent refresh doesn't spend the address" do
      {:ok, g} = Accounts.upsert_oauth_user(%{provider: "google", provider_id: "sh-g", name: "G"})
      session = Hoodride.TestHelpers.session_for(g.id)

      for _ <- 1..5,
          do: build_conn() |> init_test_session(session) |> get("/auth/google?refresh=silent")

      assert get(build_conn(), "/auth/google").status == 302
    end
  end

  test "the session cookie is encrypted, not only signed" do
    opts = HoodrideWeb.Endpoint.session_options()
    assert is_binary(opts[:encryption_salt])
    assert is_binary(opts[:signing_salt])
  end
end
