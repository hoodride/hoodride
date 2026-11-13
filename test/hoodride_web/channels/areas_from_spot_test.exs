defmodule HoodrideWeb.AreasFromSpotTest do
  @moduledoc """
  Step 5 (owner, 2026-11-13). The app used to send its block (`spot`), its
  neighborhood (`cell`) AND the wider areas its zoomed-out counts use
  (`parents`), and the server believed all three: one car could count in up
  to 4 areas anywhere — other cities — and move them every update. Now the
  server works every area out from the block itself (Hoodride.H3) and
  ignores anything else sent. Cars and ✋ alike.

  And a car needs a car: the app asks for one before going online, the
  server never checked — anyone could appear as a 🚗 with nothing on file.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  # real blocks (h3-js): lower Manhattan, a few blocks north, Los Angeles
  @spot "892a1072c67ffff"
  @cell "882a1072c7fffff"
  @wider ["872a1072cffffff", "852a1073fffffff"]
  @spot2 "892a1072c97ffff"
  @cell2 "882a1072c9fffff"
  @la_cell "8829a1d757fffff"
  @la_wider ["8729a1d75ffffff", "8529a1d7fffffff"]
  @car %{"color" => "Blue", "make" => "Toyota", "model" => "Camry"}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    user = user!("afs-driver")
    {:ok, _} = Hoodride.Accounts.set_car(user.id, @car)
    %{user: user, chan: join!(user)}
  end

  defp user!(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  defp join!(user) do
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(socket, "user:#{user.id}", %{})
    chan
  end

  # the push has been handled (the channel answers in order)
  defp settled(chan) do
    ref = push(chan, "made_up_event", %{})
    assert_reply ref, :error, %{reason: "bad_request"}
  end

  defp counted_in(user_id), do: :ets.lookup(:geo_parents, user_id)

  describe "the server works out the areas from the block" do
    test "a car claiming a far-away neighborhood and areas is filed where its block is",
         %{chan: chan, user: u} do
      push(chan, "driver_update", %{"cell" => @la_cell, "spot" => @spot, "parents" => @la_wider})
      settled(chan)

      assert Hoodride.Geo.driver_cell(u.id) == @cell
      assert [%{id: id, spot: @spot}] = Hoodride.Geo.cell_snapshot(@cell).drivers
      assert id == u.id
      assert Hoodride.Geo.cell_snapshot(@la_cell).drivers == []

      assert counted_in(u.id) == [{u.id, :driver, @wider}]
      for c <- @wider, do: assert(Hoodride.Geo.agg_counts_for(c).drivers == 1)
      for c <- @la_wider, do: assert(Hoodride.Geo.agg_counts_for(c).drivers == 0)
    end

    test "the app's new message — the block only — is enough", %{chan: chan, user: u} do
      push(chan, "driver_update", %{"spot" => @spot})
      settled(chan)
      assert Hoodride.Geo.driver_cell(u.id) == @cell
      assert counted_in(u.id) == [{u.id, :driver, @wider}]
    end

    test "made-up areas, even many, count nowhere", %{chan: chan, user: u} do
      junk = for i <- 1..20, do: "zz#{i}"
      push(chan, "driver_update", %{"spot" => @spot, "parents" => junk})
      settled(chan)
      assert counted_in(u.id) == [{u.id, :driver, @wider}]
      for c <- junk, do: assert(Hoodride.Geo.agg_counts_for(c) == %{drivers: 0, hands: 0})
    end

    test "a car moving: watchers of each neighborhood hear it", %{chan: chan, user: u} do
      watcher = user!("afs-watcher")

      {:ok, wsock} =
        connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{session: Hoodride.TestHelpers.session_for(watcher.id)}
        )

      {:ok, _, world} = subscribe_and_join(wsock, "world", %{})
      ref = push(world, "sync", %{"geo" => [@cell, @cell2]})
      assert_reply ref, :ok

      id = u.id
      push(chan, "driver_update", %{"cell" => "elsewhere", "spot" => @spot})
      assert_push "driver_update", %{id: ^id, cell: @cell, spot: @spot}

      push(chan, "driver_update", %{"cell" => @cell, "spot" => @spot2})
      assert_push "driver_left", %{id: ^id}
      assert_push "driver_update", %{id: ^id, cell: @cell2, spot: @spot2}
    end

    test "a ✋ too: filed and counted where its block is" do
      rider = user!("afs-rider")
      chan = join!(rider)

      push(chan, "hand_up", %{"cell" => @la_cell, "spot" => @spot, "parents" => @la_wider})
      settled(chan)

      assert Hoodride.Geo.hand_cell(rider.id) == @cell
      assert Hoodride.Geo.hand_of(rider.id) == %{cell: @cell, spot: @spot}
      assert counted_in(rider.id) == [{rider.id, :hand, @wider}]
      for c <- @la_wider, do: assert(Hoodride.Geo.agg_counts_for(c).hands == 0)
    end

    test "not a real block: refused, nothing on the map", %{chan: chan, user: u} do
      bad = [
        %{"spot" => @cell},
        %{"spot" => "892A1072C67FFFF"},
        %{"spot" => "892a1072c67fff7"},
        %{"spot" => "cellA"},
        %{"spot" => 42},
        %{"cell" => @cell},
        %{"cell" => @cell, "lat" => 1.0, "lng" => 2.0},
        %{}
      ]

      for event <- ["driver_update", "hand_up"], payload <- bad do
        ref = push(chan, event, payload)
        assert_reply ref, :error, %{reason: "bad_request"}, 1_000
      end

      assert Hoodride.Geo.driver_cell(u.id) == nil
      assert Hoodride.Geo.hand_cell(u.id) == nil
      assert counted_in(u.id) == []
    end
  end

  describe "a car needs a car" do
    test "no car on file: refused, never on the map" do
      carless = user!("afs-carless")
      chan = join!(carless)

      ref = push(chan, "driver_update", %{"spot" => @spot})
      assert_reply ref, :error, %{reason: "no_car"}
      assert Hoodride.Geo.driver_cell(carless.id) == nil
      assert counted_in(carless.id) == []
      assert Hoodride.Geo.agg_counts_for(hd(@wider)).drivers == 0
    end

    test "a car saved AFTER connecting counts (the server asks the database, not the connection)" do
      later = user!("afs-later")
      chan = join!(later)

      ref = push(chan, "driver_update", %{"spot" => @spot})
      assert_reply ref, :error, %{reason: "no_car"}

      {:ok, _} = Hoodride.Accounts.set_car(later.id, @car)
      push(chan, "driver_update", %{"spot" => @spot})
      settled(chan)
      assert Hoodride.Geo.driver_cell(later.id) == @cell
    end

    test "a ✋ needs no car" do
      rider = user!("afs-rider2")
      chan = join!(rider)
      push(chan, "hand_up", %{"spot" => @spot})
      settled(chan)
      assert Hoodride.Geo.hand_cell(rider.id) == @cell
    end
  end
end
