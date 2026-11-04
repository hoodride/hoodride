defmodule HoodrideWeb.RideJoinRaceTest do
  @moduledoc """
  A ride that ends WHILE someone joins its channel. Phoenix runs our join
  check first and subscribes to the topic only after it returns
  (Phoenix.Channel.Server.channel_join → init_join), so an "ended" broadcast
  in between reaches nobody on this channel: the join succeeds onto a dead
  ride and the app sits in it until a reload. Found by the monster test (a
  rider who reconnected mid-ride missed "ended").

  Every way a ride ends frees its seats BEFORE broadcasting "ended", so once
  subscribed: our seat still on this ride → "ended" hasn't gone out and will
  reach us; seat gone → we may have missed it → the channel says it itself.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.Rides

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    # a channel that closes before ChannelTest links to it sends this test
    # an exit signal (noproc) — a test-harness artifact, not a failure
    Process.flag(:trap_exit, true)

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "jr-r", name: "JR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "jr-d", name: "JD"})

    %{rider: rider, driver: driver}
  end

  defp connect_as(user) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    socket
  end

  # ChannelTest links to the new channel and asks it for its socket after
  # the join; a channel that already said "ended" and closed is gone by then
  defp join_ride(socket, ride_id) do
    join(socket, "ride:#{ride_id}", %{})
  rescue
    ErlangError -> :joined_and_closed
  catch
    :exit, _ -> :joined_and_closed
  end

  test "the ride ended between the join check and the subscribe → the join still hears \"ended\"",
       %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)

    # the in-between moment, held still: the ride process still answers the
    # join check, but the end has already freed the seats (and its "ended"
    # went out before this channel was listening)
    :ets.delete(:rides_by_user, r.id)
    :ets.delete(:rides_by_user, d.id)

    joined = join_ride(connect_as(r), ride_id)
    assert_push "ended", %{by: nil}

    with {:ok, _, chan} <- joined do
      ref = Process.monitor(chan.channel_pid)
      assert_receive {:DOWN, ^ref, :process, _, _}
    end
  end

  test "a ride that is still on → the join hears no false \"ended\"", %{rider: r, driver: d} do
    {:ok, ride_id} = Rides.start_ride(r.id, d.id)

    assert {:ok, _, chan} = join(connect_as(r), "ride:#{ride_id}", %{})
    # a replying event as a barrier: anything the join queued has run
    ref = push(chan, "arrived", %{})
    assert_reply ref, :error, %{reason: _}
    mon = Process.monitor(chan.channel_pid)
    refute_push "ended", %{}
    refute_received {:DOWN, ^mon, :process, _, _}
  end

  test "the seat now belongs to a NEWER ride → the old ride's join hears \"ended\"",
       %{rider: r, driver: d} do
    {:ok, old_id} = Rides.start_ride(r.id, d.id)
    # the old ride ended and a new one started before this join subscribed
    :ets.insert(:rides_by_user, [{r.id, "r-newer"}, {d.id, "r-newer"}])

    _ = join_ride(connect_as(r), old_id)
    assert_push "ended", %{by: nil}
  end

  # no hooks: the real race, many times. Every join that SUCCEEDS must end
  # with "ended" (live, or said by the channel itself) — never silence.
  test "join racing a real end_ride: a successful join always hears \"ended\"",
       %{rider: r, driver: d} do
    for round <- 1..600 do
      # 600 connects would trip the per-user connect budget: a fresh world
      Hoodride.TestHelpers.scrub_live_state()
      {:ok, ride_id} = Rides.start_ride(r.id, d.id)
      socket = connect_as(r)

      # the end lands a little later each round (busy work, no timers), so
      # the rounds sweep across the whole join — the gap is microseconds
      spin = rem(round * 37, 600) * 20

      ender =
        Task.async(fn ->
          Enum.reduce(1..max(spin, 1), 0, &(&1 + &2))
          Rides.end_ride(ride_id, d.id)
        end)

      joined = join_ride(socket, ride_id)

      Task.await(ender)

      case joined do
        {:ok, _, chan} ->
          assert_push "ended", %{}, 1000
          mon = Process.monitor(chan.channel_pid)
          assert_receive {:DOWN, ^mon, :process, _, _}

        :joined_and_closed ->
          assert_push "ended", %{}, 1000

        {:error, %{reason: "gone"}} ->
          :ok
      end

      # nothing left over for the next round
      refute_received %Phoenix.Socket.Message{event: "ended"}
    end
  end
end
