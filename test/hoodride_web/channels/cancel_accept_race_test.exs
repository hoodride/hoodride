defmodule HoodrideWeb.CancelAcceptRaceTest do
  @moduledoc """
  A rider's Cancel that lands just AFTER the driver's Accept (leftovers
  review, 2026-11-13): the request is already gone — taken by the Accept,
  the ride starting — but Cancel answered "ok" anyway, and the app said
  "Request cancelled" just before the ride opened, the driver on the way.
  Now the answer says the driver already accepted (the app then lets the
  ride arrive: test_browser/cancelrace.mjs). A Cancel with nothing to
  cancel and no ride is still "ok" (nothing to undo).
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  @cell "882a1072c7fffff"
  @car_spot "892a1072c63ffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "car-r", name: "CarR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "car-d", name: "CarD"})

    :ok = Hoodride.TestHelpers.give_car(driver.id)
    %{rider: rider, driver: driver}
  end

  defp connect_as(user) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    socket
  end

  defp requested(rider, driver) do
    rsock = connect_as(rider)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(connect_as(driver), "user:#{driver.id}", %{})
    push(dchan, "driver_update", %{"spot" => @car_spot})
    # (a replying push: the car is on the map before the rider looks)
    ref = push(dchan, "cancel_request", %{})
    assert_reply ref, :ok
    {:ok, _, world} = subscribe_and_join(rsock, "world", %{})
    ref = push(world, "sync", %{"geo" => [@cell]})
    assert_reply ref, :ok
    ref = push(rchan, "request_ride", %{"to" => driver.id})
    assert_reply ref, :ok
    {rchan, dchan}
  end

  test "Cancel just after the Accept: 'the driver already accepted', and the ride stands",
       %{rider: rider, driver: driver} do
    {rchan, dchan} = requested(rider, driver)
    ref = push(dchan, "accept_request", %{"rider_id" => rider.id})
    assert_reply ref, :ok

    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :error, %{reason: "accepted"}
    assert is_binary(Hoodride.Rides.ride_id_of_user(rider.id))
  end

  test "Cancel before the Accept: cancelled, as always", %{rider: rider, driver: driver} do
    {rchan, _dchan} = requested(rider, driver)
    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :ok
    assert :ets.lookup(:ride_requests, rider.id) == []
  end

  # (the 2026-11-08 server review's note, still open until 2026-11-20) the
  # Accept TAKES the request, then claims the seats: a Cancel in between
  # found neither — "ok", the app said "Request cancelled", then the ride
  # opened. Now the Accept leaves a mark while it works; a Cancel that finds
  # nothing but the mark waits for it, then answers by what it did
  describe "a Cancel landing INSIDE the Accept" do
    setup do
      on_exit(fn -> Application.delete_env(:hoodride, :requests_hook) end)
      :ok
    end

    # the Accept pauses after taking the request (and, given, its ride start
    # answers `start_result` instead of starting one)
    defp pause_accept(start_result \\ nil) do
      me = self()

      Application.put_env(:hoodride, :requests_hook, fn
        :taken ->
          send(me, {:paused, self()})
          receive do: (:go -> :ok)

        :start ->
          start_result

        _ ->
          nil
      end)
    end

    test "the ride then starts: 'the driver already accepted' — never 'cancelled'",
         %{rider: rider, driver: driver} do
      {rchan, dchan} = requested(rider, driver)
      pause_accept()
      accept = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_receive {:paused, acceptor}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      # (it waits for the Accept: no answer while it's paused)
      refute_reply cancel, _, _, 200
      send(acceptor, :go)
      assert_reply accept, :ok
      assert_reply cancel, :error, %{reason: "accepted"}, 2_000
      assert is_binary(Hoodride.Rides.ride_id_of_user(rider.id))
    end

    test "the ride then can't start (put back): the Cancel cancels it — never lost",
         %{rider: rider, driver: driver} do
      {rchan, dchan} = requested(rider, driver)
      pause_accept({:error, :failed})
      accept = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_receive {:paused, acceptor}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      # (the Cancel handled WHILE the Accept is paused: it waits for it — it
      # answered "ok" at once, then the request was put back, the Cancel lost)
      refute_reply cancel, _, _, 200
      send(acceptor, :go)
      assert_reply accept, :error, _
      assert_reply cancel, :ok, _, 2_000

      assert :ets.lookup(:ride_requests, rider.id) == [],
             "the request stood again: the Cancel lost"

      assert Hoodride.Rides.ride_id_of_user(rider.id) == nil
    end

    # (2026-11-20) an Accept still at work when the Cancel's wait ran out (a
    # database stalled past it): no request, no ride YET — "ok", the app
    # said "Request cancelled", and the ride started a moment later
    test "the Accept outlasts the wait: 'the driver already accepted' — never 'cancelled'",
         %{rider: rider, driver: driver} do
      Application.put_env(:hoodride, :accept_wait_ms, 100)
      on_exit(fn -> Application.delete_env(:hoodride, :accept_wait_ms) end)
      {rchan, dchan} = requested(rider, driver)
      pause_accept()
      accept = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_receive {:paused, acceptor}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      # (the wait runs out while the Accept is still paused)
      assert_reply cancel, :error, %{reason: "accepted"}, 2_000
      send(acceptor, :go)
      assert_reply accept, :ok
      assert is_binary(Hoodride.Rides.ride_id_of_user(rider.id))
    end

    # (review, 2026-11-20) …and then the ride couldn't start: the request
    # was put back — the rider, told "accepted", reloaded to no request,
    # while the driver could accept it again: a ride they'd cancelled
    test "the Accept outlasts the wait, then fails: the Cancel still cancels it — never put back",
         %{rider: rider, driver: driver} do
      Application.put_env(:hoodride, :accept_wait_ms, 100)
      on_exit(fn -> Application.delete_env(:hoodride, :accept_wait_ms) end)
      {rchan, dchan} = requested(rider, driver)
      pause_accept({:error, :failed})
      accept = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_receive {:paused, acceptor}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      assert_reply cancel, :error, %{reason: "accepted"}, 2_000
      send(acceptor, :go)
      assert_reply accept, :error, _

      assert :ets.lookup(:ride_requests, rider.id) == [],
             "the request stood again: the Cancel lost"

      # (the driver told: it's off their list)
      assert_push "request_cancelled", %{from_id: from}
      assert from == rider.id
      assert Hoodride.Rides.ride_id_of_user(rider.id) == nil
    end

    # (review, 2026-11-20) the Cancel's mark was the rider's: ANOTHER Accept
    # on them (a stale card, a second socket) ending first wiped it — the
    # stalled one, failing, put the request back after all
    test "another Accept on the rider meanwhile: the stalled one, failing, still cancels",
         %{rider: rider, driver: driver} do
      Application.put_env(:hoodride, :accept_wait_ms, 100)
      on_exit(fn -> Application.delete_env(:hoodride, :accept_wait_ms) end)
      {rchan, dchan} = requested(rider, driver)
      pause_accept({:error, :failed})
      accept = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_receive {:paused, acceptor}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      assert_reply cancel, :error, %{reason: "accepted"}, 2_000

      {:ok, other} =
        Hoodride.Accounts.upsert_oauth_user(%{
          provider: "dev",
          provider_id: "car-o",
          name: "CarO"
        })

      assert {:error, _} = Hoodride.Requests.accept(other, rider.id)
      send(acceptor, :go)
      assert_reply accept, :error, _

      assert :ets.lookup(:ride_requests, rider.id) == [],
             "the request stood again: the Cancel lost"
    end

    # (review, 2026-11-20) a stalled Accept KILLED (its clean-up never ran)
    # left the Cancel's mark: the rider's NEXT request, its Accept failing,
    # was cancelled by it — nobody had asked
    test "a stalled Accept killed: its Cancel's mark never cancels a later request",
         %{rider: rider, driver: driver} do
      Application.put_env(:hoodride, :accept_wait_ms, 100)
      on_exit(fn -> Application.delete_env(:hoodride, :accept_wait_ms) end)
      {rchan, _dchan} = requested(rider, driver)
      pause_accept({:error, :failed})
      first = spawn(fn -> Hoodride.Requests.accept(driver, rider.id) end)
      assert_receive {:paused, ^first}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      assert_reply cancel, :error, %{reason: "accepted"}, 2_000
      ref = Process.monitor(first)
      Process.exit(first, :kill)
      assert_receive {:DOWN, ^ref, :process, ^first, :killed}
      # (what the kill left: the request taken, never put back)
      :ets.delete(:requests_by_driver, {driver.id, rider.id})

      ref = push(rchan, "request_ride", %{"to" => driver.id})
      assert_reply ref, :ok

      Application.put_env(:hoodride, :requests_hook, fn
        :start -> {:error, :failed}
        _ -> nil
      end)

      assert {:error, :failed} = Hoodride.Requests.accept(driver, rider.id)

      assert [{_, driver_id, _}] = :ets.lookup(:ride_requests, rider.id),
             "the later request, its Accept failing, should stand again"

      assert driver_id == driver.id
    end

    # every pause point stops and waits for :go (the test steps each one);
    # a ride start answers `start_result`
    defp stepwise(start_result) do
      me = self()

      Application.put_env(:hoodride, :requests_hook, fn
        :start ->
          start_result

        step ->
          send(me, {:at, step, self()})
          receive do: (:go -> nil)
      end)
    end

    # (review, 2026-11-20) the Accept put the request back and stopped
    # counting as at work just as the Cancel looked: the Cancel cleared the
    # mark and said "ok" — the Accept then found none: the request stood
    test "the Accept puts it back as the Cancel finishes: never 'ok' with the request standing",
         %{rider: rider, driver: driver} do
      Application.put_env(:hoodride, :accept_wait_ms, 100)
      on_exit(fn -> Application.delete_env(:hoodride, :accept_wait_ms) end)
      {rchan, dchan} = requested(rider, driver)
      stepwise({:error, :failed})
      accept = push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_receive {:at, :accepting, acceptor}, 2_000
      send(acceptor, :go)
      assert_receive {:at, :taken, ^acceptor}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      assert_receive {:at, :marking, canceller}, 2_000
      send(canceller, :go)
      assert_receive {:at, :relooked, ^canceller}, 2_000
      # the Accept: fails, puts it back, no longer at work — held there
      send(acceptor, :go)
      assert_receive {:at, :done_working, ^acceptor}, 2_000
      send(canceller, :go)
      assert_reply cancel, status, _, 2_000
      send(acceptor, :go)
      assert_reply accept, :error, _
      assert status in [:ok, :error]

      assert :ets.lookup(:ride_requests, rider.id) == [],
             "the Cancel answered #{status}, and the request stood again"
    end

    # (review, 2026-11-20) a mark was the accepting PROCESS's — a driver's
    # connection, which lives on: one written for an Accept that had just
    # ended was never cleared, and that connection's next Accept on the
    # rider, failing, cancelled a request nobody had cancelled
    test "a mark for an Accept that had just ended: never cancels that connection's later one",
         %{rider: rider, driver: driver} do
      Application.put_env(:hoodride, :accept_wait_ms, 100)
      on_exit(fn -> Application.delete_env(:hoodride, :accept_wait_ms) end)
      {rchan, _dchan} = requested(rider, driver)

      {:ok, other} =
        Hoodride.Accounts.upsert_oauth_user(%{
          provider: "dev",
          provider_id: "car-b",
          name: "CarB"
        })

      :ok = Hoodride.TestHelpers.give_car(other.id)
      {:ok, _, ochan} = subscribe_and_join(connect_as(other), "user:#{other.id}", %{})
      push(ochan, "driver_update", %{"spot" => @car_spot})
      ref = push(ochan, "cancel_request", %{})
      assert_reply ref, :ok

      # the other driver's connection: one process, Accept after Accept
      me = self()

      conn =
        spawn_link(fn ->
          Stream.repeatedly(fn ->
            receive do: ({:accept, d} ->
                           send(me, {:accepted, Hoodride.Requests.accept(d, rider.id)}))
          end)
          |> Stream.run()
        end)

      stepwise({:error, :failed})
      stalled = spawn(fn -> Hoodride.Requests.accept(driver, rider.id) end)
      assert_receive {:at, :accepting, ^stalled}, 2_000
      send(stalled, :go)
      assert_receive {:at, :taken, ^stalled}, 2_000
      # the other's Accept at work as the Cancel reads who is
      send(conn, {:accept, other})
      assert_receive {:at, :accepting, ^conn}, 2_000
      cancel = push(rchan, "cancel_request", %{})
      assert_receive {:at, :marking, canceller}, 2_000
      # …and over before the marks are written
      send(conn, :go)
      assert_receive {:accepted, {:error, _}}, 2_000
      send(canceller, :go)
      assert_receive {:at, :relooked, ^canceller}, 2_000
      send(canceller, :go)
      assert_reply cancel, :error, %{reason: "accepted"}, 2_000
      send(stalled, :go)
      assert_receive {:at, :done_working, ^stalled}, 2_000
      send(stalled, :go)
      ref = Process.monitor(stalled)
      assert_receive {:DOWN, ^ref, :process, ^stalled, _}, 2_000
      assert :ets.lookup(:ride_requests, rider.id) == []

      # later: the rider asks the other driver; that connection's Accept fails
      Application.put_env(:hoodride, :requests_hook, fn
        :start -> {:error, :failed}
        _ -> nil
      end)

      ref = push(rchan, "request_ride", %{"to" => other.id})
      assert_reply ref, :ok
      send(conn, {:accept, other})
      assert_receive {:accepted, {:error, :failed}}, 2_000

      assert [{_, driver_id, _}] = :ets.lookup(:ride_requests, rider.id),
             "the later request, its Accept failing, should stand again"

      assert driver_id == other.id
    end
  end

  test "nothing to cancel and no ride: still 'ok'", %{rider: rider} do
    {:ok, _, rchan} = subscribe_and_join(connect_as(rider), "user:#{rider.id}", %{})
    ref = push(rchan, "cancel_request", %{})
    assert_reply ref, :ok
  end
end
