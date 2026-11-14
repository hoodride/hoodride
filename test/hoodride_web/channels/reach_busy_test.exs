defmodule HoodrideWeb.ReachBusyTest do
  @moduledoc """
  A first message (or request) to someone new asks your own map channel
  "are they on my screen?" (HoodrideWeb.Reach). If that channel is busy —
  answering a name tap while the database is slow — the question waited 5 s,
  then counted as "no": "unavailable", and the message box was cleared
  (review 2026-11-14). Now: a short wait, then "busy" — try again, nothing
  lost. A real "no" is still "unavailable".
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
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rbz-r", name: "RbzR"})

    {:ok, driver} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rbz-d", name: "RbzD"})

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

  # the rider sees the driver's car on their map
  defp car_in_view(rider, driver) do
    rsock = connect_as(rider)
    {:ok, _, rchan} = subscribe_and_join(rsock, "user:#{rider.id}", %{})
    {:ok, _, dchan} = subscribe_and_join(connect_as(driver), "user:#{driver.id}", %{})
    push(dchan, "driver_update", %{"spot" => @car_spot})
    ref = push(dchan, "cancel_request", %{})
    assert_reply ref, :ok
    {:ok, _, world} = subscribe_and_join(rsock, "world", %{})
    ref = push(world, "sync", %{"geo" => [@cell]})
    assert_reply ref, :ok
    {rchan, world}
  end

  test "your map channel too busy to answer: 'busy' within about a second — not 'unavailable'",
       %{rider: rider, driver: driver} do
    {rchan, world} = car_in_view(rider, driver)
    :sys.suspend(world.channel_pid)

    try do
      {us, _} =
        :timer.tc(fn ->
          ref = push(rchan, "send_msg", %{"to" => driver.id, "text" => "hi"})
          assert_reply ref, :error, %{reason: "busy"}, 4_000
        end)

      assert us < 3_000_000, "waited #{div(us, 1000)} ms"
    after
      :sys.resume(world.channel_pid)
    end

    # nothing spent: once it answers, the same message goes
    ref = push(rchan, "send_msg", %{"to" => driver.id, "text" => "hi"})
    assert_reply ref, :ok, %{id: _}
  end

  test "someone really not on your screen: still 'unavailable'", %{rider: rider} do
    {:ok, _, rchan} = subscribe_and_join(connect_as(rider), "user:#{rider.id}", %{})
    ref = push(rchan, "send_msg", %{"to" => 4_294_967_999, "text" => "hi"})
    assert_reply ref, :error, %{reason: "unavailable"}
  end
end
