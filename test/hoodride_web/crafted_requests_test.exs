defmodule HoodrideWeb.CraftedRequestsTest do
  @moduledoc """
  Crafted requests get a clean refusal, never a server error (server
  review, 2026-11-08). Each of these used to crash its own request or
  channel — never the server, but the person saw a raw error page, the log
  got a full crash report, and some crashed halfway through (dev login wrote
  the account, then failed).

    * the sign-in return: `state` or `code` that isn't text (`state[]=x`)
    * the provider's token reply: an access token that isn't text
    * Google's profile reply: no `sub`, a `sub` that isn't text, or not a map
    * joining `user:abc`, `user:`, `user:1_000` — and `user:0<id>` /
      `user:+<id>`, which used to JOIN as that user's own channel under a
      topic nothing is ever sent to
    * dev login: a name or photo that isn't text, a blank or huge name
    * the database failing during a refresh or dev login

  Someone signed in whose refresh fails goes BACK TO THE APP — never a bare
  page outside it (the silent refresh runs on its own when the app comes
  back to the front). "Couldn't refresh" only when it really was a refresh;
  anyone else signed in goes back plainly.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  import Ecto.Query, only: [from: 2]
  alias Hoodride.Accounts

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    Application.put_env(:hoodride, :google_client_id, "test-client")
    Application.put_env(:hoodride, :google_client_secret, "test-secret")
    Application.put_env(:hoodride, :google_req, plug: {Req.Test, HoodrideWeb.Google})

    on_exit(fn ->
      for k <- [:google_client_id, :google_client_secret, :google_req, :user_lookup],
          do: Application.delete_env(:hoodride, k)
    end)

    {:ok, g} =
      Accounts.upsert_oauth_user(%{provider: "google", provider_id: "cr-sub-1", name: "Gia"})

    %{g: g}
  end

  defp signed_in(conn, user),
    do: init_test_session(conn, Hoodride.TestHelpers.session_for(user.id))

  defp state_of(conn) do
    %URI{query: q} = URI.parse(redirected_to(conn, 302))
    URI.decode_query(q)["state"]
  end

  defp google_says(token_body, info) do
    Req.Test.stub(HoodrideWeb.Google, fn c ->
      send(self(), :google_called)

      case c.request_path do
        "/token" -> Req.Test.json(c, token_body)
        "/oauth2/v3/userinfo" -> Req.Test.json(c, info)
      end
    end)
  end

  # an ordinary sign-in, started properly, then the crafted return
  defp sign_in_returning(params) do
    started = get(build_conn(), "/auth/google")

    get(
      recycle(started),
      "/auth/google/callback",
      Map.put_new(params, "state", state_of(started))
    )
  end

  describe "the sign-in return" do
    test "state that isn't text: the mismatch page, Google never asked" do
      google_says(%{"access_token" => "at"}, %{"sub" => "x"})
      started = get(build_conn(), "/auth/google")

      for bad <- [["x"], %{"a" => "b"}] do
        conn =
          get(recycle(started), "/auth/google/callback", %{"code" => "c", "state" => bad})

        assert response(conn, 403) =~ "Sign-in session mismatch"
      end

      refute_received :google_called
    end

    test "code that isn't text: the mismatch page, Google never asked" do
      google_says(%{"access_token" => "at"}, %{"sub" => "x"})

      for bad <- [["x"], %{"a" => "b"}] do
        assert response(sign_in_returning(%{"code" => bad}), 403) =~ "Sign-in session mismatch"
      end

      refute_received :google_called
    end

    test "an access token that isn't text: the failed page, not a crash" do
      for bad <- [123, %{"a" => 1}, ["x"], nil] do
        google_says(%{"access_token" => bad}, %{"sub" => "cr-sub-new"})
        assert response(sign_in_returning(%{"code" => "c"}), 502) =~ "sign-in failed"
      end
    end

    test "a Google profile with no sub, a sub that isn't text, or not a map: failed, no account" do
      for info <- [%{"given_name" => "Nobody"}, %{"sub" => 42}, %{"sub" => ["x"]}, ["x"], "oops"] do
        google_says(%{"access_token" => "at"}, info)
        assert response(sign_in_returning(%{"code" => "c"}), 502) =~ "sign-in failed"
      end

      refute Hoodride.Repo.exists?(from(u in Accounts.User, where: u.name == "Nobody"))
    end
  end

  describe "someone signed in whose sign-in fails goes back to the app" do
    test "a refresh: state that isn't text → 'Couldn't refresh', still signed in", %{g: g} do
      conn = build_conn() |> signed_in(g) |> get("/auth/google?refresh=silent")
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => ["x"]})
      assert redirected_to(conn, 302) == "/?refresh=failed"
      assert json_response(get(recycle(conn), "/api/me"), 200)["user"]["id"] == g.id
    end

    test "a refresh: a wrong state (two tabs refreshing at once) → 'Couldn't refresh'", %{g: g} do
      conn = build_conn() |> signed_in(g) |> get("/auth/google?refresh=silent")
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => "other-tab"})
      assert redirected_to(conn, 302) == "/?refresh=failed"
    end

    test "a refresh: Google down → 'Couldn't refresh', not the bare 502 page", %{g: g} do
      Req.Test.stub(HoodrideWeb.Google, &(&1 |> Plug.Conn.put_status(503) |> Req.Test.json(%{})))
      conn = build_conn() |> signed_in(g) |> get("/auth/google?refresh=silent")
      state = state_of(conn)
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => state})
      assert redirected_to(conn, 302) == "/?refresh=failed"
      assert json_response(get(recycle(conn), "/api/me"), 200)["user"]["id"] == g.id
    end

    test "a refresh: a refused code still COUNTS (site-wide, watched)", %{g: g} do
      Application.put_env(:hoodride, :sign_in_failures,
        alert: 3,
        alert_window_ms: 180_000,
        backoff_ms: 1_000,
        backoff_max_ms: 32_000
      )

      on_exit(fn -> Application.put_env(:hoodride, :sign_in_failures, nil) end)

      Req.Test.stub(
        HoodrideWeb.Google,
        &(&1 |> Plug.Conn.put_status(400) |> Req.Test.json(%{"error" => "invalid_grant"}))
      )

      for _ <- 1..2 do
        conn = build_conn() |> signed_in(g) |> get("/auth/google?refresh=1")
        state = state_of(conn)

        conn =
          get(recycle(conn), "/auth/google/callback", %{"code" => "made-up", "state" => state})

        assert redirected_to(conn, 302) == "/?refresh=failed"
      end

      assert Hoodride.SignInFailures.count() == 2, "the refused codes were counted"
    end

    test "an ORDINARY sign-in by someone already signed in fails: back to the app, no note", %{
      g: g
    } do
      Req.Test.stub(HoodrideWeb.Google, &(&1 |> Plug.Conn.put_status(503) |> Req.Test.json(%{})))
      conn = build_conn() |> signed_in(g) |> get("/auth/google")
      state = state_of(conn)
      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => state})
      assert redirected_to(conn, 302) == "/"
    end

    test "the database failing when a refresh starts → back to the app, 'Couldn't refresh'", %{
      g: g
    } do
      Application.put_env(:hoodride, :user_lookup, fn _ ->
        raise DBConnection.ConnectionError, "connection not available"
      end)

      conn = build_conn() |> signed_in(g) |> get("/auth/google?refresh=silent")
      assert redirected_to(conn, 302) == "/?refresh=failed"
    end
  end

  describe "joining user:<id>" do
    setup %{g: g} do
      {:ok, socket} =
        Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{session: Hoodride.TestHelpers.session_for(g.id)}
        )

      %{socket: socket}
    end

    test "anything but the exact id is refused cleanly — never a crash", %{socket: s, g: g} do
      for topic <- [
            "user:abc",
            "user:",
            "user:1_000",
            "user:0#{g.id}",
            "user:+#{g.id}",
            "user:#{g.id} ",
            "user:#{g.id}.0"
          ] do
        assert subscribe_and_join(s, topic, %{}) == {:error, %{reason: "not_yours"}},
               "#{inspect(topic)} must be refused as not yours"
      end
    end

    test "the exact id still joins", %{socket: s, g: g} do
      assert {:ok, _, _} = subscribe_and_join(s, "user:#{g.id}", %{})
    end
  end

  describe "dev login" do
    defp dev(params), do: post(%{build_conn() | host: "localhost"}, "/api/dev_login", params)

    test "a name or photo that isn't text, a blank or huge name: 400, no account" do
      for params <- [
            %{"name" => 5},
            %{"name" => %{"a" => 1}},
            %{"name" => ""},
            %{"name" => "   "},
            %{"name" => String.duplicate("x", 61)},
            %{"name" => "Ok", "photo" => 5},
            %{"name" => "Ok", "photo" => String.duplicate("x", 2001)}
          ] do
        assert json_response(dev(params), 400) == %{"error" => "invalid"},
               "#{inspect(params, limit: 3)} must be refused"
      end

      refute Hoodride.Repo.exists?(from(u in Accounts.User, where: u.provider == "dev"))
    end

    test "no name: the default; a normal name and photo: signed in" do
      assert json_response(dev(%{}), 200) == %{"ok" => true}

      assert json_response(dev(%{"name" => "Bot", "photo" => "data:image/svg+xml,x"}), 200) ==
               %{"ok" => true}
    end

    test "the database failing after the save: 503, not a crash" do
      Application.put_env(:hoodride, :user_lookup, fn _ ->
        raise DBConnection.ConnectionError, "connection not available"
      end)

      assert json_response(dev(%{"name" => "DbDown"}), 503) == %{"error" => "unavailable"}
    end
  end
end
