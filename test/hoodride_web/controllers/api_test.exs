defmodule HoodrideWeb.ApiTest do
  use HoodrideWeb.ConnCase

  setup do
    Hoodride.TestHelpers.scrub_live_state()

    :ok
  end

  test "dev_login → me → state → logout full cycle", %{conn: conn} do
    conn = post(%{conn | host: "localhost"}, "/api/dev_login", %{"name" => "ApiTester"})
    assert json_response(conn, 200) == %{"ok" => true}

    conn = get(conn, "/api/me")
    assert %{"user" => %{"name" => "ApiTester", "provider" => "dev"}} = json_response(conn, 200)

    conn = get(conn, "/api/state")

    assert %{
             "user" => %{"name" => "ApiTester"},
             "ride" => nil,
             "open_request" => nil,
             "conversations" => [],
             "pending_requests" => [],
             "hand" => nil,
             "on_map" => false
           } = json_response(conn, 200)

    conn = post(conn, "/api/logout")
    assert json_response(conn, 200) == %{"ok" => true}

    conn = get(conn, "/api/me")
    assert json_response(conn, 200) == %{"user" => nil}
  end

  test "state rehydrates live map presence: a raised hand and an on-duty shift",
       %{conn: conn} do
    conn = post(%{conn | host: "localhost"}, "/api/dev_login", %{"name" => "MapTester"})
    %{"user" => %{"id" => uid}} = json_response(get(conn, "/api/me"), 200)

    # hand up → the reload payload carries it (cells only, never a point)
    Hoodride.Geo.hand_up(uid, "cell8rh", "spot9rh", ["c7RH"])

    assert %{"hand" => %{"cell" => "cell8rh", "spot" => "spot9rh"}, "on_map" => false} =
             json_response(get(conn, "/api/state"), 200)

    # becoming a driver flips both (exclusion drops the hand)
    Hoodride.Geo.driver_update(%{id: uid, name: "MapTester", photo: nil}, "cell8rd", nil)

    assert %{"hand" => nil, "on_map" => true} = json_response(get(conn, "/api/state"), 200)
  end

  test "socket_token: 401 without a session; a valid, verifiable token with one",
       %{conn: conn} do
    assert json_response(get(conn, "/api/socket_token"), 401)

    conn =
      post(%{conn | host: "localhost"}, "/api/dev_login", %{
        "name" => "TokTester",
        "agree_terms" => true
      })

    %{"user" => %{"id" => uid}} = json_response(get(conn, "/api/me"), 200)

    assert %{"token" => token} = json_response(get(conn, "/api/socket_token"), 200)

    assert %{id: ^uid} = HoodrideWeb.Auth.token_user(token)
  end

  test "a returning oauth user is updated in place, not duplicated" do
    {:ok, u1} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ret", name: "Old"})

    {:ok, u2} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: "ret",
        name: "New",
        photo: "p2"
      })

    assert u2.id == u1.id
    assert u2.name == "New"
    assert u2.photo == "p2"
  end

  test "dev_login is a 404 when disabled", %{conn: conn} do
    Application.put_env(:hoodride, :dev_login, false)
    on_exit(fn -> Application.put_env(:hoodride, :dev_login, true) end)

    conn = post(%{conn | host: "localhost"}, "/api/dev_login", %{"name" => "Nope"})
    assert response(conn, 404)
  end

  test "unauthenticated state and me return null user", %{conn: conn} do
    assert json_response(get(conn, "/api/me"), 200) == %{"user" => nil}
    assert json_response(get(conn, "/api/state"), 200) == %{"user" => nil}
  end

  test "there is no profile lookup by id: a logged-in user can't list everyone",
       %{conn: conn} do
    # (it answered any id for any logged-in user: loop the ids, get every
    # name and photo — OWASP API1. Names now come only from `reveal`, a
    # chat, a request or a ride.)
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "pub", name: "Pub"})

    conn = post(%{conn | host: "localhost"}, "/api/dev_login", %{"name" => "Viewer"})
    # 404, not the app page: the catch-all route serves the PWA for any
    # path, so unknown /api/ paths must be answered by the api scope itself
    resp = get(conn, "/api/users/#{u.id}")
    assert resp.status == 404
    refute resp.resp_body =~ "Pub"
  end

  test "oauth request is a friendly 503 without credentials", %{conn: conn} do
    conn = get(conn, "/auth/google")
    assert response(conn, 503) =~ "GOOGLE_CLIENT_ID"
  end

  test "oauth hardening: unknown providers, paramless callbacks, forged state", %{conn: conn} do
    # a stray provider is a 404, never a crash
    assert response(get(conn, "/auth/nope"), 404) =~ "unknown provider"

    # a callback missing its params quietly lands on the app
    assert redirected_to(get(conn, "/auth/google/callback")) == "/"

    # the anti-login-CSRF core: state not matching the session is refused
    conn = get(conn, "/auth/google/callback", %{"code" => "x", "state" => "forged"})
    assert response(conn, 403) =~ "mismatch"
  end

  test "unknown oauth provider is a 404", %{conn: conn} do
    assert response(get(conn, "/auth/myspace"), 404)
  end

  test "oauth callback without a code just goes home", %{conn: conn} do
    conn = get(conn, "/auth/google/callback")
    assert redirected_to(conn) == "/"
  end

  test "oauth callback with a forged state is refused (login-CSRF)", %{conn: conn} do
    conn = get(conn, "/auth/google/callback", %{"code" => "stolen", "state" => "forged"})
    assert response(conn, 403) =~ "mismatch"
  end

  test "state includes an active ride with role and peer", %{conn: conn} do
    # session user via dev_login, then start a ride involving them
    conn = post(%{conn | host: "localhost"}, "/api/dev_login", %{"name" => "RideStateTester"})

    %{"user" => %{"id" => my_id}} = json_response(get(conn, "/api/me"), 200)

    {:ok, other} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "o", name: "Other"})

    {:ok, _ride_id} = Hoodride.Rides.start_ride(my_id, other.id)

    conn = get(conn, "/api/state")

    assert %{
             "ride" => %{
               "role" => "rider",
               "pin" => nil,
               "arrived" => false,
               "peer" => %{"name" => "Other"}
             }
           } = json_response(conn, 200)

    # arrival survives into rehydration
    ride_id = Hoodride.Rides.ride_id_of_user(my_id)
    :ok = Hoodride.Rides.arrived(ride_id, other.id)
    conn = get(conn, "/api/state")
    assert %{"ride" => %{"arrived" => true}} = json_response(conn, 200)
  end

  test "state includes conversations with history", %{conn: conn} do
    conn = post(%{conn | host: "localhost"}, "/api/dev_login", %{"name" => "ChatStateTester"})
    %{"user" => %{"id" => my_id}} = json_response(get(conn, "/api/me"), 200)

    {:ok, other} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "c", name: "ChatPeer"})

    {:ok, _} =
      Hoodride.Chat.send_message(%{id: other.id, name: "ChatPeer", photo: nil}, my_id, "yo")

    conn = get(conn, "/api/state")

    assert %{
             "conversations" => [
               %{"peer" => %{"name" => "ChatPeer"}, "messages" => [%{"text" => "yo"}]}
             ]
           } = json_response(conn, 200)
  end

  test "the PWA is served at root", %{conn: conn} do
    conn = get(conn, "/")
    assert response(conn, 200) =~ "Hood Ride"
  end
end
