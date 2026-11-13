defmodule HoodrideWeb.RobustnessTest do
  @moduledoc "Hostile/buggy clients get error replies, never channel crashes."
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rob", name: "Rob"})

    :ok = Hoodride.TestHelpers.give_car(user.id)

    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(socket, "user:#{user.id}", %{})
    %{user: user, socket: socket, chan: chan}
  end

  test "malformed payloads reply bad_request and the channel survives", %{chan: chan, user: u} do
    bad_pushes = [
      {"send_msg", %{"to" => "not-an-int", "text" => "hi"}},
      {"send_msg", %{"to" => u.id, "text" => ""}},
      {"send_msg", %{"wrong" => "shape"}},
      {"request_ride", %{"to" => "abc"}},
      {"accept_request", %{"rider_id" => [1, 2]}},
      {"decline_request", %{}},
      {"driver_update", %{"cell" => 123, "lat" => "x", "lng" => nil}},
      {"hand_up", %{"cell" => %{"nested" => true}}},
      {"hand_up", %{"cell" => "ok", "spot" => String.duplicate("z", 500)}},
      {"totally_made_up_event", %{}}
    ]

    for {event, payload} <- bad_pushes do
      ref = push(chan, event, payload)
      assert_reply ref, :error, %{reason: "bad_request"}
    end

    # channel is still alive and functional after all that abuse
    ref = push(chan, "hand_up", %{"spot" => "892a1072c63ffff"})
    refute_reply ref, :error
    assert [%{id: _}] = Hoodride.Geo.cell_snapshot("882a1072c7fffff").hands
  end

  test "the world channel is read-only (writes live on the user channel)",
       %{socket: socket} do
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    ref = push(world, "driver_update", %{"cell" => "anycell", "lat" => 1.0, "lng" => 2.0})
    assert_reply ref, :error, %{reason: "read_only"}
    assert Hoodride.Geo.cell_snapshot("anycell").drivers == []
  end

  test "joining a nonexistent ride is refused", %{socket: socket} do
    assert {:error, %{reason: "gone"}} = subscribe_and_join(socket, "ride:r-ghost", %{})
  end

  @tag :per_message
  test "a driver moving cells notifies both cells", %{chan: chan, user: u} do
    {:ok, other} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "rob2", name: "Rob2"})

    {:ok, watcher_sock} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(other.id)}
      )

    {:ok, _, world} = subscribe_and_join(watcher_sock, "world", %{})
    ref = push(world, "sync", %{"geo" => ["882a1072c7fffff", "882a1072c9fffff"]})
    assert_reply ref, :ok

    push(chan, "driver_update", %{"spot" => "892a1072c63ffff"})
    assert_push "driver_update", %{id: driver_id, spot: "892a1072c63ffff"}
    assert driver_id == u.id

    push(chan, "driver_update", %{"spot" => "892a1072c97ffff"})
    assert_push "driver_left", %{id: ^driver_id}
    assert_push "driver_update", %{id: ^driver_id, spot: "892a1072c97ffff"}

    assert Hoodride.Geo.cell_snapshot("882a1072c7fffff").drivers == []
    assert [%{spot: "892a1072c97ffff"}] = Hoodride.Geo.cell_snapshot("882a1072c9fffff").drivers
  end
end
