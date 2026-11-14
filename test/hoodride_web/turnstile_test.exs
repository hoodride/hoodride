defmodule HoodrideWeb.TurnstileTest do
  @moduledoc """
  Cloudflare Turnstile on sign-in START (review 2026-11-14): a check that
  tells a person from a script — invisible for nearly everyone — so scripts
  can't start sign-ins in bulk from a shared address. Cloudflare's
  documented integration (server-side siteverify; tokens single-use, 5
  minutes; hostname and action checked; remoteip; an idempotency key), on
  sign-in only (tokens are per action — never the live connection or the
  API, which a sign-in already guards).

    * OFF until both keys are set (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY:
      GOOGLE_SETUP.md) — sign-in exactly as before;
    * ON: the app gets the pass, POSTs it (JSON — never in the address,
      which ends up in logs) to /auth/start; the server checks it with
      Cloudflare and allows ONE sign-in start for a minute. A start without
      one goes back to the sign-in screen;
    * Cloudflare unreachable (a network error, its 5xx, its internal-error):
      let through and logged — a bot check that's down mustn't lock everyone
      out; a FAILED check never is;
    * the silent "refresh from Google" of someone signed in needs none.
  """
  use HoodrideWeb.ConnCase
  import ExUnit.CaptureLog

  alias Hoodride.TestHelpers

  @site "0x4AAAAAAATESTSITEKEY"
  @secret "0x4AAAAAAATESTSECRET"

  setup do
    TestHelpers.scrub_live_state()
    Application.put_env(:hoodride, :google_client_id, "test-client")
    Application.put_env(:hoodride, :google_client_secret, "test-secret")

    on_exit(fn ->
      for k <- [
            :google_client_id,
            :google_client_secret,
            :turnstile_site_key,
            :turnstile_secret,
            :turnstile_req
          ],
          do: Application.delete_env(:hoodride, k)
    end)

    :ok
  end

  defp turn_on do
    Application.put_env(:hoodride, :turnstile_site_key, @site)
    Application.put_env(:hoodride, :turnstile_secret, @secret)
    Application.put_env(:hoodride, :turnstile_req, plug: {Req.Test, HoodrideWeb.Turnstile})
  end

  # Cloudflare's answer; what we asked it is sent back to the test
  defp cloudflare(reply) do
    test = self()

    Req.Test.stub(HoodrideWeb.Turnstile, fn c ->
      {:ok, body, c} = Plug.Conn.read_body(c)
      send(test, {:asked, URI.decode_query(body)})
      reply.(c)
    end)
  end

  defp passes(c),
    do: Req.Test.json(c, %{"success" => true, "hostname" => "localhost", "action" => "signin"})

  defp start(conn, body), do: TestHelpers.post_json(conn, "/auth/start", body)

  describe "off (no keys)" do
    test "sign-in as before; the page offers no check" do
      assert redirected_to(get(build_conn(), "/auth/google"), 302) =~ "accounts.google.com"
      refute html_response(get(build_conn(), "/"), 200) =~ "hoodride-turnstile"

      assert json_response(start(build_conn(), %{"provider" => "google"}), 200) == %{
               "go" => "/auth/google"
             }
    end
  end

  describe "on" do
    setup do
      turn_on()
      :ok
    end

    test "the page carries the site key (public), never the secret" do
      page = html_response(get(build_conn(), "/"), 200)
      assert page =~ ~s(<meta name="hoodride-turnstile" content="#{@site}">)
      refute page =~ @secret
    end

    test "a sign-in start without a passed check goes back to the sign-in screen" do
      assert redirected_to(get(build_conn(), "/auth/google"), 302) == "/"
    end

    test "a passed check: ONE sign-in start; Cloudflare asked as documented" do
      cloudflare(&passes/1)
      conn = start(build_conn(), %{"provider" => "google", "token" => "tok-1"})
      assert json_response(conn, 200) == %{"go" => "/auth/google"}

      assert_received {:asked, asked}
      assert asked["secret"] == @secret
      assert asked["response"] == "tok-1"
      assert asked["remoteip"] == "127.0.0.1"
      assert asked["idempotency_key"] =~ ~r/\A[0-9a-f-]{36}\z/

      first = get(recycle(conn), "/auth/google")
      assert redirected_to(first, 302) =~ "accounts.google.com"
      # one start per check
      assert redirected_to(get(recycle(first), "/auth/google"), 302) == "/"
    end

    test "a failed check: refused — and no start" do
      cloudflare(
        &Req.Test.json(&1, %{"success" => false, "error-codes" => ["invalid-input-response"]})
      )

      conn = start(build_conn(), %{"provider" => "google", "token" => "bad"})
      assert json_response(conn, 403) == %{"error" => "check_failed"}
      assert redirected_to(get(recycle(conn), "/auth/google"), 302) == "/"
    end

    test "a pass for another site, or another action: refused" do
      for reply <- [
            %{"success" => true, "hostname" => "evil.example", "action" => "signin"},
            %{"success" => true, "hostname" => "localhost", "action" => "something-else"}
          ] do
        cloudflare(&Req.Test.json(&1, reply))
        conn = start(build_conn(), %{"provider" => "google", "token" => "tok"})
        assert json_response(conn, 403) == %{"error" => "check_failed"}
      end
    end

    test "no token, an empty one, or a huge one: refused without asking Cloudflare" do
      cloudflare(&passes/1)

      for body <- [
            %{"provider" => "google"},
            %{"provider" => "google", "token" => ""},
            %{"provider" => "google", "token" => String.duplicate("a", 2049)},
            %{"provider" => "google", "token" => ["x"]}
          ] do
        assert json_response(start(build_conn(), body), 403) == %{"error" => "check_failed"}
      end

      refute_received {:asked, _}
    end

    test "an unknown provider: refused" do
      cloudflare(&passes/1)
      assert start(build_conn(), %{"provider" => "myspace", "token" => "t"}).status == 404
    end

    test "Cloudflare unreachable or failing on its side: let through, and logged" do
      for reply <- [
            &Req.Test.transport_error(&1, :econnrefused),
            &(&1 |> Plug.Conn.put_status(500) |> Req.Test.json(%{})),
            &Req.Test.json(&1, %{"success" => false, "error-codes" => ["internal-error"]})
          ] do
        cloudflare(reply)

        log =
          capture_log(fn ->
            conn = start(build_conn(), %{"provider" => "google", "token" => "tok"})
            assert json_response(conn, 200) == %{"go" => "/auth/google"}
          end)

        assert log =~ "turnstile: Cloudflare's check unavailable"
      end
    end

    test "the silent refresh of someone signed in needs no check" do
      {:ok, g} =
        Hoodride.Accounts.upsert_oauth_user(%{provider: "google", provider_id: "ts-g", name: "G"})

      conn =
        build_conn()
        |> init_test_session(TestHelpers.session_for(g.id))
        |> get("/auth/google?refresh=silent")

      assert redirected_to(conn, 302) =~ "accounts.google.com"
    end
  end

  test "the page's rules let Cloudflare's check run (its script and its frame)" do
    policy = HoodrideWeb.CSP.policy()
    assert policy =~ ~r/script-src [^;]*https:\/\/challenges\.cloudflare\.com/
    assert policy =~ ~r/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/
  end
end
