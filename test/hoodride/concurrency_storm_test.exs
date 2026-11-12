defmodule Hoodride.ConcurrencyStormTest do
  @moduledoc """
  True-parallelism adversary: many processes hammer the SAME small user set
  with racing geo/request/ride mutations — the interleavings the sequential
  fuzzer structurally cannot produce (two tabs of one account, accepts racing
  offlines, creates racing ride starts). The contract under fire is eventual
  consistency: after the storm quiesces, ONE sweep restores every invariant.
  """
  use ExUnit.Case

  @moduletag timeout: 120_000

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    users =
      for key <- ["st-1", "st-2", "st-3", "st-4"] do
        {:ok, u} =
          Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

        u
      end

    # present, so the grace reaper doesn't empty the world mid-test
    for u <- users, do: Hoodride.Geo.user_connected(u.id)

    %{users: users}
  end

  defp parents_for(u), do: ["c7-#{rem(u.id, 2)}", "c5-shared"]

  # raw Geo/Requests calls on purpose: this simulates the worst case where
  # channel-level guards were passed BEFORE the race resolved
  defp random_op(users) do
    u = Enum.random(users)
    m = %{id: u.id, name: u.name, photo: nil}

    case :rand.uniform(11) do
      1 -> Hoodride.Geo.driver_update(m, "cell8", nil, parents_for(u))
      2 -> Hoodride.Geo.hand_up(u.id, "cell8", "spot9", parents_for(u))
      3 -> Hoodride.Geo.hand_down(u.id)
      4 -> Hoodride.Geo.driver_offline(u.id)
      5 -> Hoodride.Requests.create(m, Enum.random(users).id)
      6 -> Hoodride.Requests.cancel(u.id)
      7 -> Hoodride.Requests.accept(m, Enum.random(users).id)
      8 -> Hoodride.Requests.decline(u.id, Enum.random(users).id)
      9 -> end_own_ride(u)
      # the diff-based reconciler is commutative with live shifts, so it can
      # fire INTO the melee — the overwrite design would fail this storm
      10 -> Hoodride.Geo.recompute_aggregates()
      11 -> Hoodride.Chat.send_message(m, Enum.random(users -- [u]).id, "storm msg")
    end
  rescue
    # a racing op may legitimately crash into a dying ride process — the
    # storm cares about end-state invariants, not individual op fates
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  defp end_own_ride(u) do
    case Hoodride.Rides.ride_id_of_user(u.id) do
      nil -> :ok
      :pending -> :ok
      ride_id -> Hoodride.Rides.end_ride(ride_id, u.id)
    end
  end

  test "same-user ops serialize: car/hand ping-pong from parallel processes leaves ONE identity",
       %{users: [u | _]} do
    # routing determinism — the mechanism the guarantee rests on:
    # the same key always resolves to the same shard process
    shard = fn key ->
      GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, key}})
    end

    assert shard.(u.id) == shard.(u.id)

    m = %{id: u.id, name: u.name, photo: nil}

    tasks =
      for flavor <- [:car, :hand, :car, :hand] do
        Task.async(fn ->
          for _ <- 1..150 do
            case flavor do
              :car -> Hoodride.Geo.driver_update(m, "cell8", nil, ["c7-x"])
              :hand -> Hoodride.Geo.hand_up(u.id, "cell8", "spot9", ["c7-x"])
            end
          end
        end)
      end

    Task.await_many(tasks, 30_000)

    # NO sweep — this is the writer's own guarantee, not the healer's:
    # whatever the interleaving, exactly one identity survives
    car? = Hoodride.Geo.driver_on_map?(u.id)
    hand? = :ets.lookup(:geo_hands, u.id) != []

    assert car? != hand?,
           "user ended as #{if car? and hand?, do: "BOTH car and hand", else: "NEITHER"}"

    assert [{_, role, _}] = :ets.lookup(:geo_parents, u.id)
    assert role == if(car?, do: :driver, else: :hand)
  end

  test "a crashed writer shard restarts under supervision and service resumes",
       %{users: [u | _]} do
    via = {:via, PartitionSupervisor, {Hoodride.GeoWriters, u.id}}
    pid = GenServer.whereis(via)
    ref = Process.monitor(pid)
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^ref, :process, ^pid, :killed}

    # supervisor brings the shard back; the next op on it just works
    # (generous cap: under heavy compile/load churn a restart can lag)
    await_restart(via, pid, 300)

    Hoodride.Geo.driver_update(
      %{id: u.id, name: u.name, photo: nil},
      "cell8",
      nil,
      parents_for(u)
    )

    assert Hoodride.Geo.driver_on_map?(u.id)
    assert GenServer.whereis(via) != pid
    Hoodride.TestHelpers.assert_world_invariants([u], :geo)
  end

  defp await_restart(_via, _old, 0), do: flunk("writer shard was not restarted")

  defp await_restart(via, old, tries) do
    case GenServer.whereis(via) do
      pid when is_pid(pid) and pid != old ->
        :ok

      _ ->
        Process.sleep(10)
        await_restart(via, old, tries - 1)
    end
  end

  test "reconciler duel: healing fired point-blank into a shift stream stays exact",
       %{users: users} do
    # the recount runs in its own process and pauses every shard between
    # ops — fired point-blank into the toggling, it must never read mid-op
    u = hd(users)
    m = %{id: u.id, name: u.name, photo: nil}

    # MANY short rounds, each ending ON (truth = exactly one driver) with its
    # own assert: a healer heals its own clobbers, so one long duel only
    # tests the final iteration — fifty short duels test fifty finales.
    # The diff reconciler commutes with the shifts and must pass every round;
    # the old overwrite design writes a stale-phase zero over the final
    # arrival often enough that fifty rounds make detection near-certain.
    for _round <- 1..50 do
      toggler =
        Task.async(fn ->
          for _ <- 1..9 do
            Hoodride.Geo.driver_update(m, "cell8", nil, parents_for(u))
            Hoodride.Geo.driver_offline(u.id)
          end

          Hoodride.Geo.driver_update(m, "cell8", nil, parents_for(u))
        end)

      healer = Task.async(fn -> for _ <- 1..4, do: Hoodride.Geo.recompute_aggregates() end)
      Task.await_many([toggler, healer], 30_000)

      # no sweep: counters must already equal truth (one driver, counted once)
      Hoodride.TestHelpers.assert_world_invariants([u], :geo)
      Hoodride.Geo.driver_offline(u.id)
    end
  end

  test "chat under fire: concurrent senders lose nothing, history keeps exactly the newest #{Hoodride.Limits.chat_history()}",
       %{users: [a, b | _]} do
    ma = %{id: a.id, name: a.name, photo: nil}
    mb = %{id: b.id, name: b.name, photo: nil}

    # four tasks hammer the SAME conversation from both sides — 120 sends
    # against the message cap (Hoodride.Limits.chat_history). duplicate_bag appends are per-message objects
    # (no read-modify-write), and trims are prefix-deletes of one sorted
    # order, so nothing in flight can be lost or double-counted.
    tasks =
      for sender <- [ma, mb, ma, mb] do
        other = if sender.id == a.id, do: b.id, else: a.id

        Task.async(fn ->
          for i <- 1..30 do
            {:ok, %{id: id}} = Hoodride.Chat.send_message(sender, other, "msg #{i}")
            id
          end
        end)
      end

    issued = tasks |> Task.await_many(30_000) |> List.flatten() |> Enum.sort()
    assert length(issued) == 120

    key = Hoodride.Chat.pair_key(a.id, b.id)

    surviving =
      :ets.lookup(:chat_messages, key)
      |> Enum.map(fn {_k, id, _s, _t, _ts} -> id end)
      |> Enum.sort()

    # exactly the cap survives, and it is PRECISELY the newest of the 120
    # ids ever issued — oldest trimmed, none lost in the middle, none doubled
    assert surviving == Enum.take(issued, -Hoodride.Limits.chat_history())
  end

  test "a parallel storm of same-account mutations converges to a lawful world after one sweep",
       %{users: users} do
    tasks =
      for _ <- 1..24 do
        Task.async(fn ->
          for _ <- 1..40, do: random_op(users)
        end)
      end

    Task.await_many(tasks, 60_000)

    # the GeoWriter makes the geo invariants ATOMIC — they must already
    # hold the instant the storm quiesces, before any sweep runs
    Hoodride.TestHelpers.assert_world_invariants(users, :geo)

    # the cross-system races (request-vs-geo) are the sweep's job
    Hoodride.Sweeper.sweep_now()
    Hoodride.TestHelpers.assert_world_invariants(users, :all)
  end
end
