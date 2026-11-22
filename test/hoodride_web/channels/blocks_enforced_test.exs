defmodule HoodrideWeb.BlocksEnforcedTest do
  @moduledoc """
  Blocks, where they're enforced (owner, 2026-11-15 — Hoodride.Blocks,
  Hoodride.BlockEffects). Ann blocks Bob. Either way:

    * the map: the other's car / ✋ never reaches their app — live updates
      and the snapshot of a cell alike (each watcher's own map channel
      drops it); a name tap is "unavailable";
    * messages and ride requests: the ordinary "unavailable";
    * what was between them ends: a request (cancelled or declined, as any
      other), a ride, their chat (closed with no "ended by"), and each map
      drops the other's marker at once;
    * a request accepted in the moment of the block never becomes a ride.

  Each person is their own process (their own connection), so what reaches
  whose app is told apart.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Blocks, Chat, Requests, Rides}

  @spot "892a1072c67ffff"
  @cell "882a1072c7fffff"
  @car %{"color" => "Blue", "make" => "Toyota", "model" => "Camry"}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user!(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    :ok = Hoodride.Accounts.agree_to_terms(u.id)
    u
  end

  defp driver!(key) do
    u = user!(key)
    {:ok, _} = Hoodride.Accounts.set_car(u.id, @car)
    u
  end

  # one person's app: its user channel (and map, watching @cell), in its own
  # process; everything it's sent comes back as {name, event, payload}
  defp person(name, user) do
    test = self()

    pid =
      spawn_link(fn ->
        {:ok, socket} =
          connect(HoodrideWeb.UserSocket, %{},
            connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)},
            test_process: test
          )

        {:ok, _, chan} = subscribe_and_join(socket, "user:#{user.id}", %{})
        {:ok, _, world} = subscribe_and_join(socket, "world", %{})
        send(test, {name, :ready})
        loop(test, name, chan, world)
      end)

    assert_receive {^name, :ready}, 2_000
    %{name: name, pid: pid, user: user}
  end

  defp loop(test, name, chan, world) do
    receive do
      {:do, :user, event, payload, from} ->
        ref = push(chan, event, payload)

        receive do
          %Phoenix.Socket.Reply{ref: ^ref} = r -> send(from, {:did, r.status, r.payload})
        after
          2_000 -> send(from, {:did, :timeout, nil})
        end

      {:do, :world, event, payload, from} ->
        ref = push(world, event, payload)

        receive do
          %Phoenix.Socket.Reply{ref: ^ref} = r -> send(from, {:did, r.status, r.payload})
        after
          2_000 -> send(from, {:did, :timeout, nil})
        end

      %Phoenix.Socket.Message{event: event, payload: payload} ->
        send(test, {name, event, payload})

      _ ->
        :ok
    end

    loop(test, name, chan, world)
  end

  # → {status, payload}
  defp act(p, where, event, payload) do
    send(p.pid, {:do, where, event, payload, self()})

    receive do
      {:did, status, reply} -> {status, reply}
    after
      3_000 -> flunk("#{p.name}: no reply to #{event}")
    end
  end

  defp watch(p), do: assert({:ok, _} = act(p, :world, "sync", %{"geo" => [@cell]}))
  defp online(p), do: act(p, :user, "driver_update", %{"spot" => @spot})

  defp got?(name, event, id, wait \\ 300) do
    receive do
      {^name, ^event, %{id: ^id}} -> true
    after
      wait -> false
    end
  end

  defp block!(a, b) do
    assert {:ok, _} = act(a, :user, "block", %{"peer" => b.user.id})
  end

  describe "the map" do
    test "a blocked driver's car never reaches the one who blocked — others still see it" do
      [ann, carol] = [person(:ann, user!("be-ann")), person(:carol, user!("be-carol"))]
      bob = person(:bob, driver!("be-bob"))
      watch(ann)
      watch(carol)
      block!(ann, bob)

      online(bob)
      assert got?(:carol, "driver_update", bob.user.id)
      refute got?(:ann, "driver_update", bob.user.id)
    end

    test "…nor the one blocked: both ways (Bob blocked Ann; Ann can't see Bob's car)" do
      ann = person(:ann, user!("be2-ann"))
      bob = person(:bob, driver!("be2-bob"))
      watch(ann)
      block!(bob, ann)
      online(bob)
      refute got?(:ann, "driver_update", bob.user.id)
    end

    test "the snapshot of a cell leaves them out too" do
      bob = person(:bob, driver!("be3-bob"))
      online(bob)
      [ann, carol] = [person(:ann, user!("be3-ann")), person(:carol, user!("be3-carol"))]
      :ok = Blocks.block(ann.user.id, bob.user.id)

      {:ok, %{geo: [%{drivers: seen}]}} = act(ann, :world, "sync", %{"geo" => [@cell]})
      {:ok, %{geo: [%{drivers: theirs}]}} = act(carol, :world, "sync", %{"geo" => [@cell]})
      assert seen == []
      assert [%{id: id}] = theirs
      assert id == bob.user.id
    end

    test "a raised hand: a blocked driver never sees it" do
      rider = person(:ann, user!("be4-ann"))
      bob = person(:bob, driver!("be4-bob"))
      online(bob)
      # (an online driver watches hands)
      assert {:ok, _} = act(bob, :world, "sync", %{"geo" => [@cell]})
      block!(rider, bob)
      act(rider, :user, "hand_up", %{"spot" => @spot})
      refute got?(:bob, "hand_update", rider.user.id)
    end

    test "blocking takes the marker off at once — not at the next update" do
      ann = person(:ann, user!("be5-ann"))
      bob = person(:bob, driver!("be5-bob"))
      watch(ann)
      online(bob)
      assert got?(:ann, "driver_update", bob.user.id)
      block!(ann, bob)
      assert got?(:ann, "driver_left", bob.user.id, 1_000)
    end

    # (owner, 2026-11-15) unsure means blocked — but a database hiccup at
    # the moment of a parked car's one update hid it for good: it sends no
    # other. The viewer's blocks are read when their map joins; a failed
    # read is tried again, and the screen sent afresh once it works
    test "the database briefly can't answer: a parked car still shows once it can" do
      # (Bob's app joins first: from here on the database refuses twice —
      # the read as Ann's map joins, and the one when Bob's update comes;
      # only the try again and the screen sent afresh bring him back)
      bob = person(:bob, driver!("be8-bob"))
      {:ok, refusals} = Agent.start_link(fn -> 2 end)

      Application.put_env(:hoodride, :blocks_hook, fn
        :read ->
          if Agent.get_and_update(refusals, &{&1, max(&1 - 1, 0)}) > 0,
            do: raise(DBConnection.ConnectionError, "busy")

        _ ->
          :ok
      end)

      on_exit(fn -> Application.delete_env(:hoodride, :blocks_hook) end)

      ann = person(:ann, user!("be8-ann"))
      watch(ann)
      online(bob)
      # (Bob parked from here: no update of his own)
      assert got?(:ann, "driver_update", bob.user.id, 3_000), "Bob's car never reached Ann"
    end

    test "a name tap on them: 'unavailable', as anyone out of view" do
      ann = person(:ann, user!("be6-ann"))
      bob = person(:bob, driver!("be6-bob"))
      online(bob)
      watch(ann)
      assert {:ok, %{name: "be6-bob"}} = act(ann, :world, "reveal", %{"id" => bob.user.id})
      :ok = Blocks.block(bob.user.id, ann.user.id)

      assert {:error, %{reason: "unavailable"}} =
               act(ann, :world, "reveal", %{"id" => bob.user.id})
    end

    # (a parked car sends no updates: "at its next update" was never, for
    # one standing still — the block journey, 2026-11-15)
    test "unblocked: seen again at once — a parked car too" do
      ann = person(:ann, user!("be7-ann"))
      bob = person(:bob, driver!("be7-bob"))
      online(bob)
      watch(ann)
      block!(ann, bob)
      assert got?(:ann, "driver_left", bob.user.id, 1_000)
      # Bob parked: no update of his own from here
      assert {:ok, _} = act(ann, :user, "unblock", %{"peer" => bob.user.id})
      assert got?(:ann, "driver_update", bob.user.id, 1_000)
    end

    # (owner, 2026-11-21: "if you unblock a ✋ it doesn't show up at once?")
    # a raised hand too: back on the driver's map at once — a hand still
    # sends no update of its own
    test "unblocked: a raised hand seen again at once by the driver" do
      ann = person(:ann, user!("be9-ann"))
      bob = person(:bob, driver!("be9-bob"))
      online(bob)
      assert {:ok, _} = act(bob, :world, "sync", %{"geo" => [@cell]})
      act(ann, :user, "hand_up", %{"spot" => @spot})
      assert got?(:bob, "hand_update", ann.user.id, 1_000)
      block!(ann, bob)
      refute got?(:bob, "hand_update", ann.user.id)
      assert {:ok, _} = act(ann, :user, "unblock", %{"peer" => bob.user.id})
      assert got?(:bob, "hand_update", ann.user.id, 1_000)
    end
  end

  describe "contact" do
    test "messages: refused both ways with the ordinary 'unavailable' — even in an open chat" do
      ann = person(:ann, user!("bc-ann"))
      bob = person(:bob, user!("bc-bob"))
      # (they talk: the chat makes them "related" — the cold-contact rules don't apply)
      {:ok, _} =
        Chat.send_message(%{id: bob.user.id, name: "bc-bob", photo: nil}, ann.user.id, "hi")

      :ok = Blocks.block(ann.user.id, bob.user.id)

      assert {:error, %{reason: "unavailable"}} =
               act(bob, :user, "send_msg", %{"to" => ann.user.id, "text" => "hello?"})

      assert {:error, %{reason: "unavailable"}} =
               act(ann, :user, "send_msg", %{"to" => bob.user.id, "text" => "hi"})
    end

    test "a ride request to them: 'unavailable'" do
      ann = person(:ann, user!("bc2-ann"))
      bob = person(:bob, driver!("bc2-bob"))
      online(bob)
      watch(ann)
      :ok = Blocks.block(bob.user.id, ann.user.id)

      assert {:error, %{reason: "unavailable"}} =
               act(ann, :user, "request_ride", %{"to" => bob.user.id})

      assert Requests.open_request_of(ann.user.id) == nil
    end
  end

  describe "what a block ends" do
    test "their chat: closed for both, with no 'ended by' — a plain close" do
      ann = person(:ann, user!("bx-ann"))
      bob = person(:bob, user!("bx-bob"))

      {:ok, _} =
        Chat.send_message(%{id: bob.user.id, name: "bx-bob", photo: nil}, ann.user.id, "hi")

      block!(ann, bob)

      assert_receive {:bob, "chat_closed", closed}, 1_000
      refute Map.has_key?(closed, :ended_by), "Bob isn't told who ended it"
      # …nor a reason that isn't true ("away": Ann was here) — a neutral close
      assert closed.reason == "ended"
      refute Chat.exists?(ann.user.id, bob.user.id)
    end

    # (review of the block journeys, 2026-11-20) a message that passed the
    # block check just before the block was saved, written just after its
    # chat was deleted: it must not start their chat again, nor reach the
    # one who blocked. The send's own last look (Chat.send_message): block
    # saves then deletes; a send writes then looks — one always sees the other
    test "a message in the moment of the block never brings their chat back" do
      ann = person(:ann, user!("bx6-ann"))
      bob = person(:bob, user!("bx6-bob"))
      bob_as = %{id: bob.user.id, name: "bx6-bob", photo: nil}
      {:ok, _} = Chat.send_message(bob_as, ann.user.id, "hi")
      assert_receive {:ann, "msg", _}, 1_000

      block!(ann, bob)
      assert_receive {:bob, "chat_closed", _}, 1_000

      # Bob's send, its block check already passed: the message lands now
      assert {:error, :unavailable} = Chat.send_message(bob_as, ann.user.id, "still there?")
      refute Chat.exists?(ann.user.id, bob.user.id)
      refute_receive {:ann, "msg", _}, 300
      refute Enum.any?(Chat.conversations_for(ann.user.id), &(&1.peer_id == bob.user.id))
    end

    test "a request between them: the blocked rider's is declined (as any decline)" do
      bob = person(:bob, driver!("bx2-bob"))
      online(bob)
      ann = person(:ann, user!("bx2-ann"))
      watch(ann)
      assert {:ok, _} = act(ann, :user, "request_ride", %{"to" => bob.user.id})
      block!(bob, ann)
      assert_receive {:ann, "request_declined", %{by_id: by}}, 1_000
      assert by == bob.user.id
      assert Requests.open_request_of(ann.user.id) == nil
    end

    test "…and the rider who blocks the driver withdraws theirs (the driver told: cancelled)" do
      bob = person(:bob, driver!("bx3-bob"))
      online(bob)
      ann = person(:ann, user!("bx3-ann"))
      watch(ann)
      assert {:ok, _} = act(ann, :user, "request_ride", %{"to" => bob.user.id})
      block!(ann, bob)
      assert_receive {:bob, "request_cancelled", %{from_id: from}}, 1_000
      assert from == ann.user.id
    end

    test "a ride together: ended" do
      bob = person(:bob, driver!("bx4-bob"))
      online(bob)
      ann = person(:ann, user!("bx4-ann"))
      watch(ann)
      assert {:ok, _} = act(ann, :user, "request_ride", %{"to" => bob.user.id})
      assert {:ok, _} = act(bob, :user, "accept_request", %{"rider_id" => ann.user.id})
      assert Rides.partners?(ann.user.id, bob.user.id)

      block!(ann, bob)
      refute Rides.partners?(ann.user.id, bob.user.id)
      assert Rides.ride_id_of_user(bob.user.id) == nil
    end

    test "an accept in the moment of the block never becomes a ride" do
      bob = person(:bob, driver!("bx5-bob"))
      online(bob)
      ann = person(:ann, user!("bx5-ann"))
      watch(ann)
      assert {:ok, _} = act(ann, :user, "request_ride", %{"to" => bob.user.id})
      # the block saved, its effects not yet run — the accept lands between
      :ok = Blocks.block(ann.user.id, bob.user.id)
      act(bob, :user, "accept_request", %{"rider_id" => ann.user.id})
      refute Rides.partners?(ann.user.id, bob.user.id)
    end
  end

  test "refusals: yourself, and past the day's blocks and unblocks" do
    ann = person(:ann, user!("br-ann"))
    assert {:error, %{reason: "self"}} = act(ann, :user, "block", %{"peer" => ann.user.id})

    others = for i <- 1..Hoodride.Limits.block_actions_per_day(), do: user!("br-#{i}")
    for o <- others, do: assert({:ok, _} = act(ann, :user, "block", %{"peer" => o.id}))

    assert {:error, %{reason: "rate_limited"}} =
             act(ann, :user, "block", %{"peer" => user!("br-over").id})

    assert {:error, %{reason: "bad_request"}} = act(ann, :user, "block", %{"peer" => "x"})
  end
end
