defmodule HoodrideWeb.SignInTokensTest do
  @moduledoc """
  Sign-in with tokens, as Phoenix's own design (owner, 2026-11-08;
  Hoodride.SessionTokens), from the outside:

    * using the app keeps you signed in: opening it (/api/state) or
      reconnecting (/api/socket_token) replaces a week-old token — signed
      out only after 30 days without opening the app, a year at most;
    * THE BUG this closes: a connection pass made during a sign-out used to
      stay valid for a day. A pass now names its sign-in; the sign-out
      deletes it — refused at connect AND at join (Phoenix subscribes a
      socket to its "disconnect" only after connect, so a connect racing the
      sign-out could miss it);
    * an action on a live connection after a sign-out is refused (a ✋ queued
      meanwhile left a ghost hand);
    * a Google refresh finishing after a sign-out everywhere doesn't sign
      that device back in;
    * signing in again from the same browser (the silent refresh does, on
      every return) never piles up tokens.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3, assert_reply: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Accounts, Geo, Repo}
  alias Hoodride.TestHelpers

  @day 86_400_000
  @cell "882a1072c7fffff"

  setup do
    TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    Accounts.get_user(u.id)
  end

  defp signed_in(u, age \\ 0),
    do:
      init_test_session(
        build_conn(),
        TestHelpers.session_for(u.id) |> TestHelpers.age_sign_in(age)
      )

  defp tokens(u),
    do: Repo.query!("SELECT count(*) FROM user_tokens WHERE user_id = ?", [u.id]).rows

  defp me(conn), do: json_response(get(conn, "/api/me"), 200)["user"]

  describe "using the app keeps you signed in" do
    test "a week-old sign-in is replaced when the app opens; both work, the cookie has the new one" do
      u = user("tk-week")
      conn = signed_in(u, 8 * @day)
      old = get_session(conn, :user_token)

      opened = get(conn, "/api/state")
      assert json_response(opened, 200)["user"]["id"] == u.id
      new = get_session(opened, :user_token)
      assert is_binary(new) and new != old, "the cookie carries the new sign-in"
      assert tokens(u) == [[2]]

      # the next open, from the cookie it got: still signed in
      assert me(recycle(opened))["id"] == u.id
    end

    test "younger than a week: nothing replaced" do
      u = user("tk-young")
      conn = signed_in(u, 6 * @day)
      old = get_session(conn, :user_token)
      opened = get(conn, "/api/state")
      assert get_session(opened, :user_token) == old
      assert tokens(u) == [[1]]
    end

    test "an app kept open reconnects through /api/socket_token: replaced there too, the pass names the new one" do
      u = user("tk-sock")
      conn = signed_in(u, 8 * @day)
      old = get_session(conn, :user_token)
      res = get(conn, "/api/socket_token")
      %{"token" => pass} = json_response(res, 200)
      new = get_session(res, :user_token)
      assert is_binary(new) and new != old, "replaced"
      assert tokens(u) == [[2]]
      assert %{token_hash: h} = HoodrideWeb.Auth.token_user(pass)
      assert h == Hoodride.SessionTokens.hash(new)
    end

    # the whole point: in use for more than 30 days, never signed out
    test "opened every few weeks, past 30 days since signing in: still signed in" do
      u = user("tk-long")
      first = signed_in(u, 8 * @day)
      old_session = get_session(first)
      old = old_session["user_token"]
      # the app opened: the week-old sign-in replaced
      conn = get(first, "/api/state")
      new = get_session(conn, :user_token)

      # 25 days pass: the first sign-in is now 33 days old, the new one 25
      TestHelpers.age_sign_in(%{"user_token" => old}, 25 * @day)
      TestHelpers.age_sign_in(%{"user_token" => new}, 25 * @day)

      assert me(init_test_session(build_conn(), old_session)) == nil, "the first one: 33 days"
      assert me(recycle(conn))["id"] == u.id, "33 days since signing in, still signed in"
    end

    # (the cookie is signed, so this can't be forged — but the token, not
    # the session's own claim, says whose sign-in it is)
    test "a session whose account isn't its sign-in's: not signed in" do
      a = user("tk-a")
      b = user("tk-b")
      session = TestHelpers.session_for(a.id) |> Map.put("user_id", b.id)
      assert me(init_test_session(build_conn(), session)) == nil
    end

    test "30 days without opening the app: signed out" do
      u = user("tk-idle")
      assert me(signed_in(u, 31 * @day)) == nil
    end
  end

  describe "the sign-out bug" do
    test "a pass made before the sign-out is refused at connect" do
      u = user("tk-pass")
      conn = signed_in(u)
      %{"token" => pass} = json_response(get(conn, "/api/socket_token"), 200)
      assert json_response(post(conn, "/api/logout"), 200) == %{"ok" => true}

      assert Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
               connect_info: %{auth_token: pass}
             ) == :error
    end

    test "connected before the sign-out, joining after: refused, and the socket closed" do
      u = user("tk-join")
      conn = signed_in(u)
      %{"token" => pass} = json_response(get(conn, "/api/socket_token"), 200)

      {:ok, socket} =
        Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{auth_token: pass}
        )

      # the sign-out lands between the connect and the joins
      assert json_response(post(conn, "/api/logout"), 200) == %{"ok" => true}

      for topic <- ["user:#{u.id}", "world", "ride:r1"] do
        assert subscribe_and_join(socket, topic, %{}) == {:error, %{reason: "signed_out"}},
               topic
      end

      assert_received %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "an action on a live connection after the sign-out is refused: no ghost ✋" do
      u = user("tk-hand")
      conn = signed_in(u)

      {:ok, socket} =
        Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{session: TestHelpers.session_for(u.id)}
        )

      {:ok, _, chan} = subscribe_and_join(socket, "user:#{u.id}", %{})
      # signed out everywhere (this device's disconnect not yet landed)
      :ok = Accounts.mark_logged_out(u.id)

      ref = Phoenix.ChannelTest.push(chan, "hand_up", %{"cell" => @cell, "spot" => @cell})
      assert_reply ref, :error, %{reason: "signed_out"}
      assert Geo.hand_of(u.id) == nil
      _ = conn
    end
  end

  describe "signing in" do
    setup do
      Application.put_env(:hoodride, :google_client_id, "test-client")
      Application.put_env(:hoodride, :google_client_secret, "test-secret")
      Application.put_env(:hoodride, :google_req, plug: {Req.Test, HoodrideWeb.Google})

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" -> Req.Test.json(c, %{"access_token" => "at"})
          "/oauth2/v3/userinfo" -> Req.Test.json(c, %{"sub" => "tk-g", "given_name" => "Gus"})
        end
      end)

      on_exit(fn ->
        for k <- [:google_client_id, :google_client_secret, :google_req],
            do: Application.delete_env(:hoodride, k)
      end)

      {:ok, g} =
        Accounts.upsert_oauth_user(%{provider: "google", provider_id: "tk-g", name: "Gus"})

      %{g: g}
    end

    defp state_of(conn) do
      %URI{query: q} = URI.parse(redirected_to(conn, 302))
      URI.decode_query(q)["state"]
    end

    test "a refresh finishing after a sign-out everywhere doesn't sign this device back in", %{
      g: g
    } do
      conn = get(signed_in(g), "/auth/google?refresh=silent")
      state = state_of(conn)
      # another device signs out everywhere while Google answers
      :ok = Accounts.mark_logged_out(g.id)

      back = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => state})
      assert redirected_to(back, 302) == "/"
      assert me(recycle(back)) == nil
      assert tokens(g) == [[0]]
    end

    test "a refresh that works: the same browser keeps ONE sign-in (no pile-up)", %{g: g} do
      conn = signed_in(g)

      # (the first request on the test's own session; after that the browser's
      # cookie, as a real one — recycle drops a test session)
      conn =
        Enum.reduce(1..3, conn, fn i, c ->
          c = get(if(i == 1, do: c, else: recycle(c)), "/auth/google?refresh=silent")
          get(recycle(c), "/auth/google/callback", %{"code" => "c", "state" => state_of(c)})
        end)

      assert me(recycle(conn))["id"] == g.id
      assert tokens(g) == [[1]]
    end

    test "dev login twice from the same browser: one sign-in" do
      conn = post(%{build_conn() | host: "localhost"}, "/api/dev_login", %{"name" => "TkDev"})
      conn = post(%{recycle(conn) | host: "localhost"}, "/api/dev_login", %{"name" => "TkDev"})
      id = me(recycle(conn))["id"]
      assert tokens(%{id: id}) == [[1]]
    end
  end
end
