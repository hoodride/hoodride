defmodule HoodrideWeb.LogoutOfflineTest do
  @moduledoc """
  Signing out takes you off the map at once (owner, 2026-10-31): the car
  offline (every rider waiting on it declined, each told) and the ✋ down —
  not left up until the sweeper's grace runs out (~5 min). And, like
  deleting the account, it's refused during a ride or while your own ride
  request waits: sign-out is for all devices, so another tab, an old app or
  a tap racing an accept would vanish on your partner (the app's button is
  only the first guard).
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Geo, Repo, Requests, Rides}

  @cell "882a1072c7fffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp me_map(u), do: %{id: u.id, name: u.name, photo: u.photo}

  defp signed_in(conn, u),
    do: init_test_session(conn, Hoodride.TestHelpers.session_for(u.id))

  defp logout(conn, u), do: post(signed_in(conn, u), "/api/logout")

  describe "off the map at once" do
    test "the ✋ comes down, and drivers watching that area are told", %{conn: conn} do
      u = user("lo-hand")
      Geo.hand_up(u.id, @cell, @cell, [])
      assert Geo.hand_of(u.id)
      HoodrideWeb.Endpoint.subscribe(Geo.geo_topic(:hands, @cell))

      assert json_response(logout(conn, u), 200) == %{"ok" => true}
      assert Geo.hand_of(u.id) == nil
      assert_receive %Phoenix.Socket.Broadcast{event: "hand_left", payload: %{id: id}}
      assert id == u.id
    end

    test "the car goes offline, and riders watching that area are told", %{conn: conn} do
      u = user("lo-car")
      Geo.driver_update(me_map(u), @cell, nil, [])
      assert Geo.driver_on_map?(u.id)
      HoodrideWeb.Endpoint.subscribe(Geo.geo_topic(:drivers, @cell))

      assert json_response(logout(conn, u), 200) == %{"ok" => true}
      refute Geo.driver_on_map?(u.id)
      assert_receive %Phoenix.Socket.Broadcast{event: "driver_left", payload: %{id: id}}
      assert id == u.id
    end

    test "a rider waiting on the car is declined, and told", %{conn: conn} do
      driver = user("lo-drv")
      rider = user("lo-rdr")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      assert :ok = Requests.create(me_map(rider), driver.id)
      HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")

      assert json_response(logout(conn, driver), 200) == %{"ok" => true}
      assert_receive %Phoenix.Socket.Broadcast{event: "request_declined", payload: %{by_id: by}}
      assert by == driver.id
      assert Requests.open_request_of(rider.id) == nil
    end

    test "off the map BEFORE the devices are disconnected", %{conn: conn} do
      u = user("lo-order")
      Geo.hand_up(u.id, @cell, @cell, [])
      HoodrideWeb.Endpoint.subscribe(Geo.geo_topic(:hands, @cell))
      HoodrideWeb.Endpoint.subscribe("user_socket:#{u.id}")

      logout(conn, u)
      assert_receive %Phoenix.Socket.Broadcast{event: event1}
      assert_receive %Phoenix.Socket.Broadcast{event: event2}
      assert [event1, event2] == ["hand_left", "disconnect"]
    end
  end

  describe "refused — nothing changes, still signed in everywhere" do
    test "during a ride: end it first", %{conn: conn} do
      driver = user("lo-ride-d")
      rider = user("lo-ride-r")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      :ok = Requests.create(me_map(rider), driver.id)
      assert {:ok, ride_id} = Requests.accept(me_map(driver), rider.id)
      HoodrideWeb.Endpoint.subscribe("user_socket:#{rider.id}")

      refused = logout(conn, rider)
      assert json_response(refused, 409) == %{"error" => "in_ride"}
      assert json_response(get(recycle(refused), "/api/me"), 200)["user"]["id"] == rider.id
      assert Accounts.get_user(rider.id).logged_out_at == nil
      refute_received %Phoenix.Socket.Broadcast{event: "disconnect"}
      assert Rides.ride_id_of_user(rider.id) == ride_id
      assert Rides.ride_id_of_user(driver.id) == ride_id
    end

    test "while a ride is just starting (a claimed seat)", %{conn: conn} do
      u = user("lo-pending")
      :ets.insert(:rides_by_user, {u.id, :pending})
      assert json_response(logout(conn, u), 409) == %{"error" => "in_ride"}
      assert Accounts.get_user(u.id).logged_out_at == nil
    end

    test "while your own ride request waits: cancel it first", %{conn: conn} do
      driver = user("lo-req-d")
      rider = user("lo-req-r")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      :ok = Requests.create(me_map(rider), driver.id)

      assert json_response(logout(conn, rider), 409) == %{"error" => "request_waiting"}
      assert Accounts.get_user(rider.id).logged_out_at == nil
      assert Requests.open_request_of(rider.id)
    end

    test "the database fails: the ✋ and the car stay where they were", %{conn: conn} do
      hand = user("lo-db-h")
      car = user("lo-db-c")
      Geo.hand_up(hand.id, @cell, @cell, [])
      Geo.driver_update(me_map(car), @cell, nil, [])

      Repo.query!("ALTER TABLE sign_outs RENAME TO sign_outs_away")

      try do
        assert json_response(logout(conn, hand), 503) == %{"error" => "failed"}
        assert json_response(logout(build_conn(), car), 503) == %{"error" => "failed"}
      after
        Repo.query!("ALTER TABLE sign_outs_away RENAME TO sign_outs")
      end

      assert Geo.hand_of(hand.id)
      assert Geo.driver_on_map?(car.id)
    end
  end
end
