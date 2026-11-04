defmodule HoodrideWeb.ContactPrivacyTest do
  @moduledoc """
  Who can reach whom, and what outlives a ride.

  COLD CONTACT (no chat, no open request, no shared ride): you can only
  reach someone who is on YOUR screen — a car in a hex your map is
  watching, or (as an online driver) a raised hand in one. One rule for
  messages and requests. Every refusal looks the same, so nobody can probe
  who exists; the one exception says a car merely left your view (cars are
  public while online, so that leaks nothing).

  RIDES: the pair's chat exists from the ride's first moment (so a silent
  ride stays reachable afterwards), exact positions flow only while the
  ride lives, and a ride that dies abnormally still tells both apps.
  """
  use ExUnit.Case

  import ExUnit.CaptureLog

  alias Hoodride.{Geo, Requests, Rides, TestClient}
  import TestClient, only: [request: 4]

  @cell "8f2830828052d25"
  @far "8f2830828052fff"

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

  defp profile(u), do: %{id: u.id, name: u.name, photo: u.photo}
  defp drive(u, cell), do: Geo.driver_update(profile(u), cell, nil)
  defp watch(client, cells), do: {:ok, _} = request(client, "world", "sync", %{"geo" => cells})

  defp msg(client, to),
    do: request(client, "user:#{client.user.id}", "send_msg", %{"to" => to, "text" => "hi"})

  defp ask(client, to),
    do: request(client, "user:#{client.user.id}", "request_ride", %{"to" => to})

  describe "cold contact: only someone on your screen" do
    test "a stranger who isn't on the map is unreachable — and looks exactly like a missing id" do
      rider = TestClient.start(:rider, user("cc-r"))
      stranger = user("cc-stranger")

      refused = msg(rider, stranger.id)
      assert {:error, %{reason: _}} = refused
      assert msg(rider, 9_999_999_999) == refused
      assert ask(rider, stranger.id) == refused
      assert ask(rider, 9_999_999_999) == refused
    end

    test "a car on your screen: message and request both go through" do
      driver = user("cc-d")
      drive(driver, @cell)
      rider = TestClient.start(:rider, user("cc-r"))
      watch(rider, [@cell])

      assert {:ok, _} = msg(rider, driver.id)
      assert {:ok, _} = ask(rider, driver.id)
    end

    test "a car on the map but NOT on your screen: out_of_view, for messages and requests" do
      driver = user("cc-d")
      drive(driver, @far)
      rider = TestClient.start(:rider, user("cc-r"))
      watch(rider, [@cell])

      assert {:error, %{reason: "out_of_view"}} = msg(rider, driver.id)
      assert {:error, %{reason: "out_of_view"}} = ask(rider, driver.id)
    end

    test "an online driver can reach a raised hand on screen, not one off screen" do
      near = user("cc-near")
      far = user("cc-far")
      Geo.hand_up(near.id, @cell, "spot9")
      Geo.hand_up(far.id, @far, "spot9")

      d = user("cc-d")
      driver = TestClient.start(:driver, d)
      drive(d, "home")
      watch(driver, [@cell])

      assert {:ok, _} = msg(driver, near.id)
      assert msg(driver, far.id) == msg(driver, 9_999_999_999)
      assert {:error, _} = msg(driver, far.id)
    end

    test "a hand is only reachable by an ONLINE driver (a viewer watching it can't)" do
      hand = user("cc-hand")
      Geo.hand_up(hand.id, @cell, "spot9")
      viewer = TestClient.start(:viewer, user("cc-v"))
      watch(viewer, [@cell])

      assert msg(viewer, hand.id) == msg(viewer, 9_999_999_999)
    end

    test "drivers can't cold-contact other drivers (a driver's map never holds cars)" do
      other = user("cc-other")
      drive(other, @cell)
      d = user("cc-d")
      driver = TestClient.start(:driver, d)
      drive(d, "home")
      watch(driver, [@cell])

      # the generic refusal: out_of_view would tell a driver "that id is an
      # online car" — and drivers don't get cars
      assert {:error, %{reason: "unavailable"}} = msg(driver, other.id)
    end

    test "mid-ride: no NEW cold contacts (the map watches nothing)" do
      driver = user("cc-d")
      drive(driver, @cell)
      r = user("cc-r")
      rider = TestClient.start(:rider, r)
      watch(rider, [@cell])
      {:ok, _} = Rides.start_ride(r.id, user("cc-partner").id)

      assert {:error, _} = msg(rider, driver.id)
    end

    test "no map channel → refused (the safe side)" do
      driver = user("cc-d")
      drive(driver, @cell)
      r = user("cc-r")
      rider = TestClient.start(:rider, r, ["user:#{r.id}"])

      assert {:error, _} = msg(rider, driver.id)
    end

    test "a STALE \"yes\" from the map channel doesn't count: the sender's live role decides" do
      # the map channel still believes it's receiving hands (a role change
      # it hasn't processed yet); the sender is a plain viewer in ETS
      hand = user("cc-hand")
      Geo.hand_up(hand.id, @cell, "spot9")
      v = user("cc-v")
      viewer = TestClient.start(:viewer, v)
      world = TestClient.channel_pid(viewer)

      :sys.replace_state(world, fn st ->
        put_in(st.assigns.held, MapSet.new([Geo.geo_topic(:hands, @cell)]))
      end)

      assert {:error, %{reason: "unavailable"}} = msg(viewer, hand.id)
    end

    test "an existing chat skips the screen check (replies always reach)" do
      a = user("cc-a")
      b = user("cc-b")
      Hoodride.Chat.send_message(profile(b), a.id, "hey")
      client = TestClient.start(:a, a)

      assert {:ok, _} = msg(client, b.id)
    end
  end

  describe "ride chat" do
    # a ride started the real way: the rider asks a car on the map, the
    # driver accepts. No message was ever sent (a SILENT ride).
    defp silent_ride do
      r = user("rc-r")
      d = user("rc-d")
      drive(d, @cell)
      :ok = Requests.create(r, d.id)
      {:ok, ride_id} = Requests.accept(d, r.id)
      %{r: r, d: d, ride_id: ride_id}
    end

    test "accepting a request creates the pair's conversation (a silent ride stays reachable)" do
      %{r: r, d: d} = silent_ride()
      assert Hoodride.Chat.exists?(r.id, d.id)
    end

    test "the chat exists BEFORE either app hears ride_started (traced, not timed)" do
      r = user("rc-r")
      d = user("rc-d")
      drive(d, @cell)
      :ok = Requests.create(r, d.id)

      # the ride runs in a process the supervisor spawns: trace every new
      # process's calls, keep the conversation write and the ride_started
      # broadcasts, and compare their order inside the ride process
      :erlang.trace_pattern({:ets, :insert, 2}, true, [])
      :erlang.trace_pattern({HoodrideWeb.Endpoint, :broadcast, 3}, true, [])
      :erlang.trace(:new_processes, true, [:call])

      try do
        {:ok, _} = Requests.accept(d, r.id)
      after
        :erlang.trace(:new_processes, false, [:call])
        :erlang.trace_pattern({:ets, :insert, 2}, false, [])
        :erlang.trace_pattern({HoodrideWeb.Endpoint, :broadcast, 3}, false, [])
      end

      steps = ride_steps([])

      assert :chat_written in steps,
             "the ride never wrote the pair's conversation: #{inspect(steps)}"

      assert Enum.find_index(steps, &(&1 == :chat_written)) <
               Enum.find_index(steps, &(&1 == :ride_started))
    end

    test "the FIRST mid-ride message goes through both ways (\"I'm the gray Honda\")" do
      # mid-ride the driver is off the map and neither map watches anything,
      # so without the ride's chat this would be a refused cold contact
      %{r: r, d: d} = silent_ride()
      rider = TestClient.start(:rider, r)
      driver = TestClient.start(:driver, d)

      assert {:ok, _} = msg(rider, d.id)
      assert {:ok, _} = msg(driver, r.id)
    end

    test "after a silent ride ends, the two can still message each other" do
      %{r: r, d: d, ride_id: ride_id} = silent_ride()
      :ok = Rides.end_ride(ride_id, r.id)
      rider = TestClient.start(:rider, r)
      driver = TestClient.start(:driver, d)

      # both off the map now, nobody watching anybody — the chat carries it
      assert {:ok, _} = msg(rider, d.id)
      assert {:ok, _} = msg(driver, r.id)
    end

    test "after the ride, a reload still lists the ex-partner's (empty) chat" do
      %{r: r, d: d, ride_id: ride_id} = silent_ride()
      :ok = Rides.end_ride(ride_id, r.id)

      conn =
        Phoenix.ConnTest.build_conn()
        |> Phoenix.ConnTest.init_test_session(Hoodride.TestHelpers.session_for(r.id))
        |> Phoenix.ConnTest.dispatch(HoodrideWeb.Endpoint, :get, "/api/state")

      assert [%{"peer" => %{"id" => peer_id, "name" => "rc-d"}, "messages" => []}] =
               Phoenix.ConnTest.json_response(conn, 200)["conversations"]

      assert peer_id == d.id
    end

    test "mid-ride, a reply in an EXISTING chat with someone else still works (\"free in 15\")" do
      next_fare = user("rc-next")
      %{d: d} = silent_ride()
      Hoodride.Chat.send_message(profile(next_fare), d.id, "can you get me after?")
      driver = TestClient.start(:driver, d)

      assert {:ok, _} = msg(driver, next_fare.id)
    end

    test "the ride's chat is never swept mid-ride, and dies by the normal rule after" do
      %{r: r, d: d, ride_id: ride_id} = silent_ride()

      # nobody connected and both long past grace: only the ride protects it
      for u <- [r, d], do: :ets.insert(:geo_presence, {u.id, :grace, 0})
      Hoodride.Sweeper.sweep_empty_room_chats()
      assert Hoodride.Chat.exists?(r.id, d.id)

      :ok = Rides.end_ride(ride_id, r.id)
      Hoodride.Sweeper.sweep_empty_room_chats()
      refute Hoodride.Chat.exists?(r.id, d.id)
    end
  end

  # the traced ride's relevant steps, in its own order
  defp ride_steps(acc) do
    receive do
      {:trace, _pid, :call, {:ets, :insert, [:chat_conversations | _]}} ->
        ride_steps([:chat_written | acc])

      {:trace, _pid, :call, {HoodrideWeb.Endpoint, :broadcast, ["user:" <> _, "ride_started", _]}} ->
        ride_steps([:ride_started | acc])

      {:trace, _, _, _} ->
        ride_steps(acc)
    after
      200 -> Enum.reverse(acc)
    end
  end

  describe "exact positions only while the ride lives" do
    setup do
      r = user("rp-r")
      d = user("rp-d")
      {:ok, ride_id} = Rides.start_ride(r.id, d.id)
      topic = "ride:" <> ride_id
      rider = TestClient.start(:rider, r, [topic])
      driver = TestClient.start(:driver, d, [topic])
      %{ride_id: ride_id, topic: topic, rider: rider, driver: driver, r: r}
    end

    test "a position from someone no longer in the ride is never relayed", ctx do
      # the seat is gone (however it went) while the channel lingers
      :ets.delete(:rides_by_user, ctx.r.id)
      send(ctx.rider.pid, {:push, self(), ctx.topic, "pos", %{"lat" => 1.0, "lng" => 2.0}})

      refute_receive {:driver, :got, %Phoenix.Socket.Message{event: "peer_pos"}}, 300
    end

    # the channels close after their first "ended", so a duplicate would
    # never reach a client: count the broadcasts on the topic itself
    defp ended_broadcasts(topic, n \\ 0) do
      receive do
        %Phoenix.Socket.Broadcast{topic: ^topic, event: "ended"} -> ended_broadcasts(topic, n + 1)
      after
        200 -> n
      end
    end

    test "ending the ride closes both ride channels after exactly one ended", ctx do
      HoodrideWeb.Endpoint.subscribe(ctx.topic)
      Rides.end_ride(ctx.ride_id, ctx.r.id)

      for name <- [:rider, :driver] do
        assert_receive {^name, :got, %Phoenix.Socket.Message{event: "ended"}}, 1_000
        # a clean server-side close (the real socket sends the app phx_close)
        assert_receive {^name, :got, {:socket_close, _, :normal}}, 1_000
        refute_receive {^name, :got, %Phoenix.Socket.Message{event: "ended"}}, 200
      end

      assert ended_broadcasts(ctx.topic) == 1
    end

    test "a ride that CRASHES still tells both apps it ended (no stuck ride screen)", ctx do
      [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ctx.ride_id)

      capture_log(fn ->
        # a bug: a field a position updates is missing — the next position
        # crashes the ride (an unknown message no longer can: it's ignored)
        :sys.replace_state(pid, &Map.delete(&1, :last_driver))
        catch_exit(GenServer.call(pid, {:position, ctx.driver.user.id, %{lat: 1.0, lng: 2.0}}))

        for name <- [:rider, :driver] do
          assert_receive {^name, :got, %Phoenix.Socket.Message{event: "ended"}}, 1_000
          refute_receive {^name, :got, %Phoenix.Socket.Message{event: "ended"}}, 200
        end
      end)
    end

    test "a ride killed outright: the sweeper's seat reclaim sends exactly one ended", ctx do
      [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ctx.ride_id)
      ref = Process.monitor(pid)
      Process.exit(pid, :kill)
      assert_receive {:DOWN, ^ref, :process, ^pid, :killed}

      HoodrideWeb.Endpoint.subscribe(ctx.topic)
      Hoodride.Sweeper.heal_orphan_ride_slots()

      for name <- [:rider, :driver] do
        assert_receive {^name, :got, %Phoenix.Socket.Message{event: "ended"}}, 1_000
        refute_receive {^name, :got, %Phoenix.Socket.Message{event: "ended"}}, 200
      end

      # one ride, two seats reclaimed: ONE "ended", not one per seat
      assert ended_broadcasts(ctx.topic) == 1
    end
  end

  describe "user ids" do
    test "new ids are random, not a count (they'd reveal how many users exist)" do
      ids = for i <- 1..5, do: user("id-#{i}").id
      gaps = ids |> Enum.chunk_every(2, 1, :discard) |> Enum.map(fn [a, b] -> abs(b - a) end)

      refute Enum.any?(gaps, &(&1 == 1)), "consecutive ids: #{inspect(ids)}"
      assert Enum.all?(ids, &(&1 > 4_294_967_296 and &1 < 9_007_199_254_740_992))
    end
  end
end
