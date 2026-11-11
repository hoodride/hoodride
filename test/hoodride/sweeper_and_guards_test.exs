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

  # a reap changes the map like any writer: the apps watching must HEAR it
  # (the left, the count, the role ping) — else a reaped car stays on their
  # maps, counted, and find the nearest calls it found
  test "reaps tell the watchers: the left, the count, the role" do
    alias Phoenix.Socket.Broadcast

    for t <- ~w(geo:d:cell8r agg:d:c7R geo:h:cell8s agg:h:c7S),
        do: HoodrideWeb.Endpoint.subscribe(t)

    roles = Hoodride.Roles.topic(91)
    HoodrideWeb.Endpoint.subscribe(roles)
    Geo.driver_update(%{id: 91, name: "G", photo: nil}, "cell8r", nil, ["c7R"])
    Geo.hand_up(92, "cell8s", nil, ["c7S"])
    # (their own update broadcasts: out of the way)
    assert_receive %Broadcast{topic: "geo:d:cell8r", event: "driver_update"}
    assert_receive %Broadcast{topic: "geo:h:cell8s", event: "hand_update"}
    assert_receive %Broadcast{topic: "agg:d:c7R", payload: %{drivers: 1}}
    assert_receive %Broadcast{topic: "agg:h:c7S", payload: %{hands: 1}}
    # (going online's own role ping: taken, so the next is the reap's)
    assert_receive %Broadcast{topic: ^roles, event: "changed"}

    # neither connected: past grace, both reaped
    Sweeper.sweep_now()

    assert_receive %Broadcast{topic: "geo:d:cell8r", event: "driver_left", payload: %{id: 91}}
    assert_receive %Broadcast{topic: "agg:d:c7R", event: "agg_update", payload: %{drivers: 0}}
    assert_receive %Broadcast{topic: ^roles, event: "changed"}
    assert_receive %Broadcast{topic: "geo:h:cell8s", event: "hand_left", payload: %{id: 92}}
    assert_receive %Broadcast{topic: "agg:h:c7S", event: "agg_update", payload: %{hands: 0}}
  end

  # a shard that died mid-move (the row moved, the index and messages not):
  # the repair must TELL the watchers, as the move would have — else the
  # old cell's watchers keep a ghost and the new cell's never see them
  test "the cell-index repair tells both cells' watchers (car and hand)" do
    alias Phoenix.Socket.Broadcast
    for t <- ~w(geo:d:rxA geo:d:rxB geo:h:rxC geo:h:rxD), do: HoodrideWeb.Endpoint.subscribe(t)
    Geo.driver_update(%{id: 93, name: "X", photo: nil}, "rxA", "rxA-s", [])
    Geo.hand_up(94, "rxC", "rxC-s", [])
    assert_receive %Broadcast{topic: "geo:d:rxA", event: "driver_update"}
    assert_receive %Broadcast{topic: "geo:h:rxC", event: "hand_update"}

    # the crash: rows moved, index and messages not
    [{_, _, _, ts}] = :ets.lookup(:geo_drivers, 93)
    :ets.insert(:geo_drivers, {93, "rxB", "rxB-s", ts})
    :ets.insert(:geo_hands, {94, "rxD", "rxD-s"})
    Geo.reindex_user(93)
    Geo.reindex_user(94)

    # IN ORDER: the "left" first — a "left" names only the id: sent after
    # the update, it would wipe the car that just arrived (a watcher of both)
    assert_receive %Broadcast{topic: "geo:d:" <> _} = first
    assert first.event == "driver_left", "the repair's first message: #{first.event}"
    assert_receive %Broadcast{topic: "geo:h:" <> _} = first_h
    assert first_h.event == "hand_left", "the ✋ repair's first message: #{first_h.event}"
    # (those two, put back for the exact checks below)
    send(self(), first)
    send(self(), first_h)

    assert_receive %Broadcast{topic: "geo:d:rxA", event: "driver_left", payload: rep_left}
    assert_receive %Broadcast{topic: "geo:d:rxB", event: "driver_update", payload: rep_up}
    assert Map.delete(rep_left, :json) == %{id: 93}
    assert Map.delete(rep_up, :json) == %{id: 93, cell: "rxB", spot: "rxB-s"}
    assert_receive %Broadcast{topic: "geo:h:rxC", event: "hand_left", payload: %{id: 94}}

    assert_receive %Broadcast{
      topic: "geo:h:rxD",
      event: "hand_update",
      payload: %{id: 94, cell: "rxD", spot: "rxD-s"}
    }

    # exactly the normal shapes (an app of any version reads them as an
    # ordinary move): nothing more, the json the same update encoded
    send(self(), :mark)
    Geo.driver_update(%{id: 93, name: "X", photo: nil}, "rxA", "rxA-s", [])
    Geo.driver_update(%{id: 93, name: "X", photo: nil}, "rxB", "rxB-s", [])
    assert_receive :mark
    assert_receive %Broadcast{topic: "geo:d:rxA", event: "driver_update", payload: normal_up}
    assert_receive %Broadcast{topic: "geo:d:rxA", event: "driver_left", payload: normal_left}
    assert Map.keys(normal_left) |> Enum.sort() == [:id, :json]
    assert Map.keys(normal_up) |> Enum.sort() == [:cell, :id, :json, :spot]
    assert Jason.decode!(normal_left.json) == %{"id" => 93}
    # (the rxB side of those two moves: taken too)
    assert_receive %Broadcast{topic: "geo:d:rxB", event: "driver_left"}
    assert_receive %Broadcast{topic: "geo:d:rxB", event: "driver_update"}
    # an index already right: a repair says nothing
    Geo.reindex_user(93)
    Geo.reindex_user(94)
    refute_receive %Broadcast{topic: "geo:" <> _}, 100
  end

  # a ghost index row BESIDE an intact one (a shard died after indexing the
  # new cell, before un-indexing the old): the repair's "left" for the ghost
  # cell names only the id — an app watching both cells would delete the car
  # by id though it's really there. So the repair re-announces where they
  # are, after the "left": the app ends with the car, in its real cell.
  test "a ghost index row beside the real one: after the repair's 'left', the car is announced again where it is" do
    alias Phoenix.Socket.Broadcast
    for t <- ~w(geo:d:ghA geo:d:ghB), do: HoodrideWeb.Endpoint.subscribe(t)
    Geo.driver_update(%{id: 99, name: "Gh", photo: nil}, "ghB", "ghB-s", [])
    assert_receive %Broadcast{topic: "geo:d:ghB", event: "driver_update"}
    # the ghost: indexed in A too
    :ets.insert(:geo_by_cell, {{"ghA", 99}, :driver})
    Geo.reindex_user(99)
    assert_receive %Broadcast{topic: "geo:d:ghA", event: "driver_left", payload: %{id: 99}}
    assert_receive %Broadcast{topic: "geo:d:ghB", event: "driver_update", payload: up}
    assert Map.delete(up, :json) == %{id: 99, cell: "ghB", spot: "ghB-s"}
    refute :ets.member(:geo_by_cell, {"ghA", 99})
  end

  # the repair announces only what the normal path would: never someone in
  # a ride (a claimed seat — their own "offline" follows), never a car whose
  # position went silent (reaped next) — but the index is still repaired
  test "the index repair announces no one in a ride, and no silent car" do
    alias Phoenix.Socket.Broadcast
    for t <- ~w(geo:d:rpA geo:h:rpH geo:d:rpS), do: HoodrideWeb.Endpoint.subscribe(t)
    now = System.system_time(:second)
    # in a ride (seat claimed), the index row missing
    :ets.insert(:geo_drivers, {95, "rpA", "rpA-s", now})
    :ets.insert(:geo_hands, {96, "rpH", "rpH-s"})
    :ets.insert(:rides_by_user, {95, :pending})
    :ets.insert(:rides_by_user, {96, :pending})
    # silent for 4 minutes, not in a ride
    :ets.insert(:geo_drivers, {97, "rpS", "rpS-s", now - 4 * 60})
    for id <- [95, 96, 97], do: Geo.reindex_user(id)

    refute_receive %Broadcast{topic: "geo:" <> _}, 200
    # the limit is the reap's 3 minutes: a car quiet for less (170 s) is
    # still on the map — the repair announces it
    HoodrideWeb.Endpoint.subscribe("geo:d:rpF")
    :ets.insert(:geo_drivers, {98, "rpF", "rpF-s", now - 170})
    Geo.reindex_user(98)
    assert_receive %Broadcast{topic: "geo:d:rpF", event: "driver_update"}
    assert :ets.member(:geo_by_cell, {"rpA", 95})
    assert :ets.member(:geo_by_cell, {"rpH", 96})
    assert :ets.member(:geo_by_cell, {"rpS", 97})
    for id <- [95, 96], do: :ets.delete(:rides_by_user, id)
  end

  # a message's client id is kept 10 minutes (a retry within them gets the
  # same receipt); older ones are forgotten — and swept
  test "message ids: a receipt within 10 min, none after; the sweep keeps only the fresh" do
    now = System.system_time(:second)
    :ets.insert(:chat_sent_ids, {{501, "old"}, %{id: 1, ts: now}, now - 601})
    :ets.insert(:chat_sent_ids, {{501, "edge"}, %{id: 2, ts: now}, now - 599})
    :ets.insert(:chat_sent_ids, {{501, "new"}, %{id: 3, ts: now}, now})
    assert Hoodride.Chat.sent_receipt(501, "old") == nil
    assert Hoodride.Chat.sent_receipt(501, "edge") == %{id: 2, ts: now}
    assert Hoodride.Chat.sent_receipt(501, "new") == %{id: 3, ts: now}
    assert Hoodride.Chat.sent_receipt(502, "new") == nil, "another sender's id is never theirs"
    Sweeper.sweep_now()
    assert :ets.lookup(:chat_sent_ids, {501, "old"}) == []
    assert [_] = :ets.lookup(:chat_sent_ids, {501, "new"})
  end

  # the "who's connected" phone book (the UserChannels Registry) restarting
  # empty — its connections die with it and rejoin within a second; a sweep
  # in THAT gap sees nobody connected. A presence row that says ONLINE (since
  # they opened the app) must read as "here now", never "gone since then":
  # else everyone connected over 5 min loses their car, ✋ and chats
  test "an empty phone book with an ONLINE presence row: the sweep removes nobody (online = here now)" do
    Geo.driver_update(%{id: 610, name: "On", photo: nil}, "cell8on", nil, [])
    Geo.hand_up(611, "cell8oh", nil, [])
    long_ago = System.system_time(:second) - 600
    # connected 10 min ago — their channels just died with the phone book
    :ets.insert(:geo_presence, {610, :online, long_ago})
    :ets.insert(:geo_presence, {611, :online, long_ago})
    assert Registry.lookup(Hoodride.UserChannels, 610) == []

    Sweeper.sweep_now()

    assert Geo.driver_on_map?(610), "a car whose owner was online was reaped"
    assert :ets.member(:geo_hands, 611), "a ✋ whose owner was online was reaped"
    # their grace clock started NOW (not "since they connected") …
    assert [{610, :grace, t}] = :ets.lookup(:geo_presence, 610)
    assert t >= System.system_time(:second) - 2
    # … so one truly gone (never came back) is still reaped 5 min on
    :ets.insert(:geo_presence, {610, :grace, t - 301})
    Sweeper.sweep_now()
    refute Geo.driver_on_map?(610), "gone for good: reaped after the grace"
  end

  test "the phone book really restarting: its channels go down with it (they rejoin: nothing is held without a channel)" do
    # (a private phone book set up as the app's — killing the shared one
    # would cut other tests' channels running alongside)
    book = :"phone_book_#{System.unique_integer([:positive])}"
    start_supervised!({Registry, keys: :duplicate, name: book})
    parent = self()

    pid =
      spawn(fn ->
        Registry.register(book, 613, self())
        send(parent, :in)
        Process.sleep(:infinity)
      end)

    assert_receive :in
    ref = Process.monitor(pid)
    [{_, part, _, _} | _] = Supervisor.which_children(book)
    Process.exit(part, :kill)
    assert_receive {:DOWN, ^ref, :process, ^pid, :killed}
  end

  test "really gone (a GRACE row past 5 min): still reaped — the fix spares only 'online'" do
    Geo.driver_update(%{id: 612, name: "Gone", photo: nil}, "cell8gn", nil, [])
    :ets.insert(:geo_presence, {612, :grace, System.system_time(:second) - 600})
    Sweeper.sweep_now()
    refute Geo.driver_on_map?(612)
  end

  # one step failing (a bug, every time) must never stop the steps after it:
  # sign-ins, rate rows, chats would pile up for good on a 1 GB server, and
  # the recount never run. Each failure is logged as ONE line, and skipped.
  test "a failing sweep step is logged and skipped — every later step still runs" do
    import ExUnit.CaptureLog
    me = self()
    ran = fn name -> fn -> send(me, {:ran, name}) end end

    log =
      capture_log(fn ->
        :ok =
          Sweeper.run_steps([
            {:first, ran.(:first)},
            {:raises, fn -> raise "boom" end},
            {:throws, fn -> throw(:oops) end},
            {:exits, fn -> exit(:gone) end},
            {:last, ran.(:last)}
          ])
      end)

    assert_received {:ran, :first}
    assert_received {:ran, :last}
    assert log =~ "sweep step raises failed: RuntimeError at"
    # (the error's text is never logged: it can echo a user id or a cell)
    refute log =~ "boom"
    assert log =~ "sweep step throws failed:"
    assert log =~ "sweep step exits failed:"
  end

  test "a failed step's line names the failure, never the data it failed on (a user id, a cell)" do
    import ExUnit.CaptureLog

    log =
      capture_log(fn ->
        Sweeper.run_steps([
          {:matches, fn -> {:ok, _} = Enum.random([{123_456, "8928308280fffff"}]) end},
          {:exits, fn -> exit({:reindex, 654_321}) end}
        ])
      end)

    assert log =~ "sweep step matches failed: MatchError at"
    assert log =~ "sweep step exits failed: exit at"
    refute log =~ "123456"
    refute log =~ "8928308280fffff"
    refute log =~ "654321"
  end

  test "the sweep runs every step, in order (none lost in the move to a list)" do
    names = Enum.map(Sweeper.steps(), &elem(&1, 0))

    assert names ==
             ~w(expire_stale_requests heal_orphan_ride_slots sweep_stale_geo heal_geo_consistency
             heal_unlawful_requests requests_heal_index sweep_empty_room_chats chat_heal_index chat_sent_ids
             rate_budget sign_in_failures sign_outs session_tokens session_stamps rebuild_members
             recompute_aggregates)a

    assert Enum.all?(Sweeper.steps(), fn {_, f} -> is_function(f, 0) end)
  end

  # the REPAIR LOG: each real repair (a fix of something that should never
  # be) is ONE warning line, "repair: WHAT ×N" — a non-empty repair log means
  # a bug somewhere; normal clean-ups (gone past grace) log nothing
  describe "the repair log" do
    import ExUnit.CaptureLog

    test "a normal sweep — someone gone past grace reaped — logs no repair" do
      Geo.driver_update(%{id: 620, name: "G", photo: nil}, "cell8rl", nil, [])
      :ets.insert(:geo_presence, {620, :grace, System.system_time(:second) - 600})
      # silent 4 min BECAUSE they left (no channel): the normal reap, not a
      # "frozen car"
      Geo.driver_update(%{id: 627, name: "S", photo: nil}, "cell8sl", nil, [])
      [{_, c, sp, _}] = :ets.lookup(:geo_drivers, 627)
      :ets.insert(:geo_drivers, {627, c, sp, System.system_time(:second) - 240})
      :ets.insert(:geo_presence, {627, :grace, System.system_time(:second) - 240})
      log = capture_log(fn -> Sweeper.sweep_now() end)
      refute log =~ "repair:"
      refute Geo.driver_on_map?(627)
    end

    test "a repair is logged once — the next sweep, with nothing to fix, logs nothing" do
      Registry.register(Hoodride.UserChannels, 628, self())
      Geo.user_connected(628)
      Geo.driver_update(%{id: 628, name: "T", photo: nil}, "cell8t1", nil, [])
      :ets.insert(:geo_hands, {628, "cell8t1", nil})
      assert capture_log(fn -> Sweeper.sweep_now() end) =~ "repair: car and ✋ at once ×1"
      refute capture_log(fn -> Sweeper.sweep_now() end) =~ "repair:"
    end

    test "a ✋ alone in a ride; a membership row missing; a count row missing: each a repair" do
      for id <- [629, 634], do: Registry.register(Hoodride.UserChannels, id, self())
      for id <- [629, 634], do: Geo.user_connected(id)
      # a ✋ (no car) of someone in a ride (a stand-in ride answering)
      me = self()

      ride =
        spawn(fn ->
          Registry.register(Hoodride.Rides.Registry, "ride-h", nil)
          send(me, :up)

          (fn loop ->
             receive do
               {:"$gen_call", from, :get_state} ->
                 GenServer.reply(from, %{id: "ride-h"})
                 loop.(loop)
             end
           end).(fn l -> l.(l) end)
        end)

      assert_receive :up
      Geo.hand_up(629, "cell8h2", nil, [])
      :ets.insert(:rides_by_user, {629, "ride-h"})
      # a car whose membership row and count row went missing
      Geo.driver_update(%{id: 634, name: "M", photo: nil}, "cell8m1", nil, ["c7-mm"])
      :ets.delete(:geo_members, {"c7-mm", 634})
      :ets.delete(:geo_agg, "c7-mm")

      log = capture_log(fn -> Sweeper.sweep_now() end)
      assert log =~ "repair: on the map mid-ride ×1", log
      assert log =~ "repair: membership drift ×1", log
      assert log =~ "repair: hex count ×1", log
      :ets.delete(:rides_by_user, 629)
      Process.exit(ride, :kill)
    end

    test "each kind of repair: one line naming it, with its count" do
      now = System.system_time(:second)
      # car AND ✋ at once
      Geo.user_connected(621)
      Registry.register(Hoodride.UserChannels, 621, self())
      Geo.driver_update(%{id: 621, name: "B", photo: nil}, "cell8b1", nil, [])
      :ets.insert(:geo_hands, {621, "cell8b1", nil})
      # on the map mid-ride
      Geo.user_connected(622)
      Registry.register(Hoodride.UserChannels, 622, self())
      Geo.driver_update(%{id: 622, name: "R", photo: nil}, "cell8r1", nil, [])
      # (a live ride: a stand-in answering as the ride's process does)
      me = self()

      ride =
        spawn(fn ->
          Registry.register(Hoodride.Rides.Registry, "ride-x", nil)
          send(me, :ride_up)

          (fn loop ->
             receive do
               {:"$gen_call", from, :get_state} ->
                 GenServer.reply(from, %{id: "ride-x"})
                 loop.(loop)
             end
           end).(fn l -> l.(l) end)
        end)

      assert_receive :ride_up
      :ets.insert(:rides_by_user, {622, "ride-x"})
      # a seat whose ride is gone (its process killed): an orphaned ride
      :ets.insert(:rides_by_user, {626, "ride-gone"})
      # cell index drift
      Geo.user_connected(623)
      Registry.register(Hoodride.UserChannels, 623, self())
      Geo.driver_update(%{id: 623, name: "D", photo: nil}, "cell8d1", nil, [])
      :ets.delete(:geo_by_cell, {"cell8d1", 623})
      # a frozen car (connected, silent 4 min)
      Geo.user_connected(624)
      Registry.register(Hoodride.UserChannels, 624, self())
      Geo.driver_update(%{id: 624, name: "F", photo: nil}, "cell8f1", nil, [])
      [{_, c, sp, _}] = :ets.lookup(:geo_drivers, 624)
      :ets.insert(:geo_drivers, {624, c, sp, now - 240})
      # online, yet in no channel
      Geo.driver_update(%{id: 625, name: "O", photo: nil}, "cell8o1", nil, [])
      :ets.insert(:geo_presence, {625, :online, now - 600})

      log = capture_log(fn -> Sweeper.sweep_now() end)

      for what <- [
            "car and ✋ at once",
            "on the map mid-ride",
            "frozen car",
            "online without a channel",
            "orphaned ride"
          ],
          do: assert(log =~ "repair: #{what} ×1", "missing: #{what}
#{log}")

      # (the car-and-✋ setup's hand had no index row either: two drifted)
      assert log =~ ~r/repair: cell index drift ×\d+/, log

      :ets.delete(:rides_by_user, 622)
      Process.exit(ride, :kill)
    end

    test "a wrong hex count, a stray chat index row, a missing request index row: each healed, each logged" do
      now = System.system_time(:second)
      # a count that says 7 cars where there are none
      :ets.insert(:geo_agg, {"c7-wrong", 7, 0})
      # a chat index row with no conversation behind it
      :ets.insert(:chat_by_user, {{630, {630, 631}}})
      # an open request missing from the by-driver index
      :ets.insert(:ride_requests, {632, 633, now})
      Registry.register(Hoodride.UserChannels, 633, self())
      Geo.user_connected(633)
      Geo.driver_update(%{id: 633, name: "Q", photo: nil}, "cell8q1", nil, [])
      log = capture_log(fn -> Sweeper.sweep_now() end)
      assert log =~ "repair: hex count ×1", log
      assert log =~ "repair: chat index ×1", log
      assert log =~ "repair: request index ×1", log
      :ets.delete(:ride_requests, 632)
    end
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

    log = ExUnit.CaptureLog.capture_log(fn -> Hoodride.Sweeper.sweep_now() end)
    # (the repair log: one cancel, one decline)
    assert log =~ "repair: unlawful request ×2", log

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
