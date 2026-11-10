defmodule HoodrideWeb.MapBatchTest do
  @moduledoc """
  THE MAP BATCH (:map_batch_ms; 0 = off): a map channel holds its live
  updates for a moment and sends them as ONE "batch" frame — fewer socket
  writes, the biggest cost at scale (ARCHITECTURE.md "Capacity").

  The rules this proves:
    - only the newest message per car / hand / count survives; different
      ones keep their order
    - each channel runs its own timer, only while something is held
    - everything held goes out BEFORE any reply (a sync's fresh snapshot
      must never be followed by an older position) and before "role"
    - privacy: the role is checked LIVE at send time; a role change drops
      what's held for the lost layer
  """
  use ExUnit.Case

  alias Hoodride.TestClient
  import TestClient, only: [request: 4]

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

  defp batching(ms), do: Application.put_env(:hoodride, :map_batch_ms, ms)

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

  defp sync(client, payload), do: request(client, "world", "sync", payload)

  # a car's own app on its own user channel; the reply to a barrier on that
  # channel means it was processed (and its broadcasts sent)
  defp drive(driver, cell, spot) do
    topic = "user:#{driver.user.id}"

    send(
      driver.pid,
      {:push, self(), topic, "driver_update",
       %{"cell" => cell, "spot" => spot, "lat" => 40.7, "lng" => -74.0}}
    )

    name = driver.name
    assert_receive {^name, :pushed, _}
    _ = request(driver, topic, "__barrier__", %{})
    :ok
  end

  # driver_offline answers nothing: a barrier after it marks "processed"
  defp offline(driver) do
    topic = "user:#{driver.user.id}"
    send(driver.pid, {:push, self(), topic, "driver_offline", %{}})
    name = driver.name
    assert_receive {^name, :pushed, _}
    _ = request(driver, topic, "__barrier__", %{})
    :ok
  end

  # the world pushes `client` has received so far, raw (no barrier)
  defp received(%{name: name}, acc \\ []) do
    receive do
      {^name, :got, %Phoenix.Socket.Message{topic: "world", event: e, payload: p}} ->
        received(%{name: name}, [{e, p} | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  # a barrier request: everything held is sent before its reply
  defp flushed(client) do
    _ = request(client, "world", "__barrier__", %{})
    received(client)
  end

  # every car message, sent alone or inside a batch
  defp car_items(frames) do
    Enum.flat_map(frames, fn
      {"batch", %{items: items}} -> for [e, p] <- items, do: {e, p}
      frame -> [frame]
    end)
    |> Enum.filter(fn {e, _} -> e in ~w(driver_update driver_left) end)
  end

  # find the nearest counts only who's on the map: a "left" about an area
  # the app no longer watches must never reach it. The race: the app moves
  # its view X → Y while a car crosses X → Y. "left X" is queued for this
  # channel BEFORE it stops watching X; "arrived in Y" goes out before it
  # starts watching Y (missed: Y's snapshot has the car). The stale "left X"
  # would then delete the car — by id — from the map: a parked car gone for
  # good. The channel is paused to line it up exactly so.
  for ms <- [0, 500] do
    test "a 'left' for an area no longer watched never reaches the app (view moved X → Y as a car crossed; batch #{ms} ms)" do
      batching(unquote(ms))
      rider = TestClient.start(:rider, user("mb-stale-r#{unquote(ms)}"))
      driver = TestClient.start(:driver, user("mb-stale-d#{unquote(ms)}"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      drive(driver, @cell, @spot)
      _ = flushed(rider)
      pid = TestClient.channel_pid(rider)
      :sys.suspend(pid)
      # the view moves to Y (queued behind nothing; handled on resume) …
      send(rider.pid, {:push, self(), "world", "sync", %{"geo" => [@cell2]}})
      name = rider.name
      assert_receive {^name, :pushed, _}
      # … and the car crosses X → Y: "left X" queued behind the sync
      drive(driver, @cell2, @spot2)
      :sys.resume(pid)
      frames = flushed(rider)

      refute Enum.any?(car_items(frames), &match?({"driver_left", _}, &1)),
             "a stale 'left' reached the app: #{inspect(frames)}"
    end
  end

  # the ✋ mirror: an online driver watches X; a rider's ✋ moves X → Y as
  # the driver's view moves X → Y — the stale "hand_left X" must never
  # reach the app (it would delete that ✋ from Y, by id)
  for ms <- [0, 500] do
    test "a ✋ 'left' for an area no longer watched never reaches the driver (batch #{ms} ms)" do
      batching(unquote(ms))
      driver = TestClient.start(:hdriver, user("mb-hstale-d#{unquote(ms)}"))
      rider = TestClient.start(:hrider, user("mb-hstale-r#{unquote(ms)}"))
      drive(driver, @cell, @spot)
      assert {:ok, _} = sync(driver, %{"geo" => [@cell]})
      hand(rider, @cell, @spot)
      frames0 = flushed(driver)

      assert Enum.any?(hand_items(frames0), &match?({"hand_update", _}, &1)),
             "(the ✋ seen in X first: #{inspect(frames0)})"

      pid = TestClient.channel_pid(driver)
      :sys.suspend(pid)
      send(driver.pid, {:push, self(), "world", "sync", %{"geo" => [@cell2]}})
      name = driver.name
      assert_receive {^name, :pushed, _}
      hand(rider, @cell2, @spot2)
      :sys.resume(pid)
      frames = flushed(driver)

      refute Enum.any?(hand_items(frames), &match?({"hand_left", _}, &1)),
             "a stale ✋ 'left' reached the app: #{inspect(frames)}"
    end
  end

  defp hand(rider, cell, spot) do
    topic = "user:#{rider.user.id}"
    send(rider.pid, {:push, self(), topic, "hand_up", %{"cell" => cell, "spot" => spot}})
    name = rider.name
    assert_receive {^name, :pushed, _}
    _ = request(rider, topic, "__barrier__", %{})
    :ok
  end

  defp hand_items(frames) do
    Enum.flat_map(frames, fn
      {"batch", %{items: items}} -> for [e, p] <- items, do: {e, p}
      frame -> [frame]
    end)
    |> Enum.filter(fn {e, _} -> e in ~w(hand_update hand_left) end)
  end

  describe "off (0)" do
    test "every update is its own message, at once — exactly as before" do
      batching(0)
      rider = TestClient.start(:rider, user("mb-r0"))
      driver = TestClient.start(:driver, user("mb-d0"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, @cell, @spot)
      _ = request(rider, "world", "__barrier__", %{})
      assert [{"driver_update", %{id: _, spot: @spot}}] = received(rider)
    end
  end

  describe "on" do
    test "updates are held: nothing is sent until the window ends or a reply is due" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r1"))
      d1 = TestClient.start(:d1, user("mb-d1"))
      d2 = TestClient.start(:d2, user("mb-d2"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(d1, @cell, @spot)
      drive(d2, @cell, @spot2)
      # the channel has seen both (a call is answered after earlier messages)
      _ = :sys.get_state(TestClient.channel_pid(rider))
      assert received(rider) == []

      # ONE frame, both cars, in the order they moved
      assert [{"batch", %{items: [["driver_update", %{id: id1}], ["driver_update", %{id: id2}]]}}] =
               flushed(rider)

      assert {id1, id2} == {d1.user.id, d2.user.id}
    end

    test "each channel's own timer sends what's held, by itself" do
      batching(30)
      rider = TestClient.start(:rider, user("mb-r2"))
      driver = TestClient.start(:driver, user("mb-d3"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, @cell, @spot)

      # 10 s for a 30 ms timer: the batch arrives as soon as it's sent, but a
      # CPU-starved machine took over 1 s (late, not lost: 301/301 passed
      # under full load with 10 s, 2026-10-28) — same for the two below
      assert_receive {:rider, :got,
                      %Phoenix.Socket.Message{
                        event: "batch",
                        payload: %{items: [["driver_update", _]]}
                      }},
                     10_000
    end

    test "a channel with nothing held runs no timer" do
      batching(30)
      rider = TestClient.start(:rider, user("mb-r3"))
      driver = TestClient.start(:driver, user("mb-d4"))
      pid = TestClient.channel_pid(rider)
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      assert :sys.get_state(pid).assigns.flush_timer == nil

      drive(driver, @cell, @spot)
      _ = :sys.get_state(pid)
      assert :sys.get_state(pid).assigns.flush_timer != nil

      assert_receive {:rider, :got, %Phoenix.Socket.Message{event: "batch"}}, 10_000
      assert :sys.get_state(pid).assigns.flush_timer == nil
    end

    test "after a reply sent what was held early, the next updates still go out by themselves" do
      batching(30)
      rider = TestClient.start(:rider, user("mb-r12"))
      driver = TestClient.start(:driver, user("mb-d13"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      # held, then sent early by a reply (its timer cancelled)
      drive(driver, @cell, @spot)
      assert [{"batch", _}] = flushed(rider)

      # the next one needs a fresh timer of its own
      drive(driver, @cell, @spot2)

      assert_receive {:rider, :got,
                      %Phoenix.Socket.Message{
                        event: "batch",
                        payload: %{items: [["driver_update", %{spot: @spot2}]]}
                      }},
                     10_000
    end

    test "a car that moved twice sends only where it is now" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r4"))
      driver = TestClient.start(:driver, user("mb-d5"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, @cell, @spot)
      drive(driver, @cell, @spot2)
      assert [{"driver_update", %{spot: @spot2}}] = car_items(flushed(rider))
    end

    test "a car that moved and then left sends only that it left" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r5"))
      driver = TestClient.start(:driver, user("mb-d6"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, @cell, @spot)
      offline(driver)
      assert [{"driver_left", %{id: id}}] = car_items(flushed(rider))
      assert id == driver.user.id
    end

    test "a car crossing into the next watched cell arrives once, in its new cell" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r6"))
      driver = TestClient.start(:driver, user("mb-d7"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell, @cell2]})

      drive(driver, @cell, @spot)
      # left @cell, then appeared in @cell2: the newer message wins
      drive(driver, @cell2, "892a1072cc3ffff")
      assert [{"driver_update", %{cell: @cell2}}] = car_items(flushed(rider))
    end

    test "what's held goes out BEFORE a sync's reply (no old position after a snapshot)" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r7"))
      driver = TestClient.start(:driver, user("mb-d8"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      drive(driver, @cell, @spot)

      send(rider.pid, {:push, self(), "world", "sync", %{"geo" => [@cell, @cell2]}})
      assert_receive {:rider, :pushed, ref}

      assert_receive {:rider, :got, first}
      assert %Phoenix.Socket.Message{event: "batch"} = first
      assert_receive {:rider, :got, %Phoenix.Socket.Reply{ref: ^ref}}
    end
  end

  describe "privacy" do
    test "a role change drops what's held for the lost layer" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r8"))
      driver = TestClient.start(:driver, user("mb-d9"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})

      drive(driver, @cell, @spot)
      # the rider goes online as a driver: online drivers never see cars
      drive(rider, @cell, @spot2)

      frames = flushed(rider)
      assert {"role", %{role: "driver"}} in frames
      assert car_items(frames) == []
    end

    test "the role is checked LIVE when sending — a role ping not yet seen can't leak" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r9"))
      driver = TestClient.start(:driver, user("mb-d10"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      drive(driver, @cell, @spot)

      # in a ride as far as the server's tables go, with NO ping sent
      :ets.insert(:rides_by_user, {rider.user.id, "ride-x"})
      frames = flushed(rider)
      assert car_items(frames) == []
      assert {"role", %{role: "in_ride"}} in frames
    end

    test "a car update queued BEHIND a role change is never held for later" do
      batching(60_000)
      rider = TestClient.start(:rider, user("mb-r11"))
      driver = TestClient.start(:driver, user("mb-d12"))
      assert {:ok, _} = sync(rider, %{"geo" => [@cell]})
      pid = TestClient.channel_pid(rider)

      # the map channel is busy: the role ping queues first, then a car
      # update (still subscribed — the channel hasn't seen the ping yet)
      :sys.suspend(pid)
      drive(rider, @cell, @spot2)
      drive(driver, @cell, @spot)
      :sys.resume(pid)

      frames = flushed(rider)
      assert {"role", %{role: "driver"}} in frames
      assert car_items(frames) == []
    end
  end
end
