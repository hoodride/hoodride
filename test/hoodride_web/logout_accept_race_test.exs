defmodule HoodrideWeb.LogoutAcceptRaceTest do
  @moduledoc """
  A1 (bug hunt, 2026-11-10; owner 2026-11-11): sign-out — and account
  deletion — is refused during a ride (the partner would be stranded) or
  while your own request waits, but its check and the sign-out itself are
  two steps. An Accept between them started a ride the sign-out then signed
  out of: the rider waited for a driver whose phone was back at the sign-in
  screen. Accept is two steps too (its sign-in check, then the seats).

  The rule — no lock: each side does its own step FIRST, then looks at the
  other's. Sign-out: signed out, then a ride started meanwhile is ended (the
  partner told "ended") and its own request cancelled
  (Hoodride.Rides.after_sign_out). Accept: the seats claimed (the ride
  listed), then signed out meanwhile → no ride, never announced, the rider
  declined. A request: saved, then signed out meanwhile → withdrawn, never
  shown. Whichever finishes second sees the other: the ride or the
  sign-out, never both. A ride still starting counts as a ride for the
  sign-out's check (refused).

  The gaps held open on purpose: the sign-out's second step waits on the
  account's lock (Hoodride.SessionTokens) — held by the test; the other
  side's gap is its check's own answer, captured before the sign-out.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, except: [connect: 2, connect: 3, push: 3]

  alias Hoodride.{Accounts, Geo, Requests, Rides, SessionTokens}

  @cell "882a1072c7fffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp me_map(u), do: %{id: u.id, name: u.name, photo: u.photo}

  defp channel(u) do
    {:ok, sock} =
      Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
      )

    {:ok, _, chan} = subscribe_and_join(sock, "user:#{u.id}", %{})
    chan
  end

  # a driver on the map with the (signed-in) rider's request waiting
  defp requested(driver, rider, signed_in \\ true) do
    if signed_in, do: Hoodride.TestHelpers.session_for(rider.id)
    Geo.driver_update(me_map(driver), @cell, nil, [])
    assert :ok = Requests.create(me_map(rider), driver.id)
  end

  # the account's lock held by another process until :release
  defp hold_lock(user_id) do
    test = self()

    holder =
      spawn(fn ->
        :global.trans(
          {{SessionTokens, user_id}, self()},
          fn ->
            send(test, :held)
            receive do: (:release -> :ok)
          end,
          [node()]
        )
      end)

    assert_receive :held
    holder
  end

  # the process is waiting for the lock (:global retries it, sleeping)
  defp waiting_for_lock?(pid) do
    case Process.info(pid, :current_function) do
      {:current_function, {mod, _, _}} when mod in [:global, :timer] -> true
      _ -> false
    end
  end

  # up to ~5 s, looking every 2 ms
  defp until(fun, tries \\ 2_500) do
    cond do
      fun.() ->
        :ok

      tries == 0 ->
        flunk("timed out")

      true ->
        receive after: (2 -> :ok)
        until(fun, tries - 1)
    end
  end

  # the sign-out started: its check done, waiting at its second step
  defp sign_out_held(conn, u) do
    # (a sign-in takes the lock too: made before it's held)
    session = Hoodride.TestHelpers.session_for(u.id)
    holder = hold_lock(u.id)
    task = Task.async(fn -> conn |> init_test_session(session) |> post("/api/logout") end)
    until(fn -> waiting_for_lock?(task.pid) end)
    {holder, task}
  end

  defp finish(holder, task) do
    send(holder, :release)
    Task.await(task)
  end

  describe "the sign-out finishes second: it looks, and ends what started meanwhile" do
    test "an Accept between its check and the sign-out: the ride ended at once, the rider told",
         %{conn: conn} do
      driver = user("a1-drv")
      rider = user("a1-rdr")
      dchan = channel(driver)
      requested(driver, rider)
      HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")

      {holder, task} = sign_out_held(conn, driver)

      # the driver's Accept, on the phone, meanwhile: the ride starts
      ref = Phoenix.ChannelTest.push(dchan, "accept_request", %{"rider_id" => rider.id})
      assert_reply ref, :ok

      assert_receive %Phoenix.Socket.Broadcast{
        event: "ride_started",
        payload: %{ride_id: ride_id}
      }

      HoodrideWeb.Endpoint.subscribe("ride:#{ride_id}")

      out = finish(holder, task)
      assert json_response(out, 200) == %{"ok" => true}

      # …and then ended: nobody left waiting on a signed-out driver
      assert Rides.ride_id_of_user(driver.id) == nil
      assert Rides.ride_id_of_user(rider.id) == nil
      assert_receive %Phoenix.Socket.Broadcast{event: "ended", payload: %{by: by}}
      assert by == driver.id
    end

    test "a request between the rider's check and the sign-out: withdrawn, the driver told",
         %{conn: conn} do
      driver = user("a1r-drv")
      rider = user("a1r-rdr")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      HoodrideWeb.Endpoint.subscribe("user:#{driver.id}")

      {holder, task} = sign_out_held(conn, rider)
      # (the request's own sign-in check already passed: still signed in)
      assert :ok = Requests.create(me_map(rider), driver.id)
      assert_receive %Phoenix.Socket.Broadcast{event: "request"}

      assert json_response(finish(holder, task), 200) == %{"ok" => true}
      assert Requests.open_request_of(rider.id) == nil

      assert_receive %Phoenix.Socket.Broadcast{
        event: "request_cancelled",
        payload: %{from_id: from}
      }

      assert from == rider.id
    end
  end

  # the RIDER signing out as the driver accepts (review, 2026-11-11): the
  # rider's own look can land while the ride is still starting — which it
  # leaves to the ride's look; that look checks the rider too: any sign-in
  # left (never a time: the sign-out's time is taken before its sign-ins
  # are gone — second review, 2026-11-11)
  describe "the rider signs out as the driver accepts" do
    test "the rider's sign-ins gone before the ride's look: no ride, nothing announced, declined" do
      driver = user("a1x-drv")
      rider = user("a1x-rdr")
      requested(driver, rider)
      HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")
      # (signed in: the look would let it start)
      assert SessionTokens.any?(rider.id)
      # the rider's sign-out half-way: the sign-ins gone, its sign-out time
      # not even written yet — the driver's Accept goes on
      assert {:ok, _} = SessionTokens.revoke_all(rider.id)
      refute SessionTokens.any?(rider.id)

      assert {:error, :signed_out} = Requests.accept(me_map(driver), rider.id, fn -> true end)
      assert Rides.ride_id_of_user(rider.id) == nil
      assert Rides.ride_id_of_user(driver.id) == nil
      refute_received %Phoenix.Socket.Broadcast{event: "ride_started"}
      assert_received %Phoenix.Socket.Broadcast{event: "request_declined"}
      assert Requests.open_request_of(rider.id) == nil
    end

    test "both signed in: the ride starts (the look lets it)" do
      driver = user("a1y-drv")
      rider = user("a1y-rdr")
      # signed out once before, signed in again since: counts as signed in
      assert :ok = Accounts.mark_logged_out(rider.id)
      requested(driver, rider)
      assert {:ok, _} = Requests.accept(me_map(driver), rider.id, fn -> true end)
      assert Rides.ride_id_of_user(rider.id) != nil
    end

    test "no look asked (tools, tests): the ride starts whatever the sign-ins" do
      driver = user("a1n-drv")
      rider = user("a1n-rdr")
      requested(driver, rider, false)
      refute SessionTokens.any?(rider.id)
      assert {:ok, _} = Requests.accept(me_map(driver), rider.id)
    end

    test "a start that fails otherwise puts the request back — unless someone signed out meanwhile" do
      src = File.read!("lib/hoodride/requests.ex")
      [accept] = Regex.run(~r/  def accept\(driver, rider_id.*?\n  end\n/s, src)

      [_, back] =
        String.split(accept, ":ets.insert_new(@requests, {rider_id, driver_id, ts})", parts: 2)

      assert back =~
               "unless look.() do\n                  case take_if_ours(rider_id, driver_id) do"

      assert back =~ "decline_consumed(rider_id, driver_id)"
    end

    test "the rider's account deleted as the driver accepts: declined — the request never comes back" do
      driver = user("a1z-drv")
      rider = user("a1z-rdr")
      requested(driver, rider)
      # the row gone (the deletion's database step), its sign-out not yet
      # written: the ride's name lookup finds no such person
      Hoodride.Repo.delete!(Accounts.get_user(rider.id))

      assert {:error, :no_such_user} = Requests.accept(me_map(driver), rider.id, fn -> true end)
      assert Requests.open_request_of(rider.id) == nil
      assert Requests.pending_for_driver(driver.id) == []
    end
  end

  # undone after its seats were listed: only ITS rows are removed — never a
  # newer ride's that took the seat meanwhile (review, 2026-11-11)
  test "a start undone frees only its own seat rows" do
    src = File.read!("lib/hoodride/rides.ex")
    [start_ride] = Regex.run(~r/def start_ride\(rider_id, driver_id.*?\n  end\n/s, src)
    refute start_ride =~ ":ets.delete(:rides_by_user,"
    assert start_ride =~ ":ets.delete_object(:rides_by_user, {uid, :pending})"
    assert start_ride =~ ":ets.delete_object(:rides_by_user, {uid, id})"
  end

  describe "the other side finishes second: it looks, and undoes itself" do
    test "signed out after Accept's own check, before the seats: no ride, never announced, declined" do
      driver = user("a1b-drv")
      rider = user("a1b-rdr")
      dchan = channel(driver)
      requested(driver, rider)
      HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")
      # Accept's sign-in check as the channel makes it — then the sign-in
      # gone before the seats are claimed
      still = HoodrideWeb.UserChannel.still_signed_in(dchan)
      assert still.()
      assert {:ok, _} = SessionTokens.revoke_all(driver.id)
      refute still.()

      assert {:error, :signed_out} = Requests.accept(me_map(driver), rider.id, still)
      assert Rides.ride_id_of_user(driver.id) == nil
      assert Rides.ride_id_of_user(rider.id) == nil
      refute_received %Phoenix.Socket.Broadcast{event: "ride_started"}
      # the rider isn't left waiting on it: declined, as a busy driver's is
      assert_received %Phoenix.Socket.Broadcast{event: "request_declined"}
      assert Requests.open_request_of(rider.id) == nil
    end

    test "the ride lists its seats BEFORE it looks: a sign-out after that look sees the ride" do
      # (the order that makes 'whichever is second sees the other' true:
      # the seats are the ride's id — not 'starting' — when it looks)
      driver = user("a1o-drv")
      rider = user("a1o-rdr")
      me = self()

      looked = fn ->
        send(me, {:seats_at_look, Rides.ride_id_of_user(driver.id)})
        true
      end

      assert {:ok, ride_id} = Rides.start_ride(rider.id, driver.id, looked)
      assert_received {:seats_at_look, ^ride_id}
    end

    test "signed out after the request's own check, before it's saved: withdrawn, never shown" do
      driver = user("a1q-drv")
      rider = user("a1q-rdr")
      rchan = channel(rider)
      Geo.driver_update(me_map(driver), @cell, nil, [])
      HoodrideWeb.Endpoint.subscribe("user:#{driver.id}")
      still = HoodrideWeb.UserChannel.still_signed_in(rchan)
      assert {:ok, _} = SessionTokens.revoke_all(rider.id)

      assert {:error, :signed_out} = Requests.create(me_map(rider), driver.id, nil, still)
      assert Requests.open_request_of(rider.id) == nil
      refute_received %Phoenix.Socket.Broadcast{event: "request"}
    end
  end

  test "a ride still starting counts as a ride: the sign-out is refused", %{conn: conn} do
    driver = user("a1p-drv")
    rider = user("a1p-rdr")
    :ets.insert(:rides_by_user, [{rider.id, :pending}, {driver.id, :pending}])

    out =
      conn
      |> init_test_session(Hoodride.TestHelpers.session_for(driver.id))
      |> post("/api/logout")

    assert json_response(out, 409) == %{"error" => "in_ride"}
    :ets.delete(:rides_by_user, rider.id)
    :ets.delete(:rides_by_user, driver.id)
  end

  test "after_sign_out: a ride is ended (the partner told), a still-starting one left to its own look, a request withdrawn" do
    driver = user("a1s-drv")
    rider = user("a1s-rdr")
    other = user("a1s-oth")
    assert {:ok, ride_id} = Rides.start_ride(rider.id, driver.id)
    HoodrideWeb.Endpoint.subscribe("ride:#{ride_id}")

    assert :ok = Rides.after_sign_out(driver.id)
    assert Rides.ride_id_of_user(rider.id) == nil
    assert_receive %Phoenix.Socket.Broadcast{event: "ended"}

    # starting: not this one's to end (the ride's own look does)
    :ets.insert(:rides_by_user, {other.id, :pending})
    assert :ok = Rides.after_sign_out(other.id)
    assert Rides.ride_id_of_user(other.id) == :pending
    :ets.delete(:rides_by_user, other.id)

    Geo.driver_update(me_map(driver), @cell, nil, [])
    assert :ok = Requests.create(me_map(rider), driver.id)
    assert :ok = Rides.after_sign_out(rider.id)
    assert Requests.open_request_of(rider.id) == nil
  end

  # deleting the account: the same look, after its sign-ins are gone
  test "account deletion looks too: after the sign-ins are forgotten" do
    src = File.read!("lib/hoodride/account_deletion.ex")
    [after_erase] = Regex.run(~r/defp after_erase\(user_id, now\) do.*?\n  end\n/s, src)
    {forget, _} = :binary.match(after_erase, "Hoodride.SessionTokens.forget(user_id)")
    {look, _} = :binary.match(after_erase, "Rides.after_sign_out(user_id)")
    assert forget < look

    auth = File.read!("lib/hoodride_web/controllers/auth_controller.ex")
    [logout] = Regex.run(~r/defp do_logout\(conn, user\) do.*?\n  end\n/s, auth)
    {signed_out, _} = :binary.match(logout, "Accounts.mark_logged_out(user.id)")
    {look2, _} = :binary.match(logout, "Hoodride.Rides.after_sign_out(user.id)")
    assert signed_out < look2

    # the channel hands its own sign-in check to Accept and to a request
    channel = File.read!("lib/hoodride_web/channels/user_channel.ex")

    assert channel =~
             "Hoodride.Requests.accept(socket.assigns.user, rider_id, still_signed_in(socket))"

    assert channel =~ "shareable_spot(socket, payload),\n             still_signed_in(socket)\n"
  end
end
