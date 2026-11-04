defmodule Hoodride.SweeperAndGuardsTest do
  @moduledoc "Time-based death rules + one-ride-at-a-time server guards."
  use ExUnit.Case

  alias Hoodride.{Chat, Geo, Requests, Rides, Sweeper}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "s-rider", name: "SR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "s-driver", name: "SD"})

    %{rider: rider, driver: driver}
  end

  defp ancient, do: System.system_time(:second) - 10_000

  test "sweeper expires stale requests and notifies both sides", %{rider: r, driver: d} do
    HoodrideWeb.Endpoint.subscribe("user:#{r.id}")
    HoodrideWeb.Endpoint.subscribe("user:#{d.id}")

    # a request from the distant past
    :ets.insert(:ride_requests, {r.id, d.id, ancient()})

    Sweeper.sweep_now()

    assert Requests.open_request_of(r.id) == nil
    assert_receive %Phoenix.Socket.Broadcast{event: "request_expired"}
    assert_receive %Phoenix.Socket.Broadcast{event: "request_expired_driver"}
  end

  test "sweeper removes drivers and hands whose owner is past grace", %{rider: r, driver: d} do
    :ets.insert(
      :geo_drivers,
      {d.id, "cellA", "cellA", System.system_time(:second)}
    )

    :ets.insert(:geo_hands, {r.id, "cellA", "spotA"})
    # both disconnected long ago
    Geo.user_disconnected(d.id)
    Geo.user_disconnected(r.id)
    :ets.insert(:geo_presence, {d.id, :grace, ancient()})
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})

    Sweeper.sweep_now()

    assert Geo.cell_snapshot("cellA") == %{drivers: [], hands: []}
  end

  test "sweeper keeps geo for users within grace", %{driver: d} do
    :ets.insert(
      :geo_drivers,
      {d.id, "cellB", "cellB", System.system_time(:second)}
    )

    Geo.user_disconnected(d.id)

    Sweeper.sweep_now()

    assert [%{id: _}] = Geo.cell_snapshot("cellB").drivers
  end

  # A conversation lives while BOTH people are around (owner's rule,
  # 2026-10-23): it dies once EITHER has been gone past grace, unless the
  # two share a ride — the same 5-minute rule that takes a car or a hand
  # off the map. (Until then it took BOTH being gone.)
  test "chat cleanup: both around → kept; EITHER gone past grace → deleted", %{
    rider: r,
    driver: d
  } do
    {:ok, _} = Chat.send_message(%{id: r.id, name: "SR", photo: nil}, d.id, "hey")

    # both around → survives
    Geo.user_connected(r.id)
    Geo.user_connected(d.id)
    Sweeper.sweep_now()
    assert [_] = Chat.conversations_for(r.id)

    # ONE long gone, the other still here → the chat goes
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})
    Sweeper.sweep_now()
    assert Chat.conversations_for(r.id) == []
    assert Chat.conversations_for(d.id) == []
  end

  test "chat cleanup: a ride's chat survives one side going quiet mid-ride", %{
    rider: r,
    driver: d
  } do
    {:ok, _ride} = Rides.start_ride(r.id, d.id)
    assert Chat.exists?(r.id, d.id)

    Geo.user_connected(d.id)
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})
    Hoodride.Sweeper.sweep_empty_room_chats()
    assert Chat.exists?(r.id, d.id)
  end

  test "chat cleanup: a request never outlives grace, so it can't protect a chat (driver gone)",
       %{rider: r, driver: d} do
    # an open request toward a driver who then vanishes: past grace their
    # car is reaped and the request declined EARLIER in the same sweep, so
    # by the time chats are judged nothing is left to protect this one
    Geo.driver_update(%{id: d.id, name: "SD", photo: nil}, "cellG", nil)
    :ok = Requests.create(r, d.id)
    {:ok, _} = Chat.send_message(%{id: r.id, name: "SR", photo: nil}, d.id, "omw?")
    Geo.user_connected(r.id)
    :ets.insert(:geo_presence, {d.id, :grace, ancient()})

    Sweeper.sweep_now()
    assert Requests.open_request_of(r.id) == nil
    assert Chat.conversations_for(r.id) == []
  end

  test "chat cleanup: a request never outlives grace, so it can't protect a chat (rider gone)",
       %{rider: r, driver: d} do
    # the rider sent the request before leaving, and requests expire five
    # minutes after they're sent — before the rider can be gone that long
    {:ok, _} = Chat.send_message(%{id: r.id, name: "SR", photo: nil}, d.id, "omw?")
    :ets.insert(:ride_requests, {r.id, d.id, ancient()})
    Geo.user_connected(d.id)
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})

    Sweeper.sweep_now()
    assert Requests.open_request_of(r.id) == nil
    assert Chat.conversations_for(r.id) == []
  end

  test "a closed chat is announced to BOTH sides (whoever is still there clears it)",
       %{rider: r, driver: d} do
    HoodrideWeb.Endpoint.subscribe("user:#{r.id}")
    HoodrideWeb.Endpoint.subscribe("user:#{d.id}")
    {:ok, _} = Chat.send_message(%{id: r.id, name: "SR", photo: nil}, d.id, "hey")
    {rid, did} = {"user:#{r.id}", "user:#{d.id}"}
    assert_receive %Phoenix.Socket.Broadcast{topic: ^did, event: "msg"}

    Geo.user_connected(d.id)
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})
    Hoodride.Sweeper.sweep_empty_room_chats()

    # each side is told WHO the chat was with
    assert_receive %Phoenix.Socket.Broadcast{
      topic: ^did,
      event: "chat_closed",
      payload: %{peer_id: peer_d}
    }

    assert_receive %Phoenix.Socket.Broadcast{
      topic: ^rid,
      event: "chat_closed",
      payload: %{peer_id: peer_r}
    }

    assert {peer_d, peer_r} == {r.id, d.id}
  end

  test "chat_closed is said once per real deletion — never for a chat that's already gone",
       %{rider: r, driver: d} do
    # listen on EVERY topic involved: ids are random, so which of a pair is
    # "a" (the lower) changes run to run — a check on one side only caught a
    # bogus notice to the other about half the time
    ghost = 9_999_999_999
    for id <- [r.id, d.id, ghost], do: HoodrideWeb.Endpoint.subscribe("user:#{id}")
    {:ok, _} = Chat.send_message(%{id: r.id, name: "SR", photo: nil}, d.id, "hey")
    key = Chat.pair_key(r.id, d.id)

    Chat.delete_conversation(key)
    Chat.delete_conversation(key)
    Chat.delete_conversation(Chat.pair_key(d.id, ghost))

    # exactly one notice per person of the real chat, nothing else at all
    assert closed_topics() == Enum.sort(["user:#{r.id}", "user:#{d.id}"])
  end

  defp closed_topics(acc \\ []) do
    receive do
      %Phoenix.Socket.Broadcast{topic: t, event: "chat_closed"} -> closed_topics([t | acc])
    after
      200 -> Enum.sort(acc)
    end
  end

  test "same-tick cascade: an aged-out request stops protecting its chat within ONE sweep",
       %{rider: r, driver: d} do
    # the scenario explained in conversation: both request and grace clocks
    # mature together — chore ordering (requests expire before chats are
    # checked) must let the chat die in the same sweep, not one tick later
    {:ok, _} = Chat.send_message(%{id: r.id, name: "SR", photo: nil}, d.id, "yo")
    :ets.insert(:ride_requests, {r.id, d.id, ancient()})
    :ets.insert(:geo_presence, {r.id, :grace, ancient()})
    :ets.insert(:geo_presence, {d.id, :grace, ancient()})

    Sweeper.sweep_now()

    assert Requests.open_request_of(r.id) == nil
    assert Chat.conversations_for(r.id) == []
  end

  test "a rider in a ride can't request; a busy driver can't accept", %{rider: r, driver: d} do
    {:ok, other} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "s-other", name: "SO"})

    {:ok, _ride} = Rides.start_ride(r.id, d.id)

    # rider mid-ride can't open a request
    assert {:error, :in_ride} = Requests.create(%{id: r.id, name: "SR", photo: nil}, other.id)

    # a third user can't request the busy driver
    assert {:error, :driver_busy} =
             Requests.create(%{id: other.id, name: "SO", photo: nil}, d.id)

    # busy driver can't accept a pending request — busy means unavailable, so
    # the request is declined with notice rather than left dangling
    HoodrideWeb.Endpoint.subscribe("user:#{other.id}")
    :ets.insert(:ride_requests, {other.id, d.id, System.system_time(:second)})
    assert {:error, :busy} = Requests.accept(%{id: d.id, name: "SD", photo: nil}, other.id)
    assert Requests.open_request_of(other.id) == nil
    assert_receive %Phoenix.Socket.Broadcast{event: "request_declined"}
  end

  test "frozen drivers are reaped: position silent past the stale limit, socket alive" do
    HoodrideWeb.Endpoint.subscribe("user:72")

    # two connected drivers: one heartbeating, one frozen for 4 minutes
    Hoodride.Geo.user_connected(70)
    Hoodride.Geo.user_connected(71)
    Hoodride.Geo.driver_update(%{id: 70, name: "Fresh", photo: nil}, "cell8p", nil, ["c7P"])

    Hoodride.Geo.driver_update(%{id: 71, name: "Frozen", photo: nil}, "cell8q", nil, ["c7Q"])

    stale = System.system_time(:second) - 4 * 60
    [{_, cell, spot, _ts}] = :ets.lookup(:geo_drivers, 71)
    :ets.insert(:geo_drivers, {71, cell, spot, stale})
    # a rider was waiting on the frozen one
    :ok = Requests.create(%{id: 72, name: "W72", photo: nil}, 71)

    Hoodride.Sweeper.sweep_now()

    # frozen: gone from street AND altitude, waiter declined; fresh: untouched
    refute Hoodride.Geo.driver_on_map?(71)
    assert Hoodride.Geo.agg_counts_for("c7Q") == %{drivers: 0, hands: 0}
    assert Requests.open_request_of(72) == nil
    assert_receive %Phoenix.Socket.Broadcast{topic: "user:72", event: "request_declined"}
    assert Hoodride.Geo.driver_on_map?(70)
    assert Hoodride.Geo.agg_counts_for("c7P") == %{drivers: 1, hands: 0}
  end

  test "the timer wiring itself sweeps (handle_info, not just sweep_now)" do
    # a reaped-looking driver: on map, no presence → one :sweep message reaps him
    Hoodride.Geo.driver_update(%{id: 81, name: "T81", photo: nil}, "cell8t", nil, ["c7T"])
    send(Process.whereis(Hoodride.Sweeper), :sweep)
    _ = :sys.get_state(Hoodride.Sweeper)
    refute Hoodride.Geo.driver_on_map?(81)
  end

  test "tests sweep on purpose: the app's own 60 s tick is off here" do
    # a tick landing mid-test reaped that test's presence-less drivers — a
    # random failure on a slow machine (2026-10-28)
    assert %{timer: nil} = :sys.get_state(Hoodride.Sweeper)
  end

  test "with an interval, the tick is scheduled — and rescheduled after each sweep" do
    pid = start_supervised!({Sweeper, every_ms: 60_000, name: :sweeper_probe})
    assert %{timer: first} = :sys.get_state(pid)
    assert Process.read_timer(first) > 0

    send(pid, :sweep)
    assert %{timer: next} = :sys.get_state(pid)
    assert next != first and Process.read_timer(next) > 0
  end

  test "heal (b): a mid-ride ghost row planted by raw corruption is swept off" do
    {:ok, r} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "hb-r", name: "HbR"})

    {:ok, d} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "hb-d", name: "HbD"})

    {:ok, _ride} = Rides.start_ride(r.id, d.id)
    Geo.user_connected(r.id)
    Geo.user_connected(d.id)

    # the writer refuses mid-ride rows, so plant them raw — the heal must still win
    :ets.insert(
      :geo_drivers,
      {d.id, "cell8g1", "cell8g1", System.system_time(:second)}
    )

    :ets.insert(:geo_hands, {r.id, "cell8g2", "spot9g2"})

    Hoodride.Sweeper.sweep_now()

    refute Hoodride.Geo.driver_on_map?(d.id)
    assert :ets.lookup(:geo_hands, r.id) == []
  end

  test "unlawful-request heal: rider-in-ride rows cancel, off-map-driver rows decline" do
    HoodrideWeb.Endpoint.subscribe("user:92")

    {:ok, r} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ul-r", name: "UlR"})

    {:ok, d} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ul-d", name: "UlD"})

    {:ok, _ride} = Rides.start_ride(r.id, d.id)
    Geo.user_connected(r.id)
    Geo.user_connected(d.id)

    # raw rows that create/accept could never produce (they raced their guards)
    now = System.system_time(:second)
    # rider r is mid-ride yet "asks" someone → heal cancels it
    :ets.insert(:ride_requests, {r.id, 777, now})
    # rider 92 waits on an off-map driver 778 → heal declines with notice
    Geo.user_connected(92)
    :ets.insert(:ride_requests, {92, 778, now})

    Hoodride.Sweeper.sweep_now()

    assert Requests.open_request_of(r.id) == nil
    assert Requests.open_request_of(92) == nil
    assert_receive %Phoenix.Socket.Broadcast{topic: "user:92", event: "request_declined"}
  end

  test "two-tab race residue heals: the parents row's role picks the winner" do
    # driver owns the parents row → the stray hand dies, count intact
    Hoodride.Geo.user_connected(61)
    Hoodride.Geo.driver_update(%{id: 61, name: "C61", photo: nil}, "cell8w", nil, ["c7W"])
    :ets.insert(:geo_hands, {61, "cell8w", "spot9w"})

    Hoodride.Sweeper.sweep_now()

    assert Hoodride.Geo.driver_on_map?(61)
    assert :ets.lookup(:geo_hands, 61) == []
    assert Hoodride.Geo.agg_counts_for("c7W") == %{drivers: 1, hands: 0}

    # hand owns the parents row → the stray car dies WITH its waiter declined
    HoodrideWeb.Endpoint.subscribe("user:63")
    Hoodride.Geo.user_connected(62)
    Hoodride.Geo.hand_up(62, "cell8v", "spot9v", ["c7V"])

    :ets.insert(
      :geo_drivers,
      {62, "cell8v", "cell8v", System.system_time(:second)}
    )

    :ok = Requests.create(%{id: 63, name: "W63", photo: nil}, 62)

    Hoodride.Sweeper.sweep_now()

    refute Hoodride.Geo.driver_on_map?(62)
    assert [{62, _, _}] = :ets.lookup(:geo_hands, 62)
    assert Hoodride.Geo.agg_counts_for("c7V") == %{drivers: 0, hands: 1}
    assert Requests.open_request_of(63) == nil
    assert_receive %Phoenix.Socket.Broadcast{topic: "user:63", event: "request_declined"}
  end
end
