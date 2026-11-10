defmodule HoodrideWeb.RideFlowTest do
  @moduledoc "End-to-end walk of the whole protocol: two users, one ride."
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  @cell "8f2830828052d25"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: "rider-t",
        name: "RiderT"
      })

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: "driver-t",
        name: "DriverT"
      })

    %{rider: rider, driver: driver}
  end

  defp connect_as(user) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    socket
  end

  # the rider's map watching `cell` (cold requests must be on screen)
  defp watch(socket, cell) do
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    ref = push(world, "sync", %{"geo" => [cell]})
    assert_reply ref, :ok
    world
  end

  test "socket refuses strangers" do
    assert :error =
             connect(HoodrideWeb.UserSocket, %{}, connect_info: %{session: %{}})
  end

  test "socket token auth: valid token connects, garbage doesn't", %{rider: rider} do
    token = Hoodride.TestHelpers.socket_token_for(rider.id)
    assert {:ok, socket} = connect(HoodrideWeb.UserSocket, %{"token" => token})
    assert socket.assigns.user_id == rider.id

    assert :error = connect(HoodrideWeb.UserSocket, %{"token" => "garbage"})

    # a valid token for a since-deleted user is also refused
    ghost =
      Phoenix.Token.sign(HoodrideWeb.Endpoint, "user socket", %{
        u: 999_999,
        iat: System.system_time(:millisecond)
      })

    assert :error = connect(HoodrideWeb.UserSocket, %{"token" => ghost})
  end

  test "user channel refuses other people's topics", %{rider: rider, driver: driver} do
    socket = connect_as(rider)
    assert {:error, %{reason: "not_yours"}} = subscribe_and_join(socket, "user:#{driver.id}", %{})
  end

  @tag :per_message
  test "full flow: geo → chat → request → accept → ride → pin → pos → end", %{
    rider: rider,
    driver: driver
  } do
    rsock = connect_as(rider)
    dsock = connect_as(driver)

    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(dsock, "user:#{driver.id}", %{})

    # rider watches a cell via the world multiplexer; driver goes online in
    # it → the world channel forwards the car's appearance to the rider
    {:ok, _, world} = subscribe_and_join(rsock, "world", %{})
    ref = push(world, "sync", %{"geo" => [@cell]})
    assert_reply ref, :ok, %{geo: [%{cell: @cell, drivers: []}]}

    # a browsing car is its spot only: no position, no name (reveal on tap)
    push(dchan, "driver_update", %{"cell" => @cell, "spot" => "spot9car"})
    assert_push "driver_update", car
    assert car == %{id: driver.id, cell: @cell, spot: "spot9car"}

    # rider raises a hand — cells only (coarse topic + finer display spot),
    # no exact point anywhere. A rider's map carries cars only, so their
    # own hand never comes back to them (drivers' maps carry hands)
    push(rchan, "hand_up", %{"cell" => @cell, "spot" => "spot9abc"})
    # (a replying event as a barrier: hand_up itself sends no reply)
    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :ok
    assert [{_, @cell, "spot9abc"}] = :ets.lookup(:geo_hands, rider.id)
    refute_push "hand_update", %{}

    # chat: routed through the recipient's user channel
    ref = push(rchan, "send_msg", %{"to" => driver.id, "text" => "yo, can you grab me?"})
    assert_reply ref, :ok, %{id: _}
    assert_push "msg", %{text: "yo, can you grab me?", from: %{name: "RiderT"}}

    # request: rider creates…
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok
    assert_push "request", %{from: %{name: "RiderT"}}

    # …only one open request per rider…
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :error, %{reason: "already_requested"}

    # …driver answers → ride is born, both notified
    ref = push(dchan, "accept_request", %{"rider_id" => rider.id})
    assert_reply ref, :ok
    assert_push "ride_started", %{ride_id: ride_id, role: _}
    assert_push "ride_started", %{ride_id: ^ride_id}

    # accepting cleared the demand and took the driver off the browse map.
    # The rider's own map is told it's mid-ride and goes silent: no
    # driver_left, nothing at all from the map
    assert_push "role", %{role: "in_ride"}
    refute_push "driver_left", %{}
    refute Hoodride.Geo.driver_on_map?(driver.id)
    assert :ets.lookup(:geo_hands, rider.id) == []

    # ride channel: two-party, position relay, pin, arrival, end
    {:ok, ride_state, ridechan_r} = subscribe_and_join(rsock, "ride:#{ride_id}", %{})
    assert ride_state.pin == nil
    assert ride_state.arrived == false
    {:ok, _, ridechan_d} = subscribe_and_join(dsock, "ride:#{ride_id}", %{})

    push(ridechan_d, "pos", %{"lat" => 3.0, "lng" => 4.0})
    assert_broadcast "peer_pos", %{lat: 3.0, lng: 4.0}

    push(ridechan_r, "set_pin", %{"lat" => 5.0, "lng" => 6.0})
    assert_broadcast "pin", %{pin: %{lat: 5.0, lng: 6.0}}

    # only the rider may pin
    _ref = push(ridechan_d, "set_pin", %{"lat" => 9.0, "lng" => 9.0})
    refute_broadcast "pin", %{pin: %{lat: 9.0}}

    # ...and only the rider may UN-pin: tap-to-clear reverts the target
    push(ridechan_d, "clear_pin", %{})
    refute_broadcast "pin", %{pin: nil}
    push(ridechan_r, "clear_pin", %{})
    assert_broadcast "pin", %{pin: nil}

    # arrival: rider refused, driver announces to both
    ref = push(ridechan_r, "arrived", %{})
    assert_reply ref, :error, %{reason: "not_driver"}
    ref = push(ridechan_d, "arrived", %{})
    assert_reply ref, :ok
    assert_broadcast "arrived", %{}

    push(ridechan_r, "end_ride", %{})
    assert_broadcast "ended", %{}

    # the ride is gone — death is deletion
    assert Hoodride.Rides.ride_id_of_user(rider.id) == nil
    assert Hoodride.Rides.ride_id_of_user(driver.id) == nil
    _ = ref
  end

  # accepting lowers the rider's ✋: every OTHER online driver watching
  # that block must hear it go (the ✋ and its count) — else it stays on
  # their maps, counted, and their find the nearest calls it found
  test "an accepted ride: other drivers watching hear the rider's ✋ go, and its count drop", %{
    rider: rider,
    driver: driver
  } do
    alias Phoenix.Socket.Broadcast
    rsock = connect_as(rider)
    dsock = connect_as(driver)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(dsock, "user:#{driver.id}", %{})
    # (another driver's map: the ✋ layer of this block and its count)
    HoodrideWeb.Endpoint.subscribe(Hoodride.Geo.geo_topic(:hands, @cell))
    HoodrideWeb.Endpoint.subscribe(Hoodride.Geo.agg_topic(:hands, "c7-acc"))

    push(dchan, "driver_update", %{"cell" => @cell, "spot" => "spot9car"})
    push(rchan, "hand_up", %{"cell" => @cell, "spot" => "spot9abc", "parents" => ["c7-acc"]})
    assert_receive %Broadcast{topic: "geo:h:" <> _, event: "hand_update", payload: %{id: rid}}
    assert rid == rider.id
    assert_receive %Broadcast{topic: "agg:h:c7-acc", payload: %{hands: 1}}

    _ = watch(rsock, @cell)
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok
    ref = push(dchan, "accept_request", %{"rider_id" => rider.id})
    assert_reply ref, :ok

    assert_receive %Broadcast{topic: "geo:h:" <> _, event: "hand_left", payload: %{id: ^rid}}
    assert_receive %Broadcast{topic: "agg:h:c7-acc", payload: %{hands: 0}}
  end

  test "cancel-vs-accept race: first action wins", %{rider: rider, driver: driver} do
    rsock = connect_as(rider)
    dsock = connect_as(driver)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(dsock, "user:#{driver.id}", %{})

    # requests need an on-map driver, on the rider's screen
    push(dchan, "driver_update", %{"cell" => @cell, "lat" => 1.0, "lng" => 2.0})
    # driver_update sends no reply: a replying push proves it was processed
    # (without this, a busy machine let the request land first: "unavailable")
    ref = push(dchan, "cancel_request", %{})
    assert_reply ref, :ok
    watch(rsock, @cell)
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok

    # rider cancels first
    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :ok
    assert_push "request_cancelled", %{from_id: _}

    # driver's accept now finds nothing — no ghost ride
    ref = push(dchan, "accept_request", %{"rider_id" => rider.id})
    assert_reply ref, :error, %{reason: "gone"}
    assert Hoodride.Rides.ride_id_of_user(rider.id) == nil
  end

  test "decline keeps nothing; the same driver can be asked again after a minute",
       %{rider: rider, driver: driver} do
    rsock = connect_as(rider)
    dsock = connect_as(driver)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(dsock, "user:#{driver.id}", %{})

    # requests need an on-map driver, on the rider's screen
    push(dchan, "driver_update", %{"cell" => @cell, "lat" => 1.0, "lng" => 2.0})
    # driver_update sends no reply: a replying push proves it was processed
    # (without this, a busy machine let the request land first: "unavailable")
    ref = push(dchan, "cancel_request", %{})
    assert_reply ref, :ok
    watch(rsock, @cell)
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok

    ref = push(dchan, "decline_request", %{"rider_id" => rider.id})
    assert_reply ref, :ok
    assert_push "request_declined", %{}

    # request is gone, but "no" sticks: the same driver is on a cooldown
    assert Hoodride.Requests.open_request_of(rider.id) == nil
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :error, %{reason: "request_cooldown", retry_ms: wait}
    assert wait > 50_000 and wait <= 60_000

    # once the minute has passed (simulated by expiring the counters), asking
    # again works
    :ets.delete_all_objects(Hoodride.RateLimit)
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok
  end
end
