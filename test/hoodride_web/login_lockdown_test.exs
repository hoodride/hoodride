defmodule HoodrideWeb.LoginLockdownTest do
  @moduledoc """
  The login lockdown, before anyone outside this machine can reach the app.

  - dev_login only from a genuinely LOCAL request: a tunnel forwards from
    127.0.0.1, so the address alone isn't enough — the host must be local
    and no forwarding header may be present.
  - Sessions are checked on the SERVER (OWASP: timeouts and logout "must be
    enforced server-side"; Plug's cookie max_age is browser-side only): the
    session's sign-in token must still exist (Hoodride.SessionTokens) and be
    at most 30 days old.
  - Logout closes every socket of the account and refuses every older
    session and socket token.
  - Socket tokens travel in the WebSocket protocol header (Phoenix
    `auth_token`), not the URL: out of access logs. A URL token (scripts)
    still works, under the same rules, and is filtered from every log.
  - Google sign-in: state + PKCE S256 (RFC 9700; Google's discovery
    document lists S256), the redirect URI from the configured URL in prod.
  - Per-IP HTTP budgets (IPv4 per address, IPv6 per /64 — CVE-2026-45364),
    429 with Retry-After (RFC 6585), the client address read right-to-left
    from trusted proxies only (MDN X-Forwarded-For).
  """
  use HoodrideWeb.ConnCase

  import ExUnit.CaptureLog
  require Phoenix.ChannelTest

  alias Hoodride.Accounts
  alias HoodrideWeb.ClientIp

  @day_ms 86_400_000

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  # (agreed to the Terms of Use: these are about sessions and tokens —
  # TermsTest covers the token refused before agreeing)
  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    u
  end

  defp now_ms, do: System.system_time(:millisecond)

  defp local(conn), do: %{conn | host: "localhost"}

  # a real sign-in (Hoodride.SessionTokens), made `age` ms ago
  defp signed_in(conn, user, age \\ 0),
    do: init_test_session(conn, session(user, age))

  defp session(user, age \\ 0),
    do: Hoodride.TestHelpers.session_for(user.id) |> Hoodride.TestHelpers.age_sign_in(age)

  defp me(conn), do: json_response(get(conn, "/api/me"), 200)["user"]

  # ---------- dev_login: genuinely local only ----------

  describe "dev_login" do
    test "works from this machine (localhost, 127.0.0.1 or ::1), and stamps the sign-in", %{
      conn: conn
    } do
      conn = post(local(conn), "/api/dev_login", %{"name" => "Loc"})
      assert json_response(conn, 200) == %{"ok" => true}
      assert is_binary(get_session(conn, :user_token))
      assert %{"name" => "Loc"} = me(conn)

      v6 = %{build_conn() | host: "localhost", remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}}
      assert json_response(post(v6, "/api/dev_login", %{"name" => "V6"}), 200)
    end

    test "refused through a tunnel: a forwarding header, even from 127.0.0.1", %{conn: conn} do
      for {h, v} <- [
            {"x-forwarded-for", "203.0.113.7"},
            {"forwarded", "for=203.0.113.7"},
            {"x-real-ip", "203.0.113.7"},
            {"x-forwarded-host", "abc.ngrok.app"}
          ] do
        conn = local(conn) |> put_req_header(h, v) |> post("/api/dev_login", %{"name" => "Tun"})
        assert response(conn, 404), "#{h} should be refused"
      end
    end

    test "refused for a public host name (a tunnel that rewrites nothing)", %{conn: conn} do
      conn = %{conn | host: "abc.trycloudflare.com"} |> post("/api/dev_login", %{"name" => "Pub"})
      assert response(conn, 404)
    end

    test "refused from another machine", %{conn: conn} do
      conn =
        %{local(conn) | remote_ip: {192, 168, 1, 20}}
        |> post("/api/dev_login", %{"name" => "Lan"})

      assert response(conn, 404)
    end

    test "refused when switched off (prod)", %{conn: conn} do
      Application.put_env(:hoodride, :dev_login, false)
      on_exit(fn -> Application.put_env(:hoodride, :dev_login, true) end)
      assert response(post(local(conn), "/api/dev_login", %{"name" => "Off"}), 404)
    end
  end

  # ---------- sessions, checked on the server ----------

  describe "sessions" do
    test "a fresh session is signed in", %{conn: conn} do
      u = user("ss-a")
      assert %{"id" => id} = me(signed_in(conn, u))
      assert id == u.id
    end

    test "a session older than 30 days is signed out", %{conn: conn} do
      u = user("ss-old")
      assert me(signed_in(conn, u, 31 * @day_ms)) == nil
      assert me(signed_in(build_conn(), u, 29 * @day_ms))
    end

    test "a session without a sign-in time (older app) is signed out", %{conn: conn} do
      u = user("ss-legacy")
      assert me(init_test_session(conn, %{user_id: u.id})) == nil
    end

    test "every endpoint uses the same check (state, socket_token)", %{conn: conn} do
      u = user("ss-ep")
      old = signed_in(conn, u, 31 * @day_ms)
      assert json_response(get(old, "/api/state"), 200)["user"] == nil

      assert json_response(
               get(signed_in(build_conn(), u, 31 * @day_ms), "/api/socket_token"),
               401
             )
    end
  end

  # ---------- logout: everywhere, for real ----------

  describe "logout" do
    test "records the time, and every older session stops working", %{conn: conn} do
      u = user("lo-a")
      # another device's sign-in (or a stolen copy of a cookie)
      other = signed_in(build_conn(), u)
      conn = post(signed_in(conn, u), "/api/logout")
      assert json_response(conn, 200) == %{"ok" => true}
      assert is_integer(Accounts.get_user(u.id).logged_out_at)

      assert me(other) == nil
      # a sign-in AFTER the logout works
      assert me(signed_in(build_conn(), u))
    end

    test "closes every socket of the account", %{conn: conn} do
      u = user("lo-sock")
      HoodrideWeb.Endpoint.subscribe("user_socket:#{u.id}")
      post(signed_in(conn, u), "/api/logout")
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "without a session it's a harmless no-op", %{conn: conn} do
      assert json_response(post(conn, "/api/logout"), 200) == %{"ok" => true}
    end
  end

  # ---------- socket tokens ----------

  describe "socket tokens" do
    defp token_for(u),
      do: json_response(get(signed_in(build_conn(), u), "/api/socket_token"), 200)["token"]

    test "sent in the protocol header (auth_token) it connects", %{conn: _} do
      u = user("tk-h")

      assert {:ok, socket} =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{auth_token: token_for(u)}
               )

      assert socket.assigns.user_id == u.id
    end

    test "in the URL (scripts) it still connects, under the same rules", %{conn: _} do
      u = user("tk-u")

      assert {:ok, _} =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{"token" => token_for(u)},
                 connect_info: %{}
               )
    end

    test "a token issued before a logout is refused; a new one works", %{conn: conn} do
      u = user("tk-lo")
      old = token_for(u)
      Process.sleep(2)
      post(signed_in(conn, u), "/api/logout")

      assert :error =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{auth_token: old}
               )

      assert :error =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{"token" => old},
                 connect_info: %{}
               )

      Process.sleep(2)

      assert {:ok, _} =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{auth_token: token_for(u)}
               )
    end

    test "a token older than a day, a legacy one, or garbage is refused", %{conn: _} do
      u = user("tk-old")

      old =
        Phoenix.Token.sign(
          HoodrideWeb.Endpoint,
          "user socket",
          %{u: u.id, iat: now_ms() - 2 * @day_ms},
          signed_at: System.system_time(:second) - 2 * 86_400
        )

      legacy = Phoenix.Token.sign(HoodrideWeb.Endpoint, "user socket", u.id)

      for t <- [old, legacy, "garbage"] do
        assert :error =
                 Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                   connect_info: %{auth_token: t}
                 )
      end
    end

    # The update notice came only through the socket (the map join reply):
    # a tab that can't connect — e.g. an old token after a login change —
    # never heard of a new build and retried forever. The app fetches a
    # fresh token after a failed connect; that reply carries the build too.
    test "the token reply carries the server's build — the same one the map join reports" do
      u = user("tk-build")
      reply = json_response(get(signed_in(build_conn(), u), "/api/socket_token"), 200)
      assert reply["build"] == HoodrideWeb.Build.current()
      assert is_binary(reply["build"]) and reply["build"] != ""
    end

    test "the socket is mounted with header tokens on (as Phoenix reads it: top-level)" do
      [{_path, HoodrideWeb.UserSocket, opts}] =
        for {_, HoodrideWeb.UserSocket, _} = s <- HoodrideWeb.Endpoint.__sockets__(), do: s

      assert opts[:auth_token] == true
    end

    test "the session path follows the same rules", %{conn: _} do
      u = user("tk-s")
      fresh = session(u)
      stale = session(u, 31 * @day_ms)

      assert {:ok, _} =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{session: fresh}
               )

      assert :error =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{session: stale}
               )

      assert :error =
               Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
                 connect_info: %{session: %{"user_id" => u.id}}
               )
    end
  end

  # ---------- Google sign-in ----------

  describe "Google sign-in" do
    setup do
      Application.put_env(:hoodride, :google_client_id, "test-client")
      Application.put_env(:hoodride, :google_client_secret, "test-secret")
      Application.put_env(:hoodride, :google_req, plug: {Req.Test, HoodrideWeb.Google})

      on_exit(fn ->
        for k <- [:google_client_id, :google_client_secret, :google_req],
            do: Application.delete_env(:hoodride, k)
      end)
    end

    defp start_sign_in(conn) do
      conn = get(conn, "/auth/google")
      location = redirected_to(conn, 302)
      %URI{query: q} = URI.parse(location)
      {conn, URI.decode_query(q)}
    end

    test "the redirect carries state and a PKCE S256 challenge of the stored verifier", %{
      conn: conn
    } do
      {conn, q} = start_sign_in(conn)
      verifier = get_session(conn, :oauth_verifier)
      assert q["code_challenge_method"] == "S256"

      assert q["code_challenge"] ==
               Base.url_encode64(:crypto.hash(:sha256, verifier), padding: false)

      assert q["state"] == get_session(conn, :oauth_state)
      assert byte_size(verifier) >= 43
    end

    test "the callback sends the verifier, signs in, and stamps the sign-in", %{conn: conn} do
      {conn, q} = start_sign_in(conn)
      verifier = get_session(conn, :oauth_verifier)
      test = self()

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" ->
            {:ok, body, c} = Plug.Conn.read_body(c)
            send(test, {:token_request, URI.decode_query(body)})
            Req.Test.json(c, %{"access_token" => "at-1"})

          "/oauth2/v3/userinfo" ->
            Req.Test.json(c, %{
              "sub" => "g-123",
              "name" => "Gee",
              "email" => "g@example.com",
              "picture" => "p"
            })
        end
      end)

      conn =
        get(recycle(conn), "/auth/google/callback", %{"code" => "c-1", "state" => q["state"]})

      assert redirected_to(conn, 302) == "/"
      assert_received {:token_request, form}
      assert form["code_verifier"] == verifier
      assert form["client_secret"] == "test-secret"
      assert is_binary(get_session(conn, :user_token))
      assert get_session(conn, :oauth_verifier) == nil
      assert %{"name" => "Gee", "provider" => "google"} = me(recycle(conn))
    end

    # strangers see a FIRST name only: Google's given_name, else the full
    # name's first word, else "Neighbor" — never the email
    defp sign_in_with(conn, info) do
      {conn, q} = start_sign_in(conn)

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" -> Req.Test.json(c, %{"access_token" => "at-1"})
          "/oauth2/v3/userinfo" -> Req.Test.json(c, info)
        end
      end)

      conn =
        get(recycle(conn), "/auth/google/callback", %{"code" => "c-1", "state" => q["state"]})

      me(recycle(conn))
    end

    test "the name kept is Google's first name, not the full name", %{conn: conn} do
      me =
        sign_in_with(conn, %{
          "sub" => "g-fn1",
          "name" => "Mary Ann Smith",
          "given_name" => "Mary Ann",
          "family_name" => "Smith",
          "email" => "mas@example.com",
          "picture" => "p"
        })

      assert me["name"] == "Mary Ann"
      assert Hoodride.Accounts.get_user(me["id"]).name == "Mary Ann", "the full name isn't stored"
    end

    test "no given_name: the full name's first word; no name at all: Neighbor, never the email",
         %{conn: conn} do
      assert sign_in_with(conn, %{
               "sub" => "g-fn2",
               "name" => "Dana K",
               "email" => "l@example.com"
             })[
               "name"
             ] == "Dana"

      me = sign_in_with(build_conn(), %{"sub" => "g-fn3", "email" => "secret@example.com"})
      assert me["name"] == "Neighbor"
      refute me["name"] =~ "@"
    end

    test "the next sign-in picks up a name changed at Google", %{conn: conn} do
      sign_in_with(conn, %{"sub" => "g-fn4", "given_name" => "Bob"})

      assert sign_in_with(build_conn(), %{"sub" => "g-fn4", "given_name" => "Robert"})["name"] ==
               "Robert"
    end

    test "a wrong state is refused before Google is asked anything", %{conn: conn} do
      {conn, _q} = start_sign_in(conn)
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c-1", "state" => "forged"})
      assert response(conn, 403)
    end

    test "in prod the redirect URI comes from the configured URL, not the request", %{conn: conn} do
      Application.put_env(:hoodride, :oauth_redirect_from_request, false)
      on_exit(fn -> Application.put_env(:hoodride, :oauth_redirect_from_request, true) end)
      {_conn, q} = start_sign_in(%{conn | host: "evil.example"})
      assert q["redirect_uri"] == HoodrideWeb.Endpoint.url() <> "/auth/google/callback"
    end
  end

  # ---------- the client address ----------

  describe "client address (right to left, trusted proxies only)" do
    defp from(ip, xffs) do
      conn = %{build_conn() | remote_ip: ip}
      # in the order sent (a proxy appends its header last)
      Enum.reduce(xffs, conn, fn v, c ->
        %{c | req_headers: c.req_headers ++ [{"x-forwarded-for", v}]}
      end)
    end

    @proxy {10, 0, 0, 2}

    test "no trusted proxy configured: the header is ignored" do
      assert ClientIp.client_ip(from({198, 51, 100, 9}, ["1.2.3.4"]), []) == {198, 51, 100, 9}
    end

    test "not from our proxy: the header is ignored (a stranger wrote it)" do
      assert ClientIp.client_ip(from({198, 51, 100, 9}, ["1.2.3.4"]), [@proxy]) ==
               {198, 51, 100, 9}
    end

    test "from our proxy: the rightmost address our proxy added; a forged leftmost is ignored" do
      assert ClientIp.client_ip(from(@proxy, ["1.2.3.4, 203.0.113.7"]), [@proxy]) ==
               {203, 0, 113, 7}
    end

    test "several headers are one list; a chain of our proxies is skipped" do
      conn = from(@proxy, ["1.2.3.4", "203.0.113.7, 10.0.0.3"])
      assert ClientIp.client_ip(conn, [@proxy, {10, 0, 0, 3}]) == {203, 0, 113, 7}
    end

    test "through a Cloudflare Tunnel: cloudflared on 127.0.0.1, Cloudflare appended the visitor" do
      # Cloudflare: X-Forwarded-For equals CF-Connecting-IP, or is APPENDED to
      # whatever the client sent — the rightmost is the visitor
      assert ClientIp.client_ip(from({127, 0, 0, 1}, ["6.6.6.6, 198.51.100.77"]), [{127, 0, 0, 1}]) ==
               {198, 51, 100, 77}
    end

    test "the same reader serves the socket (headers as Phoenix hands them over)" do
      assert ClientIp.from_headers(
               {127, 0, 0, 1},
               [{"x-forwarded-for", "1.2.3.4, 198.51.100.8"}],
               [{127, 0, 0, 1}]
             ) ==
               {198, 51, 100, 8}

      assert ClientIp.from_headers({198, 51, 100, 9}, [{"x-forwarded-for", "1.2.3.4"}], [
               {127, 0, 0, 1}
             ]) ==
               {198, 51, 100, 9}
    end

    test "garbage stops the walk: the proxy's own address is used" do
      assert ClientIp.client_ip(from(@proxy, ["not-an-ip"]), [@proxy]) == @proxy
    end

    # SOCKET_PATH: cloudflared reaches the app over a Unix socket — no port
    # per connection, and only who the socket file's permissions allow can
    # connect. Such a connection has NO address: Bandit reports {:local, ""}
    # (deps/bandit socket_helpers.ex map_address). runtime.exs then puts
    # :local in the trusted list.
    @sock {:local, ""}

    test "over the Unix socket (trusted): the visitor Cloudflare appended, forged left ignored" do
      assert ClientIp.client_ip(from(@sock, ["6.6.6.6, 198.51.100.77"]), [:local]) ==
               {198, 51, 100, 77}
    end

    test "a socket peer isn't trusted unless the socket is (an IP list never covers it)" do
      assert ClientIp.client_ip(from(@sock, ["198.51.100.77"]), [{127, 0, 0, 1}]) == @sock
    end

    test ":local trusts the socket, never an IP peer" do
      assert ClientIp.client_ip(from({198, 51, 100, 9}, ["1.2.3.4"]), [:local]) ==
               {198, 51, 100, 9}
    end

    test "over the socket with no usable header: no address (the shared fallback below)" do
      assert ClientIp.client_ip(from(@sock, []), [:local]) == @sock
      assert ClientIp.client_ip(from(@sock, ["not-an-ip"]), [:local]) == @sock
    end

    test "no address: ONE shared budget key, not a crash — and a warning, once per boot" do
      ClientIp.forget_warning()

      log =
        capture_log(fn ->
          assert ClientIp.budget_key(@sock) == :no_address
          assert ClientIp.budget_key({:local, "/other"}) == :no_address
        end)

      assert log =~ "X-Forwarded-For"
      assert length(String.split(log, "X-Forwarded-For")) == 2, "warned once, not per request"
    end

    test "the budget key: IPv4 per address, IPv6 per /64" do
      assert ClientIp.budget_key({203, 0, 113, 7}) == {203, 0, 113, 7}

      assert ClientIp.budget_key({0x2001, 0xDB8, 1, 2, 0xA, 0xB, 0xC, 0xD}) ==
               ClientIp.budget_key({0x2001, 0xDB8, 1, 2, 9, 9, 9, 9})

      refute ClientIp.budget_key({0x2001, 0xDB8, 1, 2, 0, 0, 0, 1}) ==
               ClientIp.budget_key({0x2001, 0xDB8, 1, 3, 0, 0, 0, 1})
    end
  end

  # ---------- per-IP HTTP budgets ----------

  describe "HTTP budget: per account when signed in, per address when not" do
    setup do
      saved = [http_budget: Application.get_env(:hoodride, :http_budget)]
      Application.put_env(:hoodride, :http_budget, per_minute: 60, burst: 5)
      on_exit(fn -> Hoodride.TestHelpers.restore_env(saved) end)
    end

    test "past the burst: 429 with Retry-After and retry_ms" do
      ip = {198, 51, 100, 23}
      ok = for _ <- 1..6, do: get(%{build_conn() | remote_ip: ip}, "/api/me").status
      assert Enum.count(ok, &(&1 == 200)) == 6, "burst + the one-interval tolerance"

      conn = get(%{build_conn() | remote_ip: ip}, "/api/me")
      assert conn.status == 429
      assert [secs] = get_resp_header(conn, "retry-after")
      assert String.to_integer(secs) >= 1
      assert %{"error" => "rate_limited", "retry_ms" => ms} = Jason.decode!(conn.resp_body)
      assert ms > 0
    end

    # /auth/* has its OWN pool (:sign_in_budget, 2026-10-29 — sign-in can't
    # use up the app's budget): HoodrideWeb.SignInRefreshTest
    test "/auth/* is budgeted too — from its own pool, not this one" do
      Application.put_env(:hoodride, :sign_in_budget, per_minute: 60, burst: 5)
      on_exit(fn -> Application.delete_env(:hoodride, :sign_in_budget) end)
      ip = {198, 51, 100, 24}
      codes = for _ <- 1..8, do: get(%{build_conn() | remote_ip: ip}, "/auth/nope").status
      assert 429 in codes
      # the app's own budget at that address is untouched
      assert get(%{build_conn() | remote_ip: ip}, "/api/me").status == 200
    end

    test "another address has its own budget; one IPv6 /64 shares one" do
      for _ <- 1..7, do: get(%{build_conn() | remote_ip: {198, 51, 100, 25}}, "/api/me")
      assert get(%{build_conn() | remote_ip: {198, 51, 100, 26}}, "/api/me").status == 200

      codes =
        for i <- 1..8 do
          get(%{build_conn() | remote_ip: {0x2001, 0xDB8, 7, 7, i, i, i, i}}, "/api/me").status
        end

      assert 429 in codes, "rotating addresses inside one /64 must not reset the budget"
    end

    # many people behind one address (a carrier's CGNAT, a café's Wi-Fi):
    # once signed in, each has their OWN budget
    test "signed in: two accounts on one address each get their own budget" do
      ip = {198, 51, 100, 30}
      a = user("hb-a")
      b = user("hb-b")
      as = fn u -> %{signed_in(build_conn(), u) | remote_ip: ip} end

      for _ <- 1..6, do: assert(get(as.(a), "/api/state").status == 200)
      assert get(as.(a), "/api/state").status == 429
      assert get(as.(b), "/api/state").status == 200, "b doesn't pay for a"
    end

    test "over the Unix socket: each visitor has their own budget, keyed from X-Forwarded-For" do
      Application.put_env(:hoodride, :trusted_proxies, [:local])
      on_exit(fn -> Application.delete_env(:hoodride, :trusted_proxies) end)

      via_socket = fn xff ->
        %{build_conn() | remote_ip: {:local, ""}}
        |> put_req_header("x-forwarded-for", xff)
        |> get("/api/me")
      end

      codes = for _ <- 1..8, do: via_socket.("6.6.6.6, 198.51.100.81").status
      assert 429 in codes
      assert via_socket.("198.51.100.82").status == 200, "another visitor, same socket"
    end

    test "over the socket with no header: answered (one shared budget), never a crash" do
      Application.put_env(:hoodride, :trusted_proxies, [:local])
      on_exit(fn -> Application.delete_env(:hoodride, :trusted_proxies) end)

      capture_log(fn ->
        assert get(%{build_conn() | remote_ip: {:local, ""}}, "/api/me").status == 200
      end)
    end

    test "signed in: switching addresses doesn't reset the account's budget" do
      a = user("hb-hop")

      codes =
        for i <- 1..8 do
          get(%{signed_in(build_conn(), a) | remote_ip: {203, 0, 113, i}}, "/api/state").status
        end

      assert 429 in codes
    end
  end

  # ---------- the WebSocket handshake: per address, before the token ----------

  # OWASP (WebSocket cheat sheet): per-user limits first, per-IP "where user
  # identification isn't available" — the handshake, before the token is
  # checked. Every attempt counts, valid or not (a real person connects about
  # once per page load), at the signed-out HTTP budget's generous numbers.
  # Cloudflare counts per data center; our one server sees every attempt.
  describe "handshake budget" do
    setup do
      saved = for k <- [:ws_budget, :trusted_proxies], do: {k, Application.get_env(:hoodride, k)}
      Application.put_env(:hoodride, :ws_budget, per_minute: 60, burst: 3)
      Application.put_env(:hoodride, :trusted_proxies, [{127, 0, 0, 1}])
      on_exit(fn -> Hoodride.TestHelpers.restore_env(saved) end)
    end

    defp handshake(ip, token, xff \\ nil) do
      info = %{
        peer_data: %{address: ip, port: 40_000, ssl_cert: nil},
        x_headers: if(xff, do: [{"x-forwarded-for", xff}], else: []),
        auth_token: token
      }

      Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{}, connect_info: info)
    end

    test "a burst from one address is refused past the budget; another address isn't", %{conn: _} do
      ip = {198, 51, 100, 40}
      results = for _ <- 1..6, do: handshake(ip, "garbage")
      assert Enum.count(results, &(&1 == {:error, :rate_limited})) >= 1
      u = user("hs-other")
      assert {:ok, _} = handshake({198, 51, 100, 41}, token_for(u))
    end

    test "every attempt counts, valid ones too (the budget is what makes it safe to be generous)",
         %{conn: _} do
      ip = {198, 51, 100, 42}
      for _ <- 1..4, do: handshake(ip, "garbage")
      u = user("hs-valid")
      assert handshake(ip, token_for(u)) == {:error, :rate_limited}
    end

    test "rotating inside one IPv6 /64 shares one budget", %{conn: _} do
      results = for i <- 1..6, do: handshake({0x2001, 0xDB8, 9, 9, i, i, i, i}, "garbage")
      assert {:error, :rate_limited} in results
    end

    test "through the tunnel: keyed by the visitor in X-Forwarded-For, not by cloudflared", %{
      conn: _
    } do
      tunnel = {127, 0, 0, 1}
      for _ <- 1..5, do: handshake(tunnel, "garbage", "6.6.6.6, 198.51.100.50")
      assert handshake(tunnel, "garbage", "198.51.100.50") == {:error, :rate_limited}
      u = user("hs-tunnel")

      assert {:ok, _} = handshake(tunnel, token_for(u), "198.51.100.51"),
             "another visitor, same tunnel"
    end

    test "over the Unix socket: keyed by the visitor in X-Forwarded-For", %{conn: _} do
      Application.put_env(:hoodride, :trusted_proxies, [:local])
      sock = {:local, ""}
      for _ <- 1..5, do: handshake(sock, "garbage", "6.6.6.6, 198.51.100.52")
      assert handshake(sock, "garbage", "198.51.100.52") == {:error, :rate_limited}
      u = user("hs-sock")
      assert {:ok, _} = handshake(sock, token_for(u), "198.51.100.53"), "another visitor"
    end

    test "over the socket with no header: let in (one shared budget), never a crash", %{
      conn: _
    } do
      Application.put_env(:hoodride, :trusted_proxies, [:local])
      u = user("hs-sock-nohdr")
      capture_log(fn -> assert {:ok, _} = handshake({:local, ""}, token_for(u)) end)
    end

    test "from an untrusted address the header is ignored: keyed by the real peer", %{conn: _} do
      peer = {198, 51, 100, 60}
      for i <- 1..5, do: handshake(peer, "garbage", "10.9.9.#{i}")
      assert handshake(peer, "garbage", "10.9.9.99") == {:error, :rate_limited}
    end

    test "the socket is mounted with the address info it needs" do
      [{_path, HoodrideWeb.UserSocket, opts}] =
        for {_, HoodrideWeb.UserSocket, _} = s <- HoodrideWeb.Endpoint.__sockets__(), do: s

      info = opts[:websocket][:connect_info]
      assert :peer_data in info and :x_headers in info
    end
  end

  # ---------- out of the logs ----------

  describe "logs" do
    test "a socket token is never written to the connect log", %{conn: _} do
      u = user("log-t")
      token = token_for(u)
      previous = Logger.level()

      log =
        try do
          Logger.configure(level: :info)

          capture_log([level: :info], fn ->
            {:ok, _} =
              Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{"token" => token},
                connect_info: %{}
              )
          end)
        after
          Logger.configure(level: previous)
        end

      refute log =~ token
    end

    test "the filter covers tokens, chat text and positions" do
      params = %{"token" => "t0k", "text" => "hi there", "lat" => 40.7, "lng" => -74.0, "to" => 5}
      filtered = Phoenix.Logger.filter_values(params)

      for k <- ~w(token text lat lng),
          do: assert(filtered[k] == "[FILTERED]", "#{k} must be filtered")

      assert filtered["to"] == 5, "only those: other params stay readable"
    end
  end

  # ---------- config ----------

  describe "config" do
    test "dev checks the socket origin against the request's own host (:conn)" do
      dev = Config.Reader.read!("config/dev.exs", env: :dev)
      assert dev[:hoodride][HoodrideWeb.Endpoint][:check_origin] == :conn
    end

    test "prod listens on 127.0.0.1 by default — reachable only through cloudflared" do
      env = %{
        "DATABASE_PATH" => "/tmp/x.db",
        "SECRET_KEY_BASE" => String.duplicate("a", 64),
        "PHX_HOST" => "hood.example"
      }

      for {k, v} <- env, do: System.put_env(k, v)

      try do
        cfg = Config.Reader.read!("config/runtime.exs", env: :prod)
        assert cfg[:hoodride][HoodrideWeb.Endpoint][:http][:ip] == {127, 0, 0, 1}

        System.put_env("BIND_IP", "0.0.0.0")
        cfg = Config.Reader.read!("config/runtime.exs", env: :prod)
        assert cfg[:hoodride][HoodrideWeb.Endpoint][:http][:ip] == {0, 0, 0, 0}
      after
        for k <- ["BIND_IP" | Map.keys(env)], do: System.delete_env(k)
      end
    end

    test "SOCKET_PATH: listen on that Unix socket (port 0) and trust it; unset: neither" do
      env = %{
        "DATABASE_PATH" => "/tmp/x.db",
        "SECRET_KEY_BASE" => String.duplicate("a", 64),
        "PHX_HOST" => "hood.example",
        "TRUSTED_PROXIES" => "127.0.0.1"
      }

      for {k, v} <- env, do: System.put_env(k, v)

      try do
        cfg = Config.Reader.read!("config/runtime.exs", env: :prod)
        assert cfg[:hoodride][HoodrideWeb.Endpoint][:http][:ip] == {127, 0, 0, 1}
        refute :local in cfg[:hoodride][:trusted_proxies]

        System.put_env("SOCKET_PATH", "/run/hoodride/app.sock")
        cfg = Config.Reader.read!("config/runtime.exs", env: :prod)
        http = cfg[:hoodride][HoodrideWeb.Endpoint][:http]
        assert http[:ip] == {:local, "/run/hoodride/app.sock"}
        assert http[:port] == 0, "Thousand Island: a Unix socket needs port 0"
        assert :local in cfg[:hoodride][:trusted_proxies]
        assert {127, 0, 0, 1} in cfg[:hoodride][:trusted_proxies]
      after
        for k <- ["SOCKET_PATH" | Map.keys(env)], do: System.delete_env(k)
      end
    end

    test "the handshake budget: on (config.exs), off in dev (the monster is one address)" do
      # config.exs imports the env's file last: read it as prod (which keeps
      # the base value) — read as dev it's nil, and `nil >= 100` is TRUE in
      # Elixir's term order (this check passed with any number; mutant-caught)
      base = Config.Reader.read!("config/config.exs", env: :prod)
      burst = base[:hoodride][:ws_budget][:burst]
      assert is_integer(burst) and burst >= 100
      dev = Config.Reader.read!("config/dev.exs", env: :dev)
      assert Keyword.has_key?(dev[:hoodride], :ws_budget) and dev[:hoodride][:ws_budget] == nil
    end

    # the capacity test runs the prod build with simulated people: dev_login
    # (still local-only) and no per-IP budgets (they all come from one
    # address) — and NOTHING else differs from prod
    test "loadtest = prod + dev_login + no per-IP budgets, and nothing else" do
      prod = Config.Reader.read!("config/config.exs", env: :prod)
      lt = Config.Reader.read!("config/config.exs", env: :loadtest)

      assert lt[:hoodride][:dev_login] == true
      assert lt[:hoodride][:http_budget] == nil
      assert lt[:hoodride][:ws_budget] == nil
      assert lt[:hoodride][:sign_in_budget] == nil
      assert lt[:hoodride][:sign_in_failures] == nil
      assert prod[:hoodride][:dev_login] == false, "the real prod build is unchanged"

      strip = fn cfg ->
        Keyword.update!(
          cfg,
          :hoodride,
          &Keyword.drop(&1, [
            :dev_login,
            :http_budget,
            :ws_budget,
            :sign_in_budget,
            :sign_in_failures
          ])
        )
      end

      assert strip.(lt) == strip.(prod)
    end

    test "loadtest gets prod's runtime settings (socket, secrets, host)" do
      env = %{
        "DATABASE_PATH" => "/tmp/x.db",
        "SECRET_KEY_BASE" => String.duplicate("a", 64),
        "PHX_HOST" => "hood.example"
      }

      for {k, v} <- env, do: System.put_env(k, v)

      try do
        prod = Config.Reader.read!("config/runtime.exs", env: :prod)
        lt = Config.Reader.read!("config/runtime.exs", env: :loadtest)
        assert lt == prod
        assert lt[:hoodride][HoodrideWeb.Endpoint][:http][:ip] == {127, 0, 0, 1}
      after
        for k <- Map.keys(env), do: System.delete_env(k)
      end
    end

    test "prod: secure session cookie, dev_login off, redirect URI from the configured URL" do
      prod = Config.Reader.read!("config/prod.exs", env: :prod)
      assert prod[:hoodride][:secure_cookie] == true
      assert prod[:hoodride][:dev_login] == false
      assert prod[:hoodride][:oauth_redirect_from_request] == false
    end
  end
end
