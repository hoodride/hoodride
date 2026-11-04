defmodule Hoodride.RequestsEdgeTest do
  @moduledoc "Request lifecycle edges: wrong actors, freshness, idempotence."
  use ExUnit.Case

  alias Hoodride.Requests

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    :ok
  end

  defp rider(id), do: %{id: id, name: "R#{id}", photo: nil}

  # requests can only target a driver who is on the map
  defp on_map(id),
    do: Hoodride.Geo.driver_update(%{id: id, name: "D#{id}", photo: nil}, "cell8", nil)

  test "fresh requests are not expired" do
    on_map(22)
    :ok = Requests.create(rider(11), 22)
    Requests.expire_older_than(300)
    assert Requests.open_request_of(11) != nil
  end

  test "decline by the wrong driver leaves the request intact" do
    on_map(22)
    :ok = Requests.create(rider(11), 22)
    assert {:error, :not_yours} = Requests.decline(33, 11)
    assert %{driver_id: 22} = Requests.open_request_of(11)
  end

  test "accept by the wrong driver leaves the request intact" do
    on_map(22)
    :ok = Requests.create(rider(11), 22)
    assert {:error, :not_yours} = Requests.accept(rider(33), 11)
    assert %{driver_id: 22} = Requests.open_request_of(11)
  end

  test "cancel of nothing is a no-op error" do
    assert {:error, :none} = Requests.cancel(11)
  end

  test "open_between? sees both directions" do
    on_map(22)
    :ok = Requests.create(rider(11), 22)
    assert Requests.open_between?(11, 22)
    assert Requests.open_between?(22, 11)
    refute Requests.open_between?(11, 33)
  end

  test "pending_for_driver lists only that driver's requests" do
    on_map(22)
    on_map(99)
    :ok = Requests.create(rider(11), 22)
    :ok = Requests.create(rider(12), 22)
    :ok = Requests.create(rider(13), 99)

    pending = Requests.pending_for_driver(22)
    assert length(pending) == 2
    assert Enum.all?(pending, fn r -> r.rider_id in [11, 12] end)
  end

  # ===== unavailable drivers decline everyone waiting, instantly =====

  test "going offline declines all waiting riders and notifies each one" do
    HoodrideWeb.Endpoint.subscribe("user:11")
    HoodrideWeb.Endpoint.subscribe("user:12")
    HoodrideWeb.Endpoint.subscribe("user:13")

    on_map(22)
    on_map(99)
    :ok = Requests.create(rider(11), 22)
    :ok = Requests.create(rider(12), 22)
    # a request aimed at a DIFFERENT driver must be untouched
    :ok = Requests.create(rider(13), 99)

    Hoodride.Geo.driver_offline(22)

    assert_receive %Phoenix.Socket.Broadcast{
      topic: "user:11",
      event: "request_declined",
      payload: %{by_id: 22}
    }

    assert_receive %Phoenix.Socket.Broadcast{topic: "user:12", event: "request_declined"}
    refute_receive %Phoenix.Socket.Broadcast{topic: "user:13", event: "request_declined"}, 100

    assert Requests.open_request_of(11) == nil
    assert Requests.open_request_of(12) == nil
    assert %{driver_id: 99} = Requests.open_request_of(13)
  end

  test "ride start declines the driver's other suitors but not the accepted rider" do
    # ride init loads real profiles — these two must exist in the DB
    {:ok, r1} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "dq-r1", name: "Rq1"})

    {:ok, d} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "dq-d", name: "Dq"})

    HoodrideWeb.Endpoint.subscribe("user:12")

    on_map(d.id)
    :ok = Requests.create(rider(r1.id), d.id)
    :ok = Requests.create(rider(12), d.id)

    assert {:ok, _ride_id} = Requests.accept(rider(d.id), r1.id)

    assert_receive %Phoenix.Socket.Broadcast{
      topic: "user:12",
      event: "request_declined",
      payload: %{by_id: driver_id}
    }

    assert driver_id == d.id
    assert Requests.open_request_of(12) == nil
    # the accepted pair is riding, not re-requested
    assert Hoodride.Rides.ride_id_of_user(r1.id) != nil
    assert Hoodride.Rides.ride_id_of_user(d.id) != nil
  end

  test "grace-reap of a dead driver declines their waiting riders too" do
    HoodrideWeb.Endpoint.subscribe("user:11")

    # driver 22 has a map row but no presence record → hard offline → reaped
    Hoodride.Geo.driver_update(%{id: 22, name: "D22", photo: nil}, "cell8g", nil)
    :ok = Requests.create(rider(11), 22)

    Hoodride.Sweeper.sweep_now()

    assert_receive %Phoenix.Socket.Broadcast{
      topic: "user:11",
      event: "request_declined",
      payload: %{by_id: 22}
    }

    assert Requests.open_request_of(11) == nil
  end

  test "a driver merely inside the grace window KEEPS their pending requests" do
    HoodrideWeb.Endpoint.subscribe("user:11")

    # driver connected, went on the map, took a request — then their socket
    # blipped (grace starts NOW, well inside the 5-minute window)
    Hoodride.Geo.user_connected(22)
    on_map(22)
    :ok = Requests.create(rider(11), 22)
    Hoodride.Geo.user_disconnected(22)

    Hoodride.Sweeper.sweep_now()

    # a blip is not unavailability: no decline, request intact, driver on map
    refute_receive %Phoenix.Socket.Broadcast{event: "request_declined"}, 100
    assert %{driver_id: 22} = Requests.open_request_of(11)
    assert Hoodride.Geo.driver_on_map?(22)
  end

  test "you cannot even ask a driver who is not on the map" do
    assert {:error, :driver_offline} = Requests.create(rider(11), 22)
    assert Requests.open_request_of(11) == nil

    # and the moment they go online, the ask works
    on_map(22)
    assert :ok = Requests.create(rider(11), 22)
  end
end
