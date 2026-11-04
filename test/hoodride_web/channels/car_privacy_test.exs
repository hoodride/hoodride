defmodule HoodrideWeb.CarPrivacyTest do
  @moduledoc """
  Cars travel like hands: on the browse map a car is its SPOT (the res-9
  hex its app chose), never an exact position, and never a name or photo —
  those come only from `reveal`, for a viewer whose screen holds the car.
  Exact positions travel only inside a ride (the ride channel).

  And a car is announced only when its spot changes: a parked car's
  heartbeat refreshes its timestamp and says nothing to anyone.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest, only: [connect: 3, subscribe_and_join: 3]
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Geo, TestClient}
  import TestClient, only: [frames: 1, events: 1, request: 4]

  @cell "882a1072c7fffff"
  @cell2 "882a1072cffffff"
  @spot "892a1072c63ffff"
  @spot2 "892a1072c67ffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: key,
        name: key,
        photo: "https://example.test/#{key}.png"
      })

    u
  end

  defp sync(client, payload), do: request(client, "world", "sync", payload)

  # the driver's own app sending on its own user channel. driver_update
  # answers only a refusal, so a barrier request (answered in order) marks
  # "processed"; a refusal, if any, arrived before the barrier's reply.
  defp drive(%TestClient{name: name, pid: pid} = driver, payload) do
    topic = "user:#{driver.user.id}"
    send(pid, {:push, self(), topic, "driver_update", payload})

    ref =
      receive do
        {^name, :pushed, ref} -> ref
      after
        1_000 -> flunk("driver_update not pushed")
      end

    _ = request(driver, topic, "__barrier__", %{})

    receive do
      {^name, :got, %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: reply}} ->
        {status, reply}
    after
      0 -> :noreply
    end
  end

  defp car_frames(frames),
    do: Enum.filter(frames, fn {e, _} -> e in ~w(driver_update driver_left) end)

  describe "what a rider receives about a car" do
    test "a live update is {id, cell, spot} — no position, no name, no photo" do
      rider = TestClient.start(:rider, user("cp-r"))
      driver = TestClient.start(:driver, user("cp-d"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, %{"cell" => @cell, "spot" => @spot, "lat" => 40.7, "lng" => -74.0})

      assert [{"driver_update", payload}] = car_frames(frames(rider))
      assert payload == %{id: driver.user.id, cell: @cell, spot: @spot}
    end

    test "a snapshot lists cars as {id, cell, spot} only" do
      driver = TestClient.start(:driver, user("cp-d"))
      drive(driver, %{"cell" => @cell, "spot" => @spot, "lat" => 40.7, "lng" => -74.0})

      rider = TestClient.start(:rider, user("cp-r"))
      assert {:ok, %{geo: [%{drivers: [car]}]}} = sync(rider, %{"geo" => [@cell]})
      assert car == %{id: driver.user.id, cell: @cell, spot: @spot}
    end

    test "the server keeps no exact position for a browsing car" do
      driver = TestClient.start(:driver, user("cp-d"))
      drive(driver, %{"cell" => @cell, "spot" => @spot, "lat" => 40.7123, "lng" => -74.0061})

      assert [row] = :ets.lookup(:geo_drivers, driver.user.id)
      flat = row |> Tuple.to_list() |> inspect()
      refute flat =~ "40.7123"
      refute flat =~ "-74.0061"
      refute flat =~ "cp-d"
    end

    test "no spot (an older app) → the car is shown at its cell" do
      rider = TestClient.start(:rider, user("cp-r"))
      driver = TestClient.start(:driver, user("cp-d"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, %{"cell" => @cell, "lat" => 40.7, "lng" => -74.0})

      assert [{"driver_update", %{spot: @cell}}] = car_frames(frames(rider))
    end

    test "a malformed spot is refused, never stored" do
      driver = TestClient.start(:driver, user("cp-d"))

      assert {:error, %{reason: "bad_request"}} =
               drive(driver, %{"cell" => @cell, "spot" => 123})

      refute Geo.driver_on_map?(driver.user.id)
    end
  end

  describe "a car is announced only when its spot changes" do
    setup do
      rider = TestClient.start(:rider, user("cp-r"))
      driver = TestClient.start(:driver, user("cp-d"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell, @cell2]})
      drive(driver, %{"cell" => @cell, "spot" => @spot})
      assert [{"driver_update", _}] = car_frames(frames(rider))
      %{rider: rider, driver: driver}
    end

    test "a heartbeat in the same spot says nothing — but keeps the car alive",
         %{rider: rider, driver: driver} do
      [{_, _, _, ts_before}] = :ets.lookup(:geo_drivers, driver.user.id)
      :ets.update_element(:geo_drivers, driver.user.id, {4, ts_before - 100})

      drive(driver, %{"cell" => @cell, "spot" => @spot})
      drive(driver, %{"cell" => @cell, "spot" => @spot})

      assert car_frames(frames(rider)) == []
      [{_, _, _, ts_after}] = :ets.lookup(:geo_drivers, driver.user.id)
      assert ts_after >= ts_before
    end

    test "a new spot in the same cell is one update", %{rider: rider, driver: driver} do
      drive(driver, %{"cell" => @cell, "spot" => @spot2})

      assert [{"driver_update", %{spot: @spot2, cell: @cell}}] = car_frames(frames(rider))
    end

    @tag :per_message
    test "a new cell: left in the old one, then the update in the new one",
         %{rider: rider, driver: driver} do
      drive(driver, %{"cell" => @cell2, "spot" => "892a1072cc3ffff"})

      id = driver.user.id

      assert [{"driver_left", %{id: ^id}}, {"driver_update", %{cell: @cell2}}] =
               car_frames(frames(rider))
    end
  end

  describe "reveal: who is behind a car" do
    setup do
      driver = TestClient.start(:driver, user("cp-d"))
      drive(driver, %{"cell" => @cell, "spot" => @spot})
      %{driver: driver}
    end

    test "a rider whose screen holds the car gets the name and photo", %{driver: driver} do
      rider = TestClient.start(:rider, user("cp-r"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      assert {:ok, %{id: id, name: "cp-d", photo: "https://example.test/cp-d.png"}} =
               request(rider, "world", "reveal", %{"id" => driver.user.id})

      assert id == driver.user.id
    end

    # overload (Hoodride.Accounts.profile/1): the database can't answer →
    # "busy" with when to ask again (not "unavailable": that reads as gone),
    # and the SAME map channel answers again once it can
    test "the database unable to answer: busy, never a crashed map channel", %{
      driver: driver
    } do
      rider = TestClient.start(:rider, user("cp-r"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      Application.put_env(:hoodride, :user_lookup, fn _ ->
        raise DBConnection.ConnectionError, "connection not available"
      end)

      try do
        assert {:error, %{reason: "busy", retry_ms: _}} =
                 request(rider, "world", "reveal", %{"id" => driver.user.id})
      after
        Application.delete_env(:hoodride, :user_lookup)
      end

      assert {:ok, %{name: "cp-d"}} = request(rider, "world", "reveal", %{"id" => driver.user.id})
    end

    test "a rider looking elsewhere gets the same refusal as a stranger", %{driver: driver} do
      rider = TestClient.start(:rider, user("cp-r"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell2]})

      assert {:error, %{reason: "unavailable"}} =
               request(rider, "world", "reveal", %{"id" => driver.user.id})
    end

    test "a driver can't reveal another car (drivers never see cars)", %{driver: driver} do
      other = TestClient.start(:other, user("cp-o"))
      drive(other, %{"cell" => @cell2, "spot" => "892a1072cc3ffff"})
      assert {:ok, _} = sync(other, %{"geo" => [@cell]})

      assert {:error, %{reason: "unavailable"}} =
               request(other, "world", "reveal", %{"id" => driver.user.id})
    end

    test "a car that left can't be revealed", %{driver: driver} do
      rider = TestClient.start(:rider, user("cp-r"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      Geo.driver_offline(driver.user.id)

      assert {:error, %{reason: "unavailable"}} =
               request(rider, "world", "reveal", %{"id" => driver.user.id})
    end
  end

  @tag :per_message
  test "a hand moved to another cell leaves the old one (no ghost ✋)" do
    watcher = TestClient.start(:watcher, user("cp-w"))
    Geo.driver_update(%{id: watcher.user.id, name: "w", photo: nil}, "far-away", nil)
    assert {:ok, _} = sync(watcher, %{"geo" => [@cell]})

    Geo.hand_up(800_001, @cell, @spot)
    Geo.hand_up(800_001, @cell2, "892a1072cc3ffff")

    assert ["hand_update", "hand_left"] =
             watcher |> frames() |> events() |> Enum.filter(&String.starts_with?(&1, "hand"))
  end

  test "the map channel's join reply carries the protocol version" do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "cp-v", name: "v"})

    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
      )

    assert {:ok, %{v: v}, _} = subscribe_and_join(socket, "world", %{})
    assert v == HoodrideWeb.WorldChannel.protocol()
  end
end
