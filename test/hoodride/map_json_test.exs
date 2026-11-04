defmodule Hoodride.MapJsonTest do
  @moduledoc """
  ENCODE ONCE: every map broadcast (car, hand, count) carries `json` — the
  same update encoded ONCE by the map writer. A batching map channel puts
  it into its frame as-is (Jason.Fragment) instead of every watcher's
  channel encoding the same update again: that per-watcher encoding was
  ~36% of a map channel's time under load (ARCHITECTURE.md "Capacity").

  What must hold: `json` is EXACTLY the update itself, encoded — nothing
  more (it goes on the wire), nothing less — and the wire is unchanged:
  a batch's bytes are what the plain payloads would encode to, and with
  batching off no `json` field ever reaches the app.
  """
  use ExUnit.Case

  alias Hoodride.{Geo, TestClient}

  @cell "882a1072c7fffff"
  @cell2 "882a1072cffffff"
  @spot "892a1072c63ffff"
  @spot2 "892a1072c67ffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    old = Application.get_env(:hoodride, :map_batch_ms)
    on_exit(fn -> Application.put_env(:hoodride, :map_batch_ms, old) end)
    :ok
  end

  defp profile(id), do: %{id: id, name: "P#{id}", photo: nil}

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: key,
        name: key,
        photo: nil
      })

    u
  end

  # the update itself (what the app receives) and its one-time encoding
  defp exact!(%Phoenix.Socket.Broadcast{payload: payload}) do
    {json, plain} = Map.pop!(payload, :json)
    assert is_binary(json)
    assert json == Jason.encode!(plain)
    plain
  end

  defp subscribe(topic), do: :ok = Phoenix.PubSub.subscribe(Hoodride.PubSub, topic)

  test "a car's update and its leaving carry exactly themselves, encoded" do
    subscribe(Geo.geo_topic(:drivers, @cell))
    subscribe(Geo.geo_topic(:drivers, @cell2))

    Geo.driver_update(profile(11), @cell, @spot, [])
    assert_receive %Phoenix.Socket.Broadcast{event: "driver_update"} = b
    assert exact!(b) == %{id: 11, cell: @cell, spot: @spot}

    Geo.driver_update(profile(11), @cell2, "892a1072cc3ffff", [])
    assert_receive %Phoenix.Socket.Broadcast{event: "driver_left"} = left
    assert exact!(left) == %{id: 11}
    assert_receive %Phoenix.Socket.Broadcast{event: "driver_update"} = moved
    assert exact!(moved) == %{id: 11, cell: @cell2, spot: "892a1072cc3ffff"}

    Geo.driver_offline(11)
    assert_receive %Phoenix.Socket.Broadcast{event: "driver_left"} = gone
    assert exact!(gone) == %{id: 11}
  end

  test "a hand's update and its leaving carry exactly themselves, encoded" do
    subscribe(Geo.geo_topic(:hands, @cell))

    Geo.hand_up(12, @cell, @spot, [])
    assert_receive %Phoenix.Socket.Broadcast{event: "hand_update"} = b
    assert exact!(b) == %{id: 12, cell: @cell, spot: @spot}

    Geo.hand_down(12)
    assert_receive %Phoenix.Socket.Broadcast{event: "hand_left"} = gone
    assert exact!(gone) == %{id: 12}
  end

  test "a count carries exactly itself, encoded — one side only" do
    subscribe(Geo.agg_topic(:drivers, "c7J"))

    Geo.driver_update(profile(13), "cell8j", nil, ["c7J"])
    assert_receive %Phoenix.Socket.Broadcast{event: "agg_update"} = b
    assert exact!(b) == %{cell: "c7J", drivers: 1}
  end

  defp drive(driver, cell, spot) do
    topic = "user:#{driver.user.id}"

    send(
      driver.pid,
      {:push, self(), topic, "driver_update",
       %{"cell" => cell, "spot" => spot, "lat" => 40.7, "lng" => -74.0}}
    )

    name = driver.name
    assert_receive {^name, :pushed, _}
    _ = TestClient.request(driver, topic, "__barrier__", %{})
    :ok
  end

  # the raw world messages a client got (before any test-side decoding)
  defp raw(%TestClient{name: name}, acc \\ []) do
    receive do
      {^name, :raw, %Phoenix.Socket.Message{topic: "world"} = m} ->
        raw(%TestClient{name: name}, [m | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  # what goes on the wire for a world message (the app's serializer)
  defp wire(%Phoenix.Socket.Message{} = m) do
    {:socket_push, :text, data} = Phoenix.Socket.V2.JSONSerializer.encode!(%{m | join_ref: "2"})
    data |> IO.iodata_to_binary() |> Jason.decode!()
  end

  test "a batch's bytes are exactly what the plain updates encode to" do
    Application.put_env(:hoodride, :map_batch_ms, 60_000)
    rider = TestClient.start(:rider, user("mj-r1"), nil, raw: self())
    driver = TestClient.start(:driver, user("mj-d1"))
    assert {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})

    drive(driver, @cell, @spot)
    drive(driver, @cell, @spot2)
    _ = TestClient.request(rider, "world", "__barrier__", %{})

    assert [batch] = Enum.filter(raw(rider), &(&1.event == "batch"))

    assert ["2", nil, "world", "batch", %{"items" => [["driver_update", item]]}] = wire(batch)
    assert item == %{"id" => driver.user.id, "cell" => @cell, "spot" => @spot2}
  end

  test "with encode-once switched off (only to measure against), the batch's bytes are the same" do
    old = Application.get_env(:hoodride, :map_encode_once)
    on_exit(fn -> Application.put_env(:hoodride, :map_encode_once, old) end)
    Application.put_env(:hoodride, :map_encode_once, false)
    Application.put_env(:hoodride, :map_batch_ms, 60_000)
    rider = TestClient.start(:rider, user("mj-r3"), nil, raw: self())
    driver = TestClient.start(:driver, user("mj-d3"))
    assert {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})

    drive(driver, @cell, @spot)
    _ = TestClient.request(rider, "world", "__barrier__", %{})

    assert [batch] = Enum.filter(raw(rider), &(&1.event == "batch"))
    assert ["2", nil, "world", "batch", %{"items" => [["driver_update", item]]}] = wire(batch)
    assert item == %{"id" => driver.user.id, "cell" => @cell, "spot" => @spot}
  end

  test "batching off: the app gets the plain update — no json field on the wire" do
    Application.put_env(:hoodride, :map_batch_ms, 0)
    rider = TestClient.start(:rider, user("mj-r2"), nil, raw: self())
    driver = TestClient.start(:driver, user("mj-d2"))
    assert {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})

    drive(driver, @cell, @spot)
    _ = TestClient.request(rider, "world", "__barrier__", %{})

    assert [update] = Enum.filter(raw(rider), &(&1.event == "driver_update"))
    assert update.payload == %{id: driver.user.id, cell: @cell, spot: @spot}

    assert [
             "2",
             nil,
             "world",
             "driver_update",
             %{"id" => _, "cell" => @cell, "spot" => @spot} = p
           ] = wire(update)

    assert map_size(p) == 3
  end
end
