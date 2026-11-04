defmodule HoodrideWeb.FacebookLoginTest do
  @moduledoc """
  Sign in with Facebook — Google's flow, Facebook's addresses:

    * state round-trips through the session (anti login-CSRF), refused on
      mismatch before Facebook is asked anything;
    * PKCE S256 — Facebook supports it in its manual OIDC flow, but DEFAULTS
      to "plain" unless the method is sent (developers.facebook.com, OIDC
      code flow with PKCE);
    * scope `openid public_profile` — no email (nothing uses it);
    * the profile: the app-scoped id (unique to Hood Ride), the FIRST name
      (Facebook's own `first_name`, else "Neighbor");
    * the photo: Facebook's picture URLs EXPIRE ("don't store these URLs
      long-term"), so the stable picture address is stored — it redirects to
      the current photo, no permission needed for an app-scoped id;
    * the button: above Google, shown only when Facebook is configured (or
      in dev, where both buttons use the dev login).
  """
  use HoodrideWeb.ConnCase, async: false

  @graph "v25.0"

  setup do
    Application.put_env(:hoodride, :facebook_app_id, "fb-app")
    Application.put_env(:hoodride, :facebook_app_secret, "fb-secret")
    Application.put_env(:hoodride, :facebook_req, plug: {Req.Test, HoodrideWeb.Facebook})

    on_exit(fn ->
      for k <- [:facebook_app_id, :facebook_app_secret, :facebook_req],
          do: Application.delete_env(:hoodride, k)
    end)
  end

  defp start_sign_in(conn) do
    conn = get(conn, "/auth/facebook")
    location = redirected_to(conn, 302)
    %URI{query: q} = uri = URI.parse(location)
    {conn, uri, URI.decode_query(q)}
  end

  defp me(conn), do: json_response(get(conn, "/api/me"), 200)["user"]

  defp sign_in_with(conn, profile) do
    {conn, _, q} = start_sign_in(conn)
    test = self()

    Req.Test.stub(HoodrideWeb.Facebook, fn c ->
      case c.request_path do
        "/#{@graph}/oauth/access_token" ->
          send(test, {:token_request, c.query_string, read_form(c)})
          Req.Test.json(c, %{"access_token" => "fb-at", "token_type" => "bearer"})

        "/#{@graph}/me" ->
          send(test, {:me_request, c.query_string, Plug.Conn.get_req_header(c, "authorization")})
          Req.Test.json(c, profile)
      end
    end)

    conn =
      get(recycle(conn), "/auth/facebook/callback", %{"code" => "c-1", "state" => q["state"]})

    {conn, me(recycle(conn))}
  end

  defp read_form(c) do
    {:ok, body, _} = Plug.Conn.read_body(c)
    URI.decode_query(body)
  end

  describe "the redirect" do
    test "to Facebook's dialog, with state and PKCE S256 of the stored verifier — sent explicitly",
         %{conn: conn} do
      {conn, uri, q} = start_sign_in(conn)
      assert uri.host == "www.facebook.com"
      assert uri.path == "/#{@graph}/dialog/oauth"
      assert q["client_id"] == "fb-app"
      assert q["response_type"] == "code"
      assert q["state"] == get_session(conn, :oauth_state)
      assert q["code_challenge_method"] == "S256"
      verifier = get_session(conn, :oauth_verifier)

      assert q["code_challenge"] ==
               Base.url_encode64(:crypto.hash(:sha256, verifier), padding: false)

      assert q["redirect_uri"] =~ ~r{/auth/facebook/callback$}
    end

    test "asks for openid and the public profile only — no email", %{conn: conn} do
      {_conn, _, q} = start_sign_in(conn)
      assert q["scope"] == "openid public_profile"
    end

    test "not configured: a clear 503, not a broken redirect", %{conn: conn} do
      Application.delete_env(:hoodride, :facebook_app_id)
      assert response(get(conn, "/auth/facebook"), 503) =~ "FACEBOOK_APP_ID"
    end
  end

  describe "the callback" do
    test "sends the verifier and the secret, reads the profile with the token, signs in",
         %{conn: conn} do
      {conn, me} = sign_in_with(conn, %{"id" => "fb-123", "first_name" => "Mary Ann"})
      assert redirected_to(conn, 302) == "/"

      assert_received {:token_request, _qs, form}
      assert form["code"] == "c-1"
      assert form["client_secret"] == "fb-secret"
      assert is_binary(form["code_verifier"]) and byte_size(form["code_verifier"]) >= 43
      assert form["redirect_uri"] =~ ~r{/auth/facebook/callback$}

      assert_received {:me_request, qs, ["Bearer fb-at"]}
      assert URI.decode_query(qs)["fields"] == "id,first_name"

      assert me["name"] == "Mary Ann"
      assert me["provider"] == "facebook"
    end

    test "the photo is OUR copy, asked for with the user's own token (Hoodride.Avatars)", %{
      conn: conn
    } do
      dir = Path.join(System.tmp_dir!(), "hoodride-fb-av-#{System.unique_integer([:positive])}")

      old =
        {Application.get_env(:hoodride, :avatar_dir), Application.get_env(:hoodride, :avatar_req)}

      Application.put_env(:hoodride, :avatar_dir, dir)
      Application.put_env(:hoodride, :avatar_req, plug: {Req.Test, Hoodride.Avatars})

      on_exit(fn ->
        Application.put_env(:hoodride, :avatar_dir, elem(old, 0))
        Application.put_env(:hoodride, :avatar_req, elem(old, 1))
        File.rm_rf!(dir)
      end)

      test = self()

      Req.Test.stub(Hoodride.Avatars, fn c ->
        case c.host do
          "graph.facebook.com" ->
            send(
              test,
              {:picture_asked, c.request_path, Plug.Conn.get_req_header(c, "authorization")}
            )

            Req.Test.json(c, %{
              "data" => %{
                "url" => "https://scontent.xx.fbcdn.net/l.jpg",
                "is_silhouette" => false
              }
            })

          "scontent.xx.fbcdn.net" ->
            Plug.Conn.send_resp(c, 200, <<0xFF, 0xD8, 0xFF, 0xE0, "jpeg">>)
        end
      end)

      {_conn, me} = sign_in_with(conn, %{"id" => "fb-456", "first_name" => "Lee"})
      assert me["photo"] =~ ~r|\A/avatars/[A-Za-z0-9_-]{22}\.jpg\z|
      assert_received {:picture_asked, "/#{@graph}/me/picture", ["Bearer fb-at"]}
    end

    test "no photo service reachable: no photo (🙂) — sign-in still works", %{conn: conn} do
      {_conn, me} = sign_in_with(conn, %{"id" => "fb-457", "first_name" => "Lou"})
      assert me["name"] == "Lou"
      assert me["photo"] == nil
    end

    test "no first name: Neighbor — never anything else", %{conn: conn} do
      {_conn, me} = sign_in_with(conn, %{"id" => "fb-789"})
      assert me["name"] == "Neighbor"
    end

    test "the database failing while saving you: the friendly page, no session — and a retry works",
         %{conn: conn} do
      # a real failure: the users table is away (inside this test's sandbox)
      Hoodride.Repo.query!("ALTER TABLE users RENAME TO users_away")
      {conn1, _, q} = start_sign_in(conn)

      Req.Test.stub(HoodrideWeb.Facebook, fn c ->
        case c.request_path do
          "/#{@graph}/oauth/access_token" -> Req.Test.json(c, %{"access_token" => "fb-at"})
          "/#{@graph}/me" -> Req.Test.json(c, %{"id" => "fb-db", "first_name" => "Dee"})
        end
      end)

      conn1 =
        get(recycle(conn1), "/auth/facebook/callback", %{"code" => "c-1", "state" => q["state"]})

      assert conn1.status == 503
      assert conn1.resp_body =~ "sign-in failed — go back and try again"
      Hoodride.Repo.query!("ALTER TABLE users_away RENAME TO users")
      assert me(recycle(conn1)) == nil

      assert {_, %{"name" => "Dee"}} =
               sign_in_with(build_conn(), %{"id" => "fb-db", "first_name" => "Dee"})
    end

    test "a wrong state is refused before Facebook is asked anything", %{conn: conn} do
      {conn, _, _q} = start_sign_in(conn)
      test = self()

      Req.Test.stub(HoodrideWeb.Facebook, fn c ->
        send(test, :asked)
        Req.Test.json(c, %{})
      end)

      conn =
        get(recycle(conn), "/auth/facebook/callback", %{"code" => "c-1", "state" => "forged"})

      assert response(conn, 403)
      refute_received :asked
    end

    test "a Facebook account and a Google account are separate accounts", %{conn: conn} do
      {_conn, fb} = sign_in_with(conn, %{"id" => "same-1", "first_name" => "Sam"})

      {:ok, g} =
        Hoodride.Accounts.upsert_oauth_user(%{
          provider: "google",
          provider_id: "same-1",
          name: "Sam"
        })

      refute fb["id"] == g.id
    end
  end

  describe "the button" do
    test "above Google on the login screen" do
      html = File.read!("priv/static/index.html")
      {fb, _} = :binary.match(html, ~s(id="btn-facebook"))
      {g, _} = :binary.match(html, ~s(id="btn-google"))
      assert fb < g
    end

    test "the page says which sign-ins exist: Facebook only when configured", %{conn: conn} do
      Application.put_env(:hoodride, :dev_login, false)
      on_exit(fn -> Application.put_env(:hoodride, :dev_login, true) end)

      assert get(conn, "/") |> html_response(200) =~
               ~s(<meta name="hoodride-providers" content="google,facebook">)

      Application.delete_env(:hoodride, :facebook_app_id)

      assert get(build_conn(), "/") |> html_response(200) =~
               ~s(<meta name="hoodride-providers" content="google">)
    end

    # deploy day, 2026-10-28: /etc/hoodride/env has `FACEBOOK_APP_ID=` until
    # the keys come — an EMPTY value, which counted as set: a live Facebook
    # button sending people to Facebook with no app id
    test "an empty key (a blank line in the settings file) is not configured", %{conn: conn} do
      Application.put_env(:hoodride, :dev_login, false)
      on_exit(fn -> Application.put_env(:hoodride, :dev_login, true) end)

      for blank <- ["", "  "] do
        Application.put_env(:hoodride, :facebook_app_id, blank)

        assert get(build_conn(), "/") |> html_response(200) =~
                 ~s(<meta name="hoodride-providers" content="google">)

        assert get(build_conn(), "/auth/facebook").status == 503
      end

      Application.put_env(:hoodride, :google_client_id, "")
      on_exit(fn -> Application.delete_env(:hoodride, :google_client_id) end)
      assert get(conn, "/auth/google").status == 503
    end

    # the owner dropped Facebook sign-in (2026-11-02): no button anywhere —
    # the demo and this machine's dev login included — unless keys are set
    test "dev (dev login on), no Facebook keys: Google only", %{conn: conn} do
      Application.delete_env(:hoodride, :facebook_app_id)
      Application.put_env(:hoodride, :dev_login, true)

      assert get(conn, "/") |> html_response(200) =~
               ~s(<meta name="hoodride-providers" content="google">)
    end
  end
end
