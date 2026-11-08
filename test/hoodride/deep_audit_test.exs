defmodule Hoodride.DeepAuditTest do
  @moduledoc """
  Second-pass audit: true concurrency (parallel processes racing),
  authorization corners, and crash-residue healing.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Chat, Geo, Requests, Rides, Sweeper}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    users =
      for key <- ["da-a", "da-b", "da-c"] do
        {:ok, u} =
          Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

        u
      end

    [a, b, c] = users
    %{a: a, b: b, c: c}
  end

  defp as_map(u), do: %{id: u.id, name: u.name, photo: nil}
  defp ancient, do: System.system_time(:second) - 10_000

  # requests can only target a driver who is on the map
  defp on_map(u),
    do: Hoodride.Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, "cell8", nil)

  # ===== concurrency =====

  test "two-tab race: one driver accepting two riders in parallel starts exactly one ride",
       %{a: rider1, b: rider2, c: driver} do
    on_map(driver)
    :ok = Requests.create(as_map(rider1), driver.id)
    :ok = Requests.create(as_map(rider2), driver.id)

    results =
      [rider1.id, rider2.id]
      |> Enum.map(fn rid -> Task.async(fn -> Requests.accept(as_map(driver), rid) end) end)
      |> Task.await_many()

    oks = Enum.count(results, &match?({:ok, _}, &1))
    assert oks == 1

    # exactly one ride exists; the losing rider's request is DECLINED, never
    # put back — a busy driver keeps nobody waiting (offline-means-unavailable)
    assert is_binary(Rides.ride_id_of_user(driver.id))
    loser = Enum.find([rider1, rider2], fn r -> Rides.ride_id_of_user(r.id) == nil end)
    assert Requests.open_request_of(loser.id) == nil
  end

  test "parallel duplicate requests: one wins, one is refused", %{a: rider, c: driver} do
    on_map(driver)

    results =
      [1, 2]
      |> Enum.map(fn _ -> Task.async(fn -> Requests.create(as_map(rider), driver.id) end) end)
      |> Task.await_many()

    assert Enum.sort(results) == [:ok, {:error, :already_requested}]
    assert Requests.open_request_of(rider.id) != nil
  end

  test "requesting yourself is refused", %{a: a} do
    assert {:error, :self} = Requests.create(as_map(a), a.id)
  end

  test "ride start purges BOTH participants' stale geo state (pinned from fuzzer invariant)",
       %{a: r, b: waiter, c: d} do
    HoodrideWeb.Endpoint.subscribe("user:#{waiter.id}")

    # rider r carries a leftover DRIVER row (lost mode-flip), with someone waiting on it
    on_map(r)
    :ok = Requests.create(as_map(waiter), r.id)

    # driver d carries a leftover HAND row — raw insert: the Geo API itself
    # can no longer produce this state (exclusion), so this simulates corruption
    on_map(d)
    :ets.insert(:geo_hands, {d.id, "cell8x", "spot9x"})

    :ok = Requests.create(as_map(r), d.id)
    {:ok, _ride} = Requests.accept(as_map(d), r.id)

    # both ghosts are gone and the ghost's waiter was declined
    refute Hoodride.Geo.driver_on_map?(r.id)
    assert :ets.lookup(:geo_hands, d.id) == []
    assert Requests.open_request_of(waiter.id) == nil
    assert_receive %Phoenix.Socket.Broadcast{event: "request_declined", payload: %{by_id: _}}
  end

  test "the writer itself refuses geo rows for mid-ride users (race-proof guard)",
       %{a: r, c: d} do
    on_map(d)
    :ok = Requests.create(as_map(r), d.id)
    {:ok, _ride} = Requests.accept(as_map(d), r.id)

    # a position update that slipped past the channel guard dies INSIDE the
    # writer — the check runs in the serialized section, after the ride landed
    Hoodride.Geo.driver_update(as_map(r), "cell8z", nil, ["c7Z"])
    Hoodride.Geo.hand_up(r.id, "cell8z", "spot9z", ["c7Z"])

    refute Hoodride.Geo.driver_on_map?(r.id)
    assert :ets.lookup(:geo_hands, r.id) == []
    assert Hoodride.Geo.agg_counts_for("c7Z") == %{drivers: 0, hands: 0}
  end

  test "supply and demand are mutually exclusive, server-enforced", %{a: u, b: waiter} do
    HoodrideWeb.Endpoint.subscribe("user:#{waiter.id}")

    # hand → car: the ✋ dies the moment you broadcast as a driver
    Hoodride.Geo.hand_up(u.id, "cell8", "spot9")
    on_map(u)
    assert :ets.lookup(:geo_hands, u.id) == []
    assert Hoodride.Geo.driver_on_map?(u.id)

    # car → hand: the 🚗 dies with full unavailability semantics —
    # whoever was waiting on it is declined
    :ok = Requests.create(as_map(waiter), u.id)
    Hoodride.Geo.hand_up(u.id, "cell8", "spot9")
    refute Hoodride.Geo.driver_on_map?(u.id)
    assert [{_, "cell8", "spot9"}] = :ets.lookup(:geo_hands, u.id)
    assert Requests.open_request_of(waiter.id) == nil
    assert_receive %Phoenix.Socket.Broadcast{event: "request_declined", payload: %{by_id: _}}
  end

  test "mutual requests: accepting one auto-cancels the acceptor's own outgoing ask",
       %{a: a, b: b} do
    # the fuzzer's shrunk counterexample, pinned as a regression test
    HoodrideWeb.Endpoint.subscribe("user:#{b.id}")
    on_map(a)
    on_map(b)
    :ok = Requests.create(as_map(a), b.id)
    :ok = Requests.create(as_map(b), a.id)

    {:ok, _ride} = Requests.accept(as_map(a), b.id)

    # a is driving now; a's outgoing request to b must be gone, b notified
    assert Requests.open_request_of(a.id) == nil
    assert_receive %Phoenix.Socket.Broadcast{event: "request_cancelled", payload: %{from_id: _}}
  end

  # ===== authorization corners =====

  test "a stranger cannot join someone else's ride topic", %{a: r, b: d, c: stranger} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)

    {:ok, sock} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(stranger.id)}
      )

    assert {:error, %{reason: "not_yours"}} = subscribe_and_join(sock, "ride:#{ride_id}", %{})
  end

  test "a session pointing at a deleted/unknown user cannot connect at all" do
    assert :error =
             connect(HoodrideWeb.UserSocket, %{},
               connect_info: %{
                 session: %{
                   "user_id" => 999_999,
                   "user_token" => :crypto.strong_rand_bytes(32),
                   "name" => "Nobody"
                 }
               }
             )
  end

  test "mid-ride users are ignored on the browse map, whatever their client sends",
       %{a: user, b: other} do
    {:ok, _} = Rides.start_ride(user.id, other.id)

    {:ok, sock} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(sock, "user:#{user.id}", %{})

    push(chan, "driver_update", %{"cell" => "cellQ", "lat" => 1.0, "lng" => 2.0})
    push(chan, "hand_up", %{"cell" => "cellQ"})
    # sync: a replying push proves the previous casts were processed
    ref = push(chan, "cancel_request", %{})
    assert_reply ref, :ok

    assert Geo.cell_snapshot("cellQ") == %{drivers: [], hands: []}
  end

  # ===== sweeper interplay =====

  test "a chat between two ride partners survives grace expiry until the ride ends",
       %{a: r, b: d} do
    {:ok, _} = Chat.send_message(as_map(r), d.id, "omw")
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)

    # both phones dark way past grace — mid-ride, chat must survive
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})
    :ets.insert(:geo_presence, {d.id, :grace, ancient()})
    Sweeper.sweep_now()
    assert [_] = Chat.conversations_for(r.id)

    # ride over, both still gone → the room finally empties
    :ok = Rides.end_ride(ride_id, r.id)
    Sweeper.sweep_now()
    assert Chat.conversations_for(r.id) == []
  end

  test "reconnecting within grace keeps a driver on the map", %{b: d} do
    :ets.insert(
      :geo_drivers,
      {d.id, "cellR", "cellR", System.system_time(:second)}
    )

    :ets.insert(:geo_presence, {d.id, :grace, ancient()})
    # they came back before the sweep ran
    Geo.user_connected(d.id)

    Sweeper.sweep_now()
    assert [%{id: _}] = Geo.cell_snapshot("cellR").drivers
  end

  test "sweeper reclaims seats left by a brutally-killed ride process", %{a: a} do
    :ets.insert(:rides_by_user, {a.id, "r-dead-process"})
    Sweeper.sweep_now()
    assert Rides.ride_id_of_user(a.id) == nil
  end
end
