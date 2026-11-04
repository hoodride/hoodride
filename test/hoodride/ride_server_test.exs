defmodule Hoodride.RideServerTest do
  @moduledoc "The GenServer-per-ride: birth effects, authority, self-cleaning death."
  use ExUnit.Case

  alias Hoodride.{Geo, Rides}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rs-r", name: "RR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rs-d", name: "RD"})

    %{rider: rider, driver: driver}
  end

  defp ride_pid(ride_id) do
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
    pid
  end

  # A ride frees its seats TWICE when it ends — in end_ride, then again in
  # terminate/2. Seats are keyed by person, so the second free used to
  # delete whatever they held: had either person already started a NEW ride
  # in between, the old ride erased the new ride's seats (its process alive,
  # the app seeing nobody in a ride). Too narrow for timing to force (a new
  # ride needs a request + accept), so the state is set up directly: ride A
  # ends after ride B has taken the seats. Found in the race audit,
  # 2026-10-29.
  test "an ending ride frees only ITS seats, never a newer ride's",
       %{rider: r, driver: d} do
    {:ok, a} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(a)
    ref = Process.monitor(pid)
    # ride B already holds both seats (as if A's first free had run and B
    # been claimed before A's process finished)
    :ets.insert(:rides_by_user, [{r.id, "rB"}, {d.id, "rB"}])
    assert Rides.end_ride(a, r.id) == :ok
    assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
    assert Rides.ride_id_of_user(r.id) == "rB"
    assert Rides.ride_id_of_user(d.id) == "rB"
  end

  test "an ending ride still frees its own seats", %{rider: r, driver: d} do
    {:ok, a} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(a)
    ref = Process.monitor(pid)
    assert Rides.end_ride(a, r.id) == :ok
    assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
    assert Rides.ride_id_of_user(r.id) == nil
    assert Rides.ride_id_of_user(d.id) == nil
  end

  test "birth: notifies both, clears demand, takes driver off the browse map",
       %{rider: r, driver: d} do
    HoodrideWeb.Endpoint.subscribe("user:#{r.id}")
    HoodrideWeb.Endpoint.subscribe("user:#{d.id}")

    :ets.insert(
      :geo_drivers,
      {d.id, "cellX", "cellX", System.system_time(:second)}
    )

    :ets.insert(:geo_hands, {r.id, "cellX", "spotX"})

    {:ok, ride_id} = Rides.start_ride(r.id, d.id)

    assert_receive %Phoenix.Socket.Broadcast{event: "ride_started", payload: %{role: "rider"}}
    assert_receive %Phoenix.Socket.Broadcast{event: "ride_started", payload: %{role: "driver"}}
    assert Geo.cell_snapshot("cellX") == %{drivers: [], hands: []}
    assert Rides.ride_id_of_user(r.id) == ride_id
    assert Rides.ride_id_of_user(d.id) == ride_id
  end

  test "the two-seat claim itself refuses overlap — no pre-check involved",
       %{rider: r, driver: d} do
    # found by mutation testing: breaking insert_new survived the whole suite,
    # because the racing test's pre-checks always caught the overlap first.
    # This pins the PRIMITIVE: a seated participant blocks the claim directly.
    {:ok, other} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "sc-o", name: "SCO"})

    {:ok, _ride} = Rides.start_ride(r.id, d.id)

    # same driver, different rider → the driver's seat is taken
    assert {:error, :busy} = Rides.start_ride(other.id, d.id)
    # same rider, different driver → the rider's seat is taken
    assert {:error, :busy} = Rides.start_ride(r.id, other.id)
    # and the original ride is untouched by the failed claims
    assert Rides.ride_id_of_user(r.id) == Rides.ride_id_of_user(d.id)
  end

  test "authority: only the rider pins, only participants end", %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)
    HoodrideWeb.Endpoint.subscribe("ride:#{ride_id}")

    assert {:error, :not_rider} = Rides.set_pin(ride_id, d.id, %{lat: 1.0, lng: 2.0})
    assert :ok = Rides.set_pin(ride_id, r.id, %{lat: 1.0, lng: 2.0})
    assert_receive %Phoenix.Socket.Broadcast{event: "pin", payload: %{pin: %{lat: 1.0}}}

    assert {:ok, %{pin: %{lat: 1.0}}} = Rides.get(ride_id)

    # clearing is the same authority: driver refused, rider reverts to nil
    assert {:error, :not_rider} = Rides.set_pin(ride_id, d.id, nil)
    assert :ok = Rides.set_pin(ride_id, r.id, nil)
    assert_receive %Phoenix.Socket.Broadcast{event: "pin", payload: %{pin: nil}}
    assert {:ok, %{pin: nil}} = Rides.get(ride_id)

    assert {:error, :not_yours} = Rides.end_ride(ride_id, 424_242)
    assert :ok = Rides.end_ride(ride_id, d.id)
    assert_receive %Phoenix.Socket.Broadcast{event: "ended", payload: %{by: _}}
  end

  test "arrival: driver-only, broadcast once, idempotent, survives in state",
       %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)
    HoodrideWeb.Endpoint.subscribe("ride:#{ride_id}")

    # the rider can't declare the driver's arrival
    assert {:error, :not_driver} = Rides.arrived(ride_id, r.id)
    assert {:ok, %{arrived: false}} = Rides.get(ride_id)

    # the driver can — both parties hear it
    assert :ok = Rides.arrived(ride_id, d.id)
    assert_receive %Phoenix.Socket.Broadcast{event: "arrived"}
    assert {:ok, %{arrived: true}} = Rides.get(ride_id)

    # declaring again (auto-detect may re-fire) doesn't re-broadcast
    assert :ok = Rides.arrived(ride_id, d.id)
    refute_receive %Phoenix.Socket.Broadcast{event: "arrived"}, 200
  end

  test "death is deletion", %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(ride_id)
    ref = Process.monitor(pid)

    :ok = Rides.end_ride(ride_id, r.id)

    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}
    assert Rides.get(ride_id) == {:error, :gone}
    assert Rides.ride_id_of_user(r.id) == nil
    assert Rides.ride_id_of_user(d.id) == nil
  end

  test "abandonment: both silent too long → the ride ends itself", %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)
    HoodrideWeb.Endpoint.subscribe("ride:#{ride_id}")
    pid = ride_pid(ride_id)
    ref = Process.monitor(pid)

    # time-travel the activity stamps into the distant past, then force a check
    :sys.replace_state(pid, fn st -> %{st | last_rider: 0, last_driver: 0} end)
    send(pid, :check_abandoned)

    assert_receive %Phoenix.Socket.Broadcast{event: "ended", payload: %{reason: "abandoned"}}
    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}
    assert Rides.ride_id_of_user(r.id) == nil
  end

  test "recent activity on either side keeps the ride alive", %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(ride_id)

    # rider silent forever, but the driver was just active
    :sys.replace_state(pid, fn st -> %{st | last_rider: 0} end)
    Rides.position(ride_id, d.id, %{lat: 1.0, lng: 2.0})
    send(pid, :check_abandoned)

    # still alive
    assert {:ok, _} = Rides.get(ride_id)
    assert Process.alive?(pid)
  end

  test "unknown rides answer gone" do
    assert Rides.get("r-nope") == {:error, :gone}
    assert Rides.set_pin("r-nope", 1, %{lat: 0.0, lng: 0.0}) == {:error, :gone}
    assert Rides.end_ride("r-nope", 1) == {:error, :gone}
  end
end
