defmodule HoodrideWeb.RidePositionMemoryTest do
  @moduledoc """
  The last ride position per person, held for a partner who (re)joins.

  Positions were relayed and never kept: a partner whose app reloaded (a
  refresh, a phone reopening a discarded tab) saw nobody until the other
  phone's next send — up to ~24 s for someone standing still at the pickup
  — and the driver's Navigate had nowhere exact to go. The standard answer
  is a last-value cache for late joiners (MQTT retained messages, RTI's
  last-value cache): the ride keeps each person's LAST position, and a
  partner joining gets it right after subscribing, with its age.

  Privacy (exact positions stay inside the ride): kept in the ride's own
  process, in memory, for the ride only — gone when it ends (the lesson of
  Uber's post-trip tracking, rolled back as "a mistake"); handed only to
  the seated partner; never in Rides.get or /api/state; hidden from crash
  reports (format_status) and process inspection (sensitive); filtered out
  of every Phoenix log line.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  import ExUnit.CaptureLog
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.Rides

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    rider = user("rm-r")
    driver = user("rm-d")
    {:ok, ride_id} = Rides.start_ride(rider.id, driver.id)
    %{rider: rider, driver: driver, ride_id: ride_id}
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  # ---------- a seat: one process = one app on the ride channel ----------

  defp seat(name, user, ride_id) do
    test = self()

    pid =
      spawn_link(fn ->
        Process.flag(:trap_exit, true)

        {:ok, socket} =
          connect(HoodrideWeb.UserSocket, %{},
            connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)},
            test_process: test
          )

        result =
          case join(socket, "ride:#{ride_id}", %{}) do
            {:ok, _reply, chan} -> {:ok, chan}
            {:error, reply} -> {:error, reply}
          end

        send(test, {name, :joined, elem(result, 0), elem(result, 1)})
        loop(test, name, result)
      end)

    receive do
      {^name, :joined, :ok, _chan} -> %{name: name, pid: pid}
      {^name, :joined, :error, reply} -> {:refused, reply}
    after
      2_000 -> flunk("#{name} didn't join")
    end
  end

  defp loop(test, name, result) do
    receive do
      {:pos, lat, lng} ->
        {:ok, chan} = result
        push(chan, "pos", %{"lat" => lat, "lng" => lng})
        # a replying event: the pos above was handled before its reply
        ref = push(chan, "__barrier__", %{})
        send(test, {name, :pushed, ref})
        loop(test, name, result)

      :leave ->
        :ok

      msg ->
        send(test, {name, :got, msg})
        loop(test, name, result)
    end
  end

  defp send_pos(seat, lat, lng) do
    name = seat.name
    send(seat.pid, {:pos, lat, lng})

    receive do
      {^name, :pushed, ref} ->
        receive do
          {^name, :got, %Phoenix.Socket.Reply{ref: ^ref}} -> :ok
        after
          1_000 -> flunk("no barrier reply")
        end
    after
      1_000 -> flunk("#{name} didn't push")
    end
  end

  defp drop_seat(seat) do
    ref = Process.monitor(seat.pid)
    send(seat.pid, :leave)
    assert_receive {:DOWN, ^ref, :process, _, _}
  end

  # every peer_pos a seat received so far, in order
  defp peer_positions(seat, wait \\ 200) do
    name = seat.name
    Process.sleep(wait)
    collect(name, [])
  end

  defp collect(name, acc) do
    receive do
      {^name, :got, %Phoenix.Socket.Message{event: "peer_pos", payload: p}} ->
        collect(name, [p | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  # ---------- the hand-over ----------

  test "a partner who reloads gets the other's last position at once, with its age",
       %{rider: r, driver: d, ride_id: ride_id} do
    driver = seat(:driver, d, ride_id)
    rider = seat(:rider, r, ride_id)
    send_pos(driver, 40.71, -74.01)
    assert [%{lat: 40.71}] = peer_positions(rider)

    # the rider's app reloads: a fresh join
    drop_seat(rider)
    again = seat(:rider_again, r, ride_id)

    assert [%{from: from, lat: 40.71, lng: -74.01, age_ms: age}] = peer_positions(again)
    assert from == d.id
    assert is_integer(age) and age >= 0 and age < 5_000
  end

  test "nobody has sent a position yet: nothing is handed over", %{
    rider: r,
    driver: d,
    ride_id: ride_id
  } do
    _driver = seat(:driver, d, ride_id)
    rider = seat(:rider, r, ride_id)
    assert peer_positions(rider) == []
  end

  test "the LAST position is kept, and its age grows", %{rider: r, driver: d, ride_id: ride_id} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 1.0, 1.0)
    send_pos(driver, 2.0, 2.0)
    Process.sleep(300)

    rider = seat(:rider, r, ride_id)
    assert [%{lat: 2.0, lng: 2.0, age_ms: age}] = peer_positions(rider)
    assert age >= 300
  end

  test "your own position is never handed back to you", %{rider: r, driver: d, ride_id: ride_id} do
    rider = seat(:rider, r, ride_id)
    send_pos(rider, 5.0, 5.0)
    _driver = seat(:driver, d, ride_id)

    drop_seat(rider)
    again = seat(:rider_again, r, ride_id)
    assert peer_positions(again) == []
  end

  test "stored, then forwarded: what a joiner is handed is never newer than what follows",
       %{rider: r, driver: d, ride_id: ride_id} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 1.0, 1.0)
    rider = seat(:rider, r, ride_id)
    send_pos(driver, 2.0, 2.0)
    send_pos(driver, 3.0, 3.0)

    assert [1.0, 2.0, 3.0] = Enum.map(peer_positions(rider), & &1.lat)
  end

  # ---------- who can get it ----------

  test "someone else can't join the ride, and gets nothing", %{driver: d, ride_id: ride_id} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 40.71, -74.01)
    assert {:refused, %{reason: "not_yours"}} = seat(:stranger, user("rm-x"), ride_id)
  end

  test "after the ride ends nothing is kept or handed over — rejoining gets \"gone\"",
       %{rider: r, driver: d, ride_id: ride_id} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 40.71, -74.01)
    :ok = Rides.end_ride(ride_id, r.id)

    assert {:refused, %{reason: "gone"}} = seat(:rider_late, r, ride_id)
    assert Rides.peer_position(ride_id, r.id) == nil
  end

  test "never in Rides.get, nor in /api/state", %{rider: r, driver: d, ride_id: ride_id} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 40.71, -74.01)

    {:ok, st} = Rides.get(ride_id)
    assert Enum.sort(Map.keys(st)) == [:arrived, :driver, :id, :pin, :rider]

    body =
      Phoenix.ConnTest.build_conn()
      |> Phoenix.ConnTest.init_test_session(Hoodride.TestHelpers.session_for(r.id))
      |> Phoenix.ConnTest.dispatch(HoodrideWeb.Endpoint, :get, "/api/state")
      |> Phoenix.ConnTest.response(200)

    # a real signed-in state with the ride in it — or "no coordinates" proves nothing
    assert body =~ ride_id
    refute body =~ "40.71"
    refute body =~ "-74.01"
  end

  # ---------- out of logs and inspection ----------

  test "an unexpected message never crashes a ride (no crash report to leak from)",
       %{ride_id: ride_id, driver: d} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 51.123456, -0.987654)
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)

    log =
      capture_log(fn ->
        send(pid, {:unexpected, %{lat: 33.987654, lng: 12.345678}})
        GenServer.cast(pid, {:unexpected, 1})
        assert GenServer.call(pid, {:unexpected, 1}) == {:error, :bad_request}
      end)

    assert Process.alive?(pid)
    assert log == ""
  end

  test "a real ride crash logs no coordinates: not the state, not the message, not the stack",
       %{ride_id: ride_id, driver: d} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 51.123456, -0.987654)
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
    # a bug: a field the handler updates AFTER storing is missing — the next
    # position crashes the ride, and the error message prints the WHOLE
    # state, with both the stored and the incoming position in it
    :sys.replace_state(pid, fn st -> Map.delete(st, :last_driver) end)

    log =
      capture_log(fn ->
        ref = Process.monitor(pid)
        catch_exit(GenServer.call(pid, {:position, d.id, %{lat: 33.987654, lng: 12.345678}}))
        assert_receive {:DOWN, ^ref, :process, _, _}
        Logger.flush()
      end)

    assert log =~ "terminating", "expected the crash report: #{log}"
    for secret <- ~w(51.123456 -0.987654 33.987654 12.345678), do: refute(log =~ secret)
  end

  test "however the state is printed, positions show as redacted", %{ride_id: ride_id, driver: d} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 51.123456, -0.987654)
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
    raw = :sys.get_state(pid)

    # a stack trace prints a failed callback's arguments with inspect
    printed = Exception.format_stacktrace([{Hoodride.Rides.Ride, :handle_info, [:x, raw], []}])
    refute printed =~ "51.123456"
    assert printed =~ "#Positions<redacted>"
  end

  test ":sys.get_status shows no coordinates", %{ride_id: ride_id, driver: d} do
    driver = seat(:driver, d, ride_id)
    send_pos(driver, 51.123456, -0.987654)
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
    refute inspect(:sys.get_status(pid)) =~ "51.123456"
  end

  test "the ride process is sensitive: its message queue can't be read out", %{ride_id: ride_id} do
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, ride_id)
    :sys.suspend(pid)
    send(pid, {:pending, %{lat: 1.5, lng: 2.5}})
    assert Process.info(pid, :messages) == {:messages, []}
    :sys.resume(pid)
  end

  test "a position never reaches the Phoenix log, at any level", %{
    rider: r,
    driver: d,
    ride_id: ride_id
  } do
    driver = seat(:driver, d, ride_id)
    _rider = seat(:rider, r, ride_id)
    previous = Logger.level()

    log =
      try do
        Logger.configure(level: :debug)
        capture_log([level: :debug], fn -> send_pos(driver, 51.123456, -0.987654) end)
      after
        Logger.configure(level: previous)
      end

    assert log =~ "INCOMING ON ride:", "expected Phoenix's channel log line: #{log}"
    assert log =~ "[FILTERED]"
    refute log =~ "51.123456"
  end
end
