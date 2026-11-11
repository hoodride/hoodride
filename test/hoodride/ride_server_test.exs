defmodule Hoodride.RideServerTest do
  @moduledoc "The GenServer-per-ride: birth effects, authority, self-cleaning death."
  use ExUnit.Case

  import ExUnit.CaptureLog

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

  # cleanup took "slow" for "gone": asked a ride "are you there?" and, after
  # 5 s with no answer (a ride busy on a slow database), freed both seats
  # and told both people the ride ended — mid-ride. "Gone" is now only a
  # ride whose process no longer exists; a slow one is left alone.
  test "a ride slow to answer is never taken for gone: cleanup leaves it running",
       %{rider: r, driver: d} do
    {:ok, id} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(id)
    HoodrideWeb.Endpoint.subscribe("ride:" <> id)
    # (busy: answers nothing until resumed)
    :sys.suspend(pid)

    try do
      Hoodride.Sweeper.heal_orphan_ride_slots()
    after
      :sys.resume(pid)
    end

    assert Rides.ride_id_of_user(r.id) == id, "cleanup freed a live ride's seat"
    assert Rides.ride_id_of_user(d.id) == id
    refute_received %Phoenix.Socket.Broadcast{event: "ended"}
    assert {:ok, %{id: ^id}} = Rides.get(id)
  end

  # a ride process that just ended is still listed for a moment (the
  # registry removes it a little later): never "alive" — else cleanup skips
  # it and nobody is told the ride ended (found by ContactPrivacyTest in a
  # full run; pinned here with the registry held so the moment can't pass)
  test "a ride just ended, still listed: not alive", %{rider: r, driver: d} do
    {:ok, id} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(id)
    [{_, part, _, _} | _] = Supervisor.which_children(Hoodride.Rides.Registry)
    :sys.suspend(part)

    try do
      ref = Process.monitor(pid)
      Process.exit(pid, :kill)
      assert_receive {:DOWN, ^ref, :process, ^pid, :killed}
      assert [{^pid, _}] = Registry.lookup(Hoodride.Rides.Registry, id), "(still listed)"
      refute Rides.alive?(id)
    after
      :sys.resume(part)
    end
  end

  test "a ride whose process is gone: cleanup still frees its seats and says 'ended'",
       %{rider: r, driver: d} do
    {:ok, id} = Rides.start_ride(r.id, d.id)
    pid = ride_pid(id)
    HoodrideWeb.Endpoint.subscribe("ride:" <> id)
    ref = Process.monitor(pid)
    # killed: no terminate, the seats left behind
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^ref, :process, ^pid, :killed}
    assert Rides.ride_id_of_user(r.id) == id

    Hoodride.Sweeper.heal_orphan_ride_slots()

    assert Rides.ride_id_of_user(r.id) == nil
    assert Rides.ride_id_of_user(d.id) == nil
    assert_received %Phoenix.Socket.Broadcast{event: "ended", payload: %{reason: "error"}}
  end

  # every ride start waited in ONE line: the supervisor ran each ride's
  # start-up (both name lookups in the database) itself, so one start stuck
  # on a slow database held up every other driver's Accept in the city.
  # The supervisor now only starts the process; the start-up runs in the
  # ride, the accepting driver waiting for it.
  test "one ride's slow start never holds up another's", %{rider: r, driver: d} do
    {:ok, r2} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rs-r2", name: "R2"})

    {:ok, d2} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rs-d2", name: "D2"})

    me = self()
    slow = r.id

    Application.put_env(:hoodride, :user_lookup, fn id ->
      if id == slow do
        send(me, {:looking, self()})
        receive do: (:go -> :ok)
      end

      Hoodride.Accounts.get_user(id)
    end)

    on_exit(fn -> Application.delete_env(:hoodride, :user_lookup) end)

    first = Task.async(fn -> Rides.start_ride(r.id, d.id) end)
    assert_receive {:looking, looker}, 2_000
    second = Task.async(fn -> Rides.start_ride(r2.id, d2.id) end)
    meanwhile = Task.yield(second, 1_000)
    send(looker, :go)

    assert {:ok, {:ok, id2}} = meanwhile, "the second start waited behind the slow one"
    assert Rides.ride_id_of_user(r2.id) == id2
    assert {:ok, id1} = Task.await(first)
    assert Rides.ride_id_of_user(r.id) == id1
  end

  # a partner that doesn't exist (deleted a moment ago): no ride, both seats
  # free, nobody told anything, no process left behind
  test "a start for an account that's gone: an error, seats free, nothing announced, no ride left",
       %{driver: d} do
    gone = 4_294_967_000
    HoodrideWeb.Endpoint.subscribe("user:#{d.id}")

    kids = fn ->
      for {_, pid, _, _} <- DynamicSupervisor.which_children(Hoodride.Rides.Supervisor), do: pid
    end

    before = kids.()

    log = capture_log(fn -> assert {:error, :no_such_user} = Rides.start_ride(gone, d.id) end)
    # stopped cleanly — no crash in its shutdown (a half-started ride's state
    # isn't a ride's)
    refute log =~ "terminating", log

    assert Rides.ride_id_of_user(gone) == nil
    assert Rides.ride_id_of_user(d.id) == nil
    refute_received %Phoenix.Socket.Broadcast{event: "ride_started"}
    # (its reply comes just before it stops: each new ride process watched
    # until it's gone — none may stay)
    for pid <- kids.() -- before do
      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000, "a ride process was left behind"
    end

    # and the seats really are free: a real ride starts
    {:ok, r2} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rs-r3", name: "R3"})

    assert {:ok, _} = Rides.start_ride(r2.id, d.id)
  end

  # the start is two steps now (the process, then its start-up): the one who
  # started it dying in between (a connection cut that very moment) must not
  # leave a ride half-started forever — both seats claimed, nobody told,
  # cleanup never looking at a claim. It frees the claim and stops.
  test "whoever started a ride dying before its start-up: the claim is freed, the half-started ride stops",
       %{rider: r, driver: d} do
    :ets.insert(:rides_by_user, [{r.id, :pending}, {d.id, :pending}])
    starter = spawn(fn -> receive do: (:never -> :ok) end)

    {:ok, pid} =
      DynamicSupervisor.start_child(
        Hoodride.Rides.Supervisor,
        {Hoodride.Rides.Ride, %{id: "r-half", rider: r.id, driver: d.id, starter: starter}}
      )

    ref = Process.monitor(pid)
    HoodrideWeb.Endpoint.subscribe(Hoodride.Roles.topic(r.id))
    HoodrideWeb.Endpoint.subscribe(Hoodride.Roles.topic(d.id))
    Process.exit(starter, :kill)

    assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000
    assert Rides.ride_id_of_user(r.id) == nil
    assert Rides.ride_id_of_user(d.id) == nil
    # both apps told (else both stay off the map, their role unchanged)
    rt = Hoodride.Roles.topic(r.id)
    dt = Hoodride.Roles.topic(d.id)
    assert_received %Phoenix.Socket.Broadcast{topic: ^rt, event: "changed"}
    assert_received %Phoenix.Socket.Broadcast{topic: ^dt, event: "changed"}
  end

  # …and once started, its starter going away changes nothing (the accepting
  # driver's connection may well close mid-ride)
  test "a started ride outlives whoever started it", %{rider: r, driver: d} do
    me = self()

    starter =
      spawn(fn ->
        send(me, {:started, Rides.start_ride(r.id, d.id)})
      end)

    assert_receive {:started, {:ok, id}}, 2_000
    ref = Process.monitor(starter)
    assert_receive {:DOWN, ^ref, :process, ^starter, _}
    pid = ride_pid(id)
    _ = :sys.get_state(pid)
    assert Rides.alive?(id)
    assert Rides.ride_id_of_user(r.id) == id
  end

  # the start-up CRASHING (a bug, not a slow database): the starter gets an
  # error and frees the claim — else both seats stay claimed and cleanup
  # never looks at a claim: both off the map until a restart
  test "a start-up that crashes: an error, both seats free, a later ride starts",
       %{rider: r, driver: d} do
    Application.put_env(:hoodride, :user_lookup, fn _ -> raise ArgumentError, "a bug" end)
    on_exit(fn -> Application.delete_env(:hoodride, :user_lookup) end)

    capture_log(fn ->
      assert {:error, {:start_failed, _}} = Rides.start_ride(r.id, d.id)
    end)

    assert Rides.ride_id_of_user(r.id) == nil
    assert Rides.ride_id_of_user(d.id) == nil
    Application.delete_env(:hoodride, :user_lookup)
    assert {:ok, _} = Rides.start_ride(r.id, d.id)
  end

  # the start-up is waited for however long it takes: a start given up on
  # (seats freed, the request put back) would still finish — a ghost ride,
  # both told "ride started" for a request that's back
  test "a start-up slower than 5 s is still waited for: the ride starts, its seats its own",
       %{rider: r, driver: d} do
    Application.put_env(:hoodride, :user_lookup, fn id ->
      if id == r.id, do: Process.sleep(5_500)
      Hoodride.Accounts.get_user(id)
    end)

    on_exit(fn -> Application.delete_env(:hoodride, :user_lookup) end)
    assert {:ok, id} = Rides.start_ride(r.id, d.id)
    assert Rides.ride_id_of_user(r.id) == id
    assert Rides.ride_id_of_user(d.id) == id
  end

  # before its start-up a ride answers nothing else (no state to read), and
  # its start-up never runs twice
  test "a half-started ride: anything but its start-up refused; the start-up runs once",
       %{rider: r, driver: d} do
    :ets.insert(:rides_by_user, [{r.id, :pending}, {d.id, :pending}])

    {:ok, pid} =
      DynamicSupervisor.start_child(
        Hoodride.Rides.Supervisor,
        {Hoodride.Rides.Ride, %{id: "r-once", rider: r.id, driver: d.id, starter: self()}}
      )

    assert GenServer.call(pid, :get_state) == {:error, :starting}
    assert Rides.get("r-once") == {:error, :starting}
    assert GenServer.call(pid, {:end_ride, r.id}) == {:error, :starting}
    HoodrideWeb.Endpoint.subscribe("user:#{d.id}")
    assert GenServer.call(pid, :begin) == :ok
    assert_receive %Phoenix.Socket.Broadcast{event: "ride_started"}
    assert GenServer.call(pid, :begin) == {:error, :bad_request}
    refute_receive %Phoenix.Socket.Broadcast{event: "ride_started"}, 100
    assert Rides.ride_id_of_user(r.id) == "r-once"
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
