defmodule HoodrideWeb.RidePosAfterEndTest do
  @moduledoc """
  An exact position must never reach someone whose ride is over.

  "pos" is relayed only while the SENDER holds a seat, but that check and
  the ride's end aren't ordered: the sender passes the check, the ride frees
  the seats and says "ended", then the relay goes out. Phoenix delivers a
  plain broadcast straight to the receiver's connection, while "ended" goes
  through the receiver's channel (it closes after it), so the late position
  arrived AFTER "ended" (the mega monster: a partner's position to someone
  no longer in a ride). The receiver's own seat closes it: every end frees
  the seats before it broadcasts, so a position is pushed only to someone
  still seated in this ride.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.Rides

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, rider} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "pe-r", name: "PR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "pe-d", name: "PD"})

    {:ok, ride_id} = Rides.start_ride(rider.id, driver.id)

    # both on the ride channel (join/3 does not subscribe this test process,
    # so every push below came through a channel)
    {:ok, _, rchan} = join(connect_as(rider), "ride:#{ride_id}", %{})
    {:ok, _, dchan} = join(connect_as(driver), "ride:#{ride_id}", %{})

    %{rider: rider, driver: driver, ride_id: ride_id, rchan: rchan, dchan: dchan}
  end

  defp connect_as(user) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    socket
  end

  # a replying event on the channel: everything it was sent before has run
  defp barrier(chan) do
    ref = push(chan, "arrived", %{})
    assert_reply ref, _status, _
  end

  test "mid-ride: the partner's position arrives", %{rchan: rchan, dchan: dchan, driver: %{id: d}} do
    push(dchan, "pos", %{"lat" => 1.0, "lng" => 2.0})
    barrier(rchan)
    assert_push "peer_pos", %{from: ^d, lat: 1.0, lng: 2.0}
  end

  test "the end has freed the receiver's seat (not yet the sender's) → no position reaches them",
       %{rider: r, rchan: rchan, dchan: dchan} do
    # free_seats deletes the two seats one after the other: this is the
    # moment in between — the sender still passes its own check
    :ets.delete(:rides_by_user, r.id)

    push(dchan, "pos", %{"lat" => 1.0, "lng" => 2.0})
    barrier(dchan)
    barrier(rchan)
    refute_push "peer_pos", %{}
  end

  test "the seat now belongs to a newer ride → the old ride's position doesn't reach it",
       %{rider: r, rchan: rchan, dchan: dchan} do
    :ets.insert(:rides_by_user, {r.id, "r-newer"})

    push(dchan, "pos", %{"lat" => 1.0, "lng" => 2.0})
    barrier(dchan)
    barrier(rchan)
    refute_push "peer_pos", %{}
  end
end
