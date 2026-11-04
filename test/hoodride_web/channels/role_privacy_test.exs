defmodule HoodrideWeb.RolePrivacyTest do
  @moduledoc """
  The server sends each client ONLY what its server-derived role may see.
  Hiding it in the app is not privacy: anything on the wire can be read.

    viewer (rider)          → cars + car counts
    online driver (car on)  → raised hands + hand counts
    in a ride (any seat)    → nothing from the map

  Role precedence: in a ride > car on the map > viewer. Every assertion
  here is on what ARRIVED at the client (TestClient relays each client's
  pushes from its own process), never on what the app would draw.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest, only: [connect: 3, join: 3]
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Geo, Rides, TestClient}
  import TestClient, only: [frames: 1, events: 1, request: 4]

  @cell "8f2830828052d25"
  @far "8f2830828052fff"
  @agg "872830828ffffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  # another driver on the map (no app of its own in this test)
  defp car(id, cell, parents \\ []),
    do: Geo.driver_update(%{id: id, name: "Car#{id}", photo: nil}, cell, nil, parents)

  defp profile(u), do: %{id: u.id, name: u.name, photo: u.photo}

  # put `client`'s own car on the map (makes them an online driver)
  defp go_online(client, cell \\ "home"),
    do: Geo.driver_update(profile(client.user), cell, nil)

  defp sync(client, payload), do: request(client, "world", "sync", payload)

  defp map_events(frames) do
    frames
    |> events()
    |> Enum.filter(&(&1 in ~w(driver_update driver_left hand_update hand_left agg_update)))
  end

  describe "a rider (viewer)" do
    test "live: cars only — never a hand frame" do
      rider = TestClient.start(:rider, user("pv-r"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      car(700_001, @cell)
      Geo.hand_up(700_002, @cell, "spot9")
      Geo.hand_down(700_002)

      got = events(frames(rider))
      assert "driver_update" in got
      refute "hand_update" in got
      refute "hand_left" in got
    end

    test "snapshot: cars only — the hands key is not even present" do
      car(700_001, @cell)
      Geo.hand_up(700_002, @cell, "spot9")

      rider = TestClient.start(:rider, user("pv-r"))
      assert {:ok, %{geo: [snap]}} = sync(rider, %{"geo" => [@cell]})
      assert [%{id: 700_001}] = snap.drivers
      refute Map.has_key?(snap, :hands)
    end

    test "counts: the car side only, in the snapshot and live" do
      car(700_001, @cell, [@agg])
      Geo.hand_up(700_002, @cell, "spot9", [@agg])

      rider = TestClient.start(:rider, user("pv-r"))
      assert {:ok, %{agg: [counts]}} = sync(rider, %{"agg" => [@agg]})
      assert counts.drivers == 1
      refute Map.has_key?(counts, :hands)

      car(700_003, @cell, [@agg])
      assert [{"agg_update", live}] = frames(rider)
      assert live.drivers == 2
      refute Map.has_key?(live, :hands)
    end

    test "a hand raised in a watched hex sends a rider NOTHING (not even an unchanged car count)" do
      car(700_001, @cell, [@agg])
      rider = TestClient.start(:rider, user("pv-r"))
      assert {:ok, _} = sync(rider, %{"agg" => [@agg]})

      Geo.hand_up(700_002, @cell, "spot9", [@agg])
      Geo.hand_down(700_002)
      assert frames(rider) == []
    end
  end

  describe "an online driver" do
    test "live: hands only — never another driver's car" do
      driver = TestClient.start(:driver, user("pv-d"))
      go_online(driver)
      assert {:ok, _} = sync(driver, %{"geo" => [@cell]})

      car(700_001, @cell)
      Geo.driver_offline(700_001)
      Geo.hand_up(700_002, @cell, "spot9")

      got = events(frames(driver))
      assert "hand_update" in got
      refute "driver_update" in got
      refute "driver_left" in got
    end

    test "snapshot: hands only — the drivers key is not even present" do
      car(700_001, @cell)
      Geo.hand_up(700_002, @cell, "spot9")

      driver = TestClient.start(:driver, user("pv-d"))
      go_online(driver)
      assert {:ok, %{geo: [snap]}} = sync(driver, %{"geo" => [@cell]})
      assert [%{id: 700_002}] = snap.hands
      refute Map.has_key?(snap, :drivers)
    end

    test "counts: the hand side only; a car arriving sends nothing" do
      car(700_001, @cell, [@agg])
      Geo.hand_up(700_002, @cell, "spot9", [@agg])

      driver = TestClient.start(:driver, user("pv-d"))
      go_online(driver)
      assert {:ok, %{agg: [counts]}} = sync(driver, %{"agg" => [@agg]})
      assert counts.hands == 1
      refute Map.has_key?(counts, :drivers)
      # going online after joining was announced (viewer → driver)
      assert frames(driver) == [{"role", %{role: "driver"}}]

      car(700_003, @cell, [@agg])
      assert frames(driver) == []

      Geo.hand_up(700_004, @cell, "spot9", [@agg])
      assert [{"agg_update", live}] = frames(driver)
      assert live.hands == 2
      refute Map.has_key?(live, :drivers)
    end
  end

  describe "mid-ride" do
    test "nothing from the map at all — no snapshot content, no live frames" do
      rider_user = user("pv-r")
      driver_user = user("pv-d")
      car(700_001, @cell, [@agg])
      Geo.hand_up(700_002, @cell, "spot9", [@agg])

      rider = TestClient.start(:rider, rider_user)
      {:ok, _ride} = Rides.start_ride(rider_user.id, driver_user.id)

      assert {:ok, %{geo: geo, agg: agg}} = sync(rider, %{"geo" => [@cell], "agg" => [@agg]})

      for snap <- geo do
        refute Map.has_key?(snap, :drivers)
        refute Map.has_key?(snap, :hands)
      end

      for counts <- agg do
        refute Map.has_key?(counts, :drivers)
        refute Map.has_key?(counts, :hands)
      end

      car(700_003, @cell, [@agg])
      Geo.hand_up(700_004, @cell, "spot9", [@agg])
      assert map_events(frames(rider)) == []
    end
  end

  describe "role switches" do
    test "the join reply carries the server's role" do
      u = user("pv-r")
      assert {:ok, %{role: "viewer"}} = join_reply(u)

      Geo.driver_update(profile(u), "home", nil)
      assert {:ok, %{role: "driver"}} = join_reply(u)
    end

    test "rider → online driver: told at once, cars stop, a resync brings the hands" do
      rider = TestClient.start(:rider, user("pv-r"))
      Geo.hand_up(700_002, @cell, "spot9")
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      go_online(rider)
      assert {"role", %{role: "driver"}} in frames(rider)

      car(700_001, @cell)
      refute "driver_update" in events(frames(rider))

      # the same wish again: the hand topic is NEW for this role → snapshot
      assert {:ok, %{geo: [snap]}} = sync(rider, %{"geo" => [@cell]})
      assert [%{id: 700_002}] = snap.hands
    end

    test "online driver → offline: told at once, hands stop" do
      driver = TestClient.start(:driver, user("pv-d"))
      go_online(driver)
      assert {:ok, _} = sync(driver, %{"geo" => [@cell]})

      Geo.driver_offline(driver.user.id)
      assert {"role", %{role: "viewer"}} in frames(driver)

      Geo.hand_up(700_002, @cell, "spot9")
      refute "hand_update" in events(frames(driver))
    end

    test "a ride start: told at once, then nothing" do
      rider_user = user("pv-r")
      rider = TestClient.start(:rider, rider_user)
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      {:ok, _ride} = Rides.start_ride(rider_user.id, user("pv-d").id)
      assert {"role", %{role: "in_ride"}} in frames(rider)

      car(700_001, @cell)
      assert map_events(frames(rider)) == []
    end

    test "a ride END: told at once, and the same wish brings the map back" do
      rider_user = user("pv-r")
      rider = TestClient.start(:rider, rider_user)
      car(700_001, @cell)
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      {:ok, ride_id} = Rides.start_ride(rider_user.id, user("pv-d").id)
      assert {"role", %{role: "in_ride"}} in frames(rider)

      :ok = Rides.end_ride(ride_id, rider_user.id)
      assert {"role", %{role: "viewer"}} in frames(rider)

      # the app resyncs on the role push: the car layer comes back
      assert {:ok, %{geo: [%{drivers: [%{id: 700_001}]}]}} = sync(rider, %{"geo" => [@cell]})
    end

    test "a killed ride's seats reclaimed by the sweeper: told at once" do
      rider_user = user("pv-r")
      rider = TestClient.start(:rider, rider_user)
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      {:ok, ride_id} = Rides.start_ride(rider_user.id, user("pv-d").id)
      assert {"role", %{role: "in_ride"}} in frames(rider)

      [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
      ref = Process.monitor(pid)
      Process.exit(pid, :kill)
      assert_receive {:DOWN, ^ref, :process, ^pid, :killed}
      # a brutal kill runs no terminate: still "in a ride" until the sweep
      assert Hoodride.Roles.of(rider_user.id) == :in_ride

      Hoodride.Sweeper.heal_orphan_ride_slots()
      assert {"role", %{role: "viewer"}} in frames(rider)
    end

    test "a ride that fails to start leaves nobody stuck in_ride" do
      # Ride.init crashes (the partner doesn't exist), so start_ride takes its
      # error path: the claimed seats are freed again
      rider_user = user("pv-r")
      rider = TestClient.start(:rider, rider_user)
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, _} = Rides.start_ride(rider_user.id, 9_999_999_999)
      end)

      assert Hoodride.Roles.of(rider_user.id) == :viewer
      # whatever the channel saw in between, it ends as a viewer…
      roles = for {"role", %{role: r}} <- frames(rider), do: r
      assert roles == [] or List.last(roles) == "viewer"
      # …and a car in the watched hex reaches it again after the app's resync
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      car(700_001, @cell)
      assert "driver_update" in events(frames(rider))
    end

    test "NO SUBSCRIPTION LEAK: after every switch, PubSub delivers exactly what the channel holds" do
      # a forgotten unsubscribe is invisible from the app (the live check
      # drops the old layer's messages) — only PubSub's own record shows it
      u = user("pv-r")
      c = TestClient.start(:rider, u)
      wish = %{"geo" => [@cell, @far], "agg" => [@agg]}
      check = fn -> _ = frames(c) && TestClient.assert_subscriptions_match(c) end

      assert {:ok, _} = sync(c, wish)
      check.()

      # viewer → driver → viewer → in a ride → viewer, resyncing as the app does
      go_online(c)
      check.()
      assert {:ok, _} = sync(c, wish)
      check.()

      Geo.driver_offline(u.id)
      check.()
      assert {:ok, _} = sync(c, wish)
      check.()

      {:ok, ride} = Rides.start_ride(u.id, user("pv-d").id)
      check.()
      assert {:ok, _} = sync(c, wish)
      check.()

      :ok = Rides.end_ride(ride, u.id)
      check.()
      assert {:ok, _} = sync(c, wish)
      check.()

      # and cells leaving the wish
      assert {:ok, _} = sync(c, %{"geo" => [@cell]})
      check.()
      assert {:ok, _} = sync(c, %{})
      check.()
    end

    test "THE MAILBOX RACE: a car broadcast queued before the switch is still dropped" do
      rider = TestClient.start(:rider, user("pv-r"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      # freeze the channel so both messages queue up behind each other: the
      # car broadcast FIRST, then (after the role is already in ETS) the ping
      world = TestClient.channel_pid(rider)
      :sys.suspend(world)
      car(700_001, @cell)
      go_online(rider)
      :sys.resume(world)

      refute "driver_update" in events(frames(rider))
    end
  end

  describe "reveal (tap a ✋ to see who it is)" do
    test "an online driver watching that hand's hex gets the name and photo" do
      hand_user = user("pv-hand")
      Geo.hand_up(hand_user.id, @cell, "spot9")

      driver = TestClient.start(:driver, user("pv-d"))
      go_online(driver)
      assert {:ok, _} = sync(driver, %{"geo" => [@cell]})

      assert {:ok, %{id: id, name: "pv-hand"}} =
               request(driver, "world", "reveal", %{"id" => hand_user.id})

      assert id == hand_user.id
    end

    test "every other case is the SAME refusal (no oracle)" do
      hand_user = user("pv-hand")
      Geo.hand_up(hand_user.id, @far, "spot9")
      lowered = user("pv-lowered")

      driver = TestClient.start(:driver, user("pv-d"))
      go_online(driver)
      assert {:ok, _} = sync(driver, %{"geo" => [@cell]})

      viewer = TestClient.start(:viewer, user("pv-v"))
      assert {:ok, _} = sync(viewer, %{"geo" => [@far]})

      refusals = [
        # a hand in a hex the driver isn't watching
        request(driver, "world", "reveal", %{"id" => hand_user.id}),
        # no hand up
        request(driver, "world", "reveal", %{"id" => lowered.id}),
        # no such user
        request(driver, "world", "reveal", %{"id" => 9_999_999_999}),
        # garbage
        request(driver, "world", "reveal", %{"id" => "abc"}),
        # a viewer, even watching the hand's hex
        request(viewer, "world", "reveal", %{"id" => hand_user.id})
      ]

      assert Enum.uniq(refusals) == [{:error, %{reason: "unavailable"}}]
    end

    test "a stale channel state can't reveal: the LIVE role decides" do
      # the channel still holds the hand topic (a role change not processed
      # yet); in ETS the user is a plain viewer
      hand_user = user("pv-hand")
      Geo.hand_up(hand_user.id, @cell, "spot9")
      viewer = TestClient.start(:viewer, user("pv-v"))
      world = TestClient.channel_pid(viewer)

      :sys.replace_state(world, fn st ->
        put_in(st.assigns.held, MapSet.new([Geo.geo_topic(:hands, @cell)]))
      end)

      assert {:error, %{reason: "unavailable"}} =
               request(viewer, "world", "reveal", %{"id" => hand_user.id})
    end

    test "mid-ride, nobody can be revealed" do
      hand_user = user("pv-hand")
      Geo.hand_up(hand_user.id, @cell, "spot9")
      driver_user = user("pv-d")

      driver = TestClient.start(:driver, driver_user)
      go_online(driver)
      assert {:ok, _} = sync(driver, %{"geo" => [@cell]})
      {:ok, _} = Rides.start_ride(user("pv-r").id, driver_user.id)

      assert {:error, %{reason: "unavailable"}} =
               request(driver, "world", "reveal", %{"id" => hand_user.id})
    end
  end

  describe "one map channel per account (newest wins, like the user channel)" do
    test "a second world join closes the first" do
      u = user("pv-r")
      _first = TestClient.start(:first, u, ["world"])
      _second = TestClient.start(:second, u, ["world"])

      # a clean server-side close (the real socket sends the app phx_close,
      # and Phoenix does not auto-rejoin after it)
      assert_receive {:first, :got, {:socket_close, _, :normal}},
                     1_000
    end
  end

  # the reply a fresh world join gets (a throwaway socket of the same user)
  defp join_reply(u) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
      )

    case join(socket, "world", %{}) do
      {:ok, reply, chan} ->
        Process.unlink(chan.channel_pid)
        {:ok, reply}

      other ->
        other
    end
  end
end
