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

  # ===== the bug list's request races (2026-11-13; fixed 2026-11-22) =====

  # every request word that reached the subscribed driver, in order
  # (everything's sent by the time create/4 returns)
  defp driver_events(acc \\ []) do
    receive do
      %Phoenix.Socket.Broadcast{event: e} when e in ["request", "request_cancelled"] ->
        driver_events([e | acc])
    after
      50 -> Enum.reverse(acc)
    end
  end

  describe "races" do
    setup do
      on_exit(fn -> Application.delete_env(:hoodride, :requests_hook) end)
      :ok
    end

    # a Decline is for the request the driver SAW: one sent while a newer
    # request replaced it (the first expired, the rider asked again — the
    # Decline was on its way, or queued on a bad connection) never wipes
    # the newer one
    test "a late Decline for an older request leaves the newer one" do
      HoodrideWeb.Endpoint.subscribe("user:11")
      on_map(22)
      :ok = Requests.create(rider(11), 22)
      %{ts: now} = Requests.open_request_of(11)

      # the older request's own stamp (expired seconds ago)
      assert {:error, :none} = Requests.decline(22, 11, now - 5)
      assert %{driver_id: 22, ts: ^now} = Requests.open_request_of(11)
      refute_receive %Phoenix.Socket.Broadcast{event: "request_declined"}, 50

      # the newer one's own stamp: declined
      assert :ok = Requests.decline(22, 11, now)
      assert Requests.open_request_of(11) == nil
      assert_receive %Phoenix.Socket.Broadcast{event: "request_declined"}
    end

    test "the request's stamp reaches the driver: live, and in the waiting list" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)
      :ok = Requests.create(rider(11), 22)
      %{ts: ts} = Requests.open_request_of(11)
      assert_receive %Phoenix.Socket.Broadcast{event: "request", payload: %{req: ^ts}}
      assert [%{rider_id: 11, ts: ^ts}] = Requests.pending_for_driver(22)
    end

    # the rider's own ride started (another driver's Accept) between the
    # "in a ride?" check and the save: withdrawn, never shown — the
    # starting ride's cancel looked before the save and found nothing
    test "a request saved just as the rider's ride starts: withdrawn, never announced" do
      HoodrideWeb.Endpoint.subscribe("user:33")
      on_map(33)

      seat_taken = fn ->
        :ets.insert(:rides_by_user, {11, "r-test-11-22"})
        true
      end

      assert {:error, :in_ride} = Requests.create(rider(11), 33, nil, seat_taken)
      assert Requests.open_request_of(11) == nil
      assert Requests.pending_for_driver(33) == []
      refute_receive %Phoenix.Socket.Broadcast{event: "request"}, 50
    end

    # signed out between the save's checks and its announcement: the
    # sign-out's own cancel told the driver FIRST, then "request" arrived —
    # a request on the driver's screen that no longer exists
    test "cancelled between its checks and its announcement: the driver's last word is cancelled" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :saved -> Requests.cancel(11)
        _ -> nil
      end)

      :ok = Requests.create(rider(11), 22)
      assert Requests.pending_for_driver(22) == []

      events = driver_events()
      assert "request" in events
      assert List.last(events) == "request_cancelled", inspect(events)
    end

    # the review's concern 1 (2026-11-22): an Accept took it in that same
    # moment (the driver had it from their waiting list) — a ride is
    # starting, not a cancel: no "request_cancelled" after the "request"
    test "accepted between its checks and its announcement: no cancel after it" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :saved ->
          # as accept/3 does: marked at work, then the request taken
          :ets.insert(:ride_requests_accepting, {11, {self(), make_ref()}})
          :ets.delete(:ride_requests, 11)

        _ ->
          nil
      end)

      :ok = Requests.create(rider(11), 22)
      refute "request_cancelled" in driver_events()
    end

    test "its ride with this same driver starting by the announcement: no cancel either" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :saved ->
          claim = "r-test-11-22"
          :ets.insert(:rides_by_user, [{11, claim}, {22, claim}])
          :ets.delete(:ride_requests, 11)

        _ ->
          nil
      end)

      :ok = Requests.create(rider(11), 22)
      refute "request_cancelled" in driver_events()
    end

    # concern 2: the ride that started between the checks is with THIS
    # driver (their Accept took this very request): it went through — not
    # "finish your ride first"
    test "the rider's ride that started meanwhile is with this driver: :ok, nothing withdrawn" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      accepted = fn ->
        claim = "r-test-11-22"
        :ets.insert(:rides_by_user, [{11, claim}, {22, claim}])
        :ets.delete(:ride_requests, 11)
        true
      end

      assert :ok = Requests.create(rider(11), 22, nil, accepted)
      refute "request_cancelled" in driver_events()
    end

    # (second review, 2026-11-22) a second request to the same driver —
    # another tab — saved as that driver's Accept of the first started
    # their ride: nothing left standing during the ride
    test "saved as a ride with this same driver starts: :ok, and no request left standing" do
      on_map(22)

      accepted = fn ->
        claim = "r-test-11-22"
        :ets.insert(:rides_by_user, [{11, claim}, {22, claim}])
        true
      end

      assert :ok = Requests.create(rider(11), 22, nil, accepted)
      assert Requests.open_request_of(11) == nil
      assert Requests.pending_for_driver(22) == []
    end

    # (third review, 2026-11-22) that ride with this driver starting takes
    # the car off the map too: "offline" was found first — the rider told
    # "gone offline" as their ride opened
    test "a ride with this same driver starting, the car off the map: still :ok, not offline" do
      on_map(22)

      # between create/4's checks and the save: the Accept's seats claimed,
      # the ride's start taking the car off the map
      Application.put_env(:hoodride, :requests_hook, fn
        :saving ->
          claim = "r-test-11-22"
          :ets.insert(:rides_by_user, [{11, claim}, {22, claim}])
          Hoodride.Geo.driver_offline_now(22)

        _ ->
          nil
      end)

      assert :ok = Requests.create(rider(11), 22)
      assert Requests.open_request_of(11) == nil
      assert Requests.pending_for_driver(22) == []
    end

    # (fourth review) the same, landing just AFTER the save's first look:
    # every later look asks "together?" too, never "offline"/"busy"
    test "that ride starting just after the first look: still :ok, not offline" do
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :looked ->
          claim = "r-test-11-22"
          :ets.insert(:rides_by_user, [{11, claim}, {22, claim}])
          Hoodride.Geo.driver_offline_now(22)

        _ ->
          nil
      end)

      assert :ok = Requests.create(rider(11), 22)
      assert Requests.open_request_of(11) == nil
      assert Requests.pending_for_driver(22) == []
    end

    # (third review) an Accept whose ride couldn't start puts the request
    # back — its index row too: a second request in that moment (another
    # tab) had replaced and removed it, and the driver's list missed it
    test "a request put back by an Accept that couldn't start is in the driver's list again" do
      on_map(22)
      :ok = Requests.create(rider(11), 22)

      Application.put_env(:hoodride, :requests_hook, fn
        # the index row gone meanwhile (as a second request's take-back does)
        :taken -> :ets.delete(:requests_by_driver, {22, 11})
        :start -> {:error, :boom}
        _ -> nil
      end)

      assert {:error, _} = Requests.accept(%{id: 22, name: "D22", photo: nil}, 11)
      assert %{driver_id: 22} = Requests.open_request_of(11)
      assert [%{rider_id: 11}] = Requests.pending_for_driver(22)
    end

    # (fourth review) the put-back finding the slot taken (the rider asked
    # another driver meantime): its own index row goes too — never one left
    # pointing at nothing for the repair pass to find
    test "a put-back that finds the slot taken leaves no index row behind" do
      on_map(22)
      :ok = Requests.create(rider(11), 22)

      Application.put_env(:hoodride, :requests_hook, fn
        :taken -> :ets.insert(:ride_requests, {11, 33, System.monotonic_time(:second)})
        :start -> {:error, :boom}
        _ -> nil
      end)

      assert {:error, _} = Requests.accept(%{id: 22, name: "D22", photo: nil}, 11)
      assert %{driver_id: 33} = Requests.open_request_of(11)
      assert :ets.lookup(:requests_by_driver, {22, 11}) == []
    end

    # (seventh review, 2026-11-22) this driver's Accept at work when the
    # announcement looks, its ride started (and its mark gone) before the
    # seats are read: still no "cancelled" — "Accept at work" is read
    # BEFORE the seats (the other order missed both)
    test "an Accept finishing between the 'at work' look and the seats look: no cancel" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)
      work = {self(), make_ref()}

      Application.put_env(:hoodride, :requests_hook, fn
        :saved ->
          # this driver's Accept at work, the request taken
          :ets.insert(:ride_requests_accepting, {11, work})
          :ets.delete(:ride_requests, 11)

        :resend_reads ->
          # …its ride started, its mark gone
          :ets.insert(:rides_by_user, [{11, "r-11-22"}, {22, "r-11-22"}])
          :ets.delete_object(:ride_requests_accepting, {11, work})

        _ ->
          nil
      end)

      :ok = Requests.create(rider(11), 22)
      refute "request_cancelled" in driver_events()
    end

    # (eighth review, 2026-11-22) a ride takes its two seats over one at a
    # time: for an instant the rider's seat has the ride and the driver's
    # still the claim. That is THIS pair's ride, never "another ride"
    test "the announcement during the seats' takeover (half done): no cancel" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :saved ->
          :ets.insert(:ride_requests_accepting, {11, {self(), make_ref()}})
          :ets.delete(:ride_requests, 11)

        :resend_reads ->
          :ets.insert(:rides_by_user, [{11, "r-11-22"}, {22, {:pending, self(), 11, 22}}])

        _ ->
          nil
      end)

      :ok = Requests.create(rider(11), 22)
      refute "request_cancelled" in driver_events()
    end

    test "a save during the seats' takeover (half done), the car off the map: :ok, not offline" do
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :looked ->
          :ets.insert(:rides_by_user, [{11, {:pending, self(), 11, 22}}, {22, "r-11-22"}])
          Hoodride.Geo.driver_offline_now(22)

        _ ->
          nil
      end)

      assert :ok = Requests.create(rider(11), 22)
      assert Requests.open_request_of(11) == nil
    end

    # (full review, 2026-11-22) an Accept that failed and put the request
    # back between the announcement's first two reads: it stands — no
    # "cancelled" for a request that's there
    test "put back by a failed Accept between the announcement's reads: no cancel" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)
      work = {self(), make_ref()}

      Application.put_env(:hoodride, :requests_hook, fn
        :saved ->
          # this driver's Accept at work, the request taken
          [row] = :ets.lookup(:ride_requests, 11)
          Process.put(:taken_row, row)
          :ets.insert(:ride_requests_accepting, {11, work})
          :ets.delete(:ride_requests, 11)

        :resend_gone ->
          # …its start failed: the request put back, its mark gone
          :ets.insert(:ride_requests, Process.get(:taken_row))
          :ets.delete_object(:ride_requests_accepting, {11, work})

        _ ->
          nil
      end)

      :ok = Requests.create(rider(11), 22)
      refute "request_cancelled" in driver_events()
      assert %{driver_id: 22} = Requests.open_request_of(11)
    end

    # (sixth review, 2026-11-22) cancelled before its announcement by the
    # rider's ride with ANOTHER driver starting (whose Accept was at work):
    # the driver must still hear "cancelled" last — it stayed on their
    # screen until a reload
    test "cancelled by the rider's ride with another driver: the driver's last word is cancelled" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      Application.put_env(:hoodride, :requests_hook, fn
        :saved ->
          # driver 33's Accept at work, its ride started, its start-up's
          # cancel of the rider's other request (this one) done
          :ets.insert(:ride_requests_accepting, {11, {self(), make_ref()}})
          :ets.insert(:rides_by_user, [{11, "r-11-33"}, {33, "r-11-33"}])
          Requests.cancel(11)

        _ ->
          nil
      end)

      :ok = Requests.create(rider(11), 22)
      assert List.last(driver_events()) == "request_cancelled"
    end

    # (sixth review) an Accept whose start failed puts the request back —
    # not toward a driver who went offline meanwhile (their going offline
    # found nothing to decline: the Accept held it). Declined at once, never
    # left waiting for the sweeper's next pass (a minute)
    test "a put-back toward a driver gone offline meanwhile: declined, the rider told" do
      HoodrideWeb.Endpoint.subscribe("user:11")
      on_map(22)
      :ok = Requests.create(rider(11), 22)

      Application.put_env(:hoodride, :requests_hook, fn
        :taken -> Hoodride.Geo.driver_offline_now(22)
        :start -> {:error, :boom}
        _ -> nil
      end)

      assert {:error, _} = Requests.accept(%{id: 22, name: "D22", photo: nil}, 11)
      assert Requests.open_request_of(11) == nil
      assert Requests.pending_for_driver(22) == []
      assert_receive %Phoenix.Socket.Broadcast{event: "request_declined"}
    end

    # the DRIVER's ride started (another rider) between create/4's check and
    # the save: withdrawn, never shown to a driver mid-ride
    test "a request saved just as the driver's ride starts: withdrawn, never announced" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      driver_taken = fn ->
        claim = "r-test-44-22"
        :ets.insert(:rides_by_user, [{44, claim}, {22, claim}])
        true
      end

      assert {:error, :driver_busy} = Requests.create(rider(11), 22, nil, driver_taken)
      assert Requests.open_request_of(11) == nil
      assert Requests.pending_for_driver(22) == []
      refute "request" in driver_events()
    end

    # (fifth review, 2026-11-22) seats only CLAIMED — a ride still starting,
    # which can still fail — count for nothing after the save: the request
    # stands (if that start succeeds, its own start-up withdraws it; if it
    # fails, the rider still has their request — never left with none)
    test "a ride still starting (seats claimed, not started): the request stands" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      claimed = fn ->
        claim = {:pending, self(), 11, 22}
        :ets.insert(:rides_by_user, [{11, claim}, {22, claim}])
        true
      end

      assert :ok = Requests.create(rider(11), 22, nil, claimed)
      assert %{driver_id: 22} = Requests.open_request_of(11)
      assert [%{rider_id: 11}] = Requests.pending_for_driver(22)
      assert driver_events() == ["request"]
    end

    # withdrawn at the save (signed out meanwhile): it was listed for the
    # driver for that moment (/api/state) — they're told it's gone
    test "withdrawn at the save: the driver is told, in case they listed it" do
      HoodrideWeb.Endpoint.subscribe("user:22")
      on_map(22)

      signed_out = fn ->
        assert [%{rider_id: 11}] = Requests.pending_for_driver(22)
        false
      end

      assert {:error, :signed_out} = Requests.create(rider(11), 22, nil, signed_out)
      assert Requests.pending_for_driver(22) == []

      assert_receive %Phoenix.Socket.Broadcast{
        event: "request_cancelled",
        payload: %{from_id: 11}
      }

      refute_receive %Phoenix.Socket.Broadcast{event: "request"}, 50
    end
  end
end
