defmodule HoodrideWeb.WorldChannelTest do
  @moduledoc """
  The multiplexer (Option B) with a LEVEL-TRIGGERED sync: every sync carries
  the client's complete desired set and the server reconciles. Covers
  reconciliation, idempotence, the all-or-nothing cap, the sync lane with
  retry_ms, and the self-healing property that motivated the design.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.Geo

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "wc-u", name: "WC"})

    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    %{world: world}
  end

  defp cells(prefix, n), do: for(i <- 1..n, do: "#{prefix}#{i}")

  defp sync(world, payload) do
    ref = push(world, "sync", payload)

    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: reply} -> {status, reply}
    after
      1_000 -> flunk("no reply to sync")
    end
  end

  # who the PubSub registry says is subscribed to a cell's CAR topic (this
  # user is a viewer, so a geo cell means the car layer; role_privacy_test
  # covers the other roles)
  defp subscribers(cell),
    do: Registry.lookup(Hoodride.PubSub, Hoodride.Geo.geo_topic(:drivers, cell))

  test "one process holds many subscriptions — no process per cell", %{world: world} do
    wanted = cells("g", 80)

    # every process the CHANNEL starts during the sync (Erlang's spawn
    # trace). It used to diff Process.list() for the whole VM — which also
    # caught unrelated short-lived processes: an earlier test's socket
    # join-deadline check (:timer.apply_after spawns one when it fires, 10 s
    # after each connect) landing in this window failed it as "sync spawned
    # 2 processes" (2026-10-29; traced: the check runs in a new process)
    :erlang.trace(world.channel_pid, true, [:procs, {:tracer, self()}])
    assert {:ok, _} = sync(world, %{"geo" => wanted})
    :erlang.trace(world.channel_pid, false, [:procs])

    # every one of the 80 topics has exactly ONE subscriber: this channel
    for cell <- wanted do
      assert [{pid, _}] = subscribers(cell)
      assert pid == world.channel_pid
    end

    spawned = for {:trace, _, :spawn, pid, mfa} <- flush_traces(), do: {pid, mfa}
    assert spawned == [], "sync spawned #{length(spawned)} processes: #{inspect(spawned)}"
  end

  defp flush_traces(acc \\ []) do
    receive do
      {:trace, _, _, _, _} = t -> flush_traces([t | acc])
      {:trace, _, _, _} = t -> flush_traces([t | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  @tag :per_message
  test "a full set is reconciled: new cells snapshot, dropped cells go silent",
       %{world: world} do
    driver = %{id: 901, name: "D901", photo: nil}

    # a viewer's snapshot carries its own layer only
    assert {:ok, %{geo: [%{cell: "cQ", drivers: []} = snap]}} = sync(world, %{"geo" => ["cQ"]})
    refute Map.has_key?(snap, :hands)

    Geo.driver_update(driver, "cQ", nil)
    assert_push "driver_update", %{id: 901}

    # the next full set no longer includes cQ → unsubscribed
    assert {:ok, %{geo: [%{cell: "cR"}]}} = sync(world, %{"geo" => ["cR"]})
    assert subscribers("cQ") == []
    # silence proven with an event that ALWAYS broadcasts (a car leaving): a
    # repeat update of a parked car is announced to no one, so a refute on
    # it passed even with the unsubscribe broken (mutant-checked 2026-10-25)
    Geo.driver_offline(driver.id)
    refute_push "driver_left", %{id: 901}, 150
  end

  # Zooming out past the cars (app.js syncGeoSubscriptions → setWanted(no
  # cells, count hexes)): the car cells must go on the SERVER, not only off
  # the screen. Checked with events that always broadcast — a car leaving,
  # a new car arriving — so a silence can't come from "nothing happened".
  @tag :per_message
  test "zooming out to count hexes unsubscribes every car cell", %{world: world} do
    parked = %{id: 902, name: "D902", photo: nil}
    arriving = %{id: 903, name: "D903", photo: nil}

    assert {:ok, _} = sync(world, %{"geo" => ["zA", "zB"], "agg" => []})
    Geo.driver_update(parked, "zA", "zA-spot")
    assert_push "driver_update", %{id: 902}

    # zoomed out: count hexes only, the car set empty
    assert {:ok, %{geo: []}} = sync(world, %{"geo" => [], "agg" => ["zP"]})
    assert subscribers("zA") == []
    assert subscribers("zB") == []
    assert [{pid, _}] = Registry.lookup(Hoodride.PubSub, Geo.agg_topic(:drivers, "zP"))
    assert pid == world.channel_pid

    Geo.driver_offline(parked.id)
    Geo.driver_update(arriving, "zB", "zB-spot")
    refute_push "driver_left", %{id: 902}, 150
    refute_push "driver_update", %{id: 903}, 150
  end

  test "sending the same set again changes nothing and returns no snapshots",
       %{world: world} do
    assert {:ok, %{geo: first}} = sync(world, %{"geo" => cells("g", 50)})
    assert length(first) == 50

    for _ <- 1..3 do
      assert {:ok, %{geo: [], agg: []}} = sync(world, %{"geo" => cells("g", 50)})
    end

    # and never a duplicate subscription (that would deliver updates twice)
    for cell <- cells("g", 50), do: assert(length(subscribers(cell)) == 1)
  end

  @tag :per_message
  test "the cap is all or nothing: 121 is refused and NOTHING changes", %{world: world} do
    assert {:ok, _} = sync(world, %{"geo" => cells("g", 80), "agg" => cells("a", 40)})

    # an over-cap desired set: refused before anything is touched
    assert {:error, %{reason: "watch_limit"}} =
             sync(world, %{"geo" => cells("h", 81), "agg" => cells("a", 40)})

    # the server still holds exactly the previous set, still delivering
    for cell <- cells("g", 80), do: assert([{_, _}] = subscribers(cell))
    for cell <- cells("h", 81), do: assert(subscribers(cell) == [])

    Geo.driver_update(%{id: 902, name: "D902", photo: nil}, "g1", nil)
    assert_push "driver_update", %{id: 902}
  end

  test "an honest 80-for-80 tier swap is one ordinary sync", %{world: world} do
    assert {:ok, _} = sync(world, %{"geo" => cells("g", 80)})
    assert {:ok, %{geo: [], agg: new}} = sync(world, %{"agg" => cells("a", 80)})
    assert length(new) == 80
    for cell <- cells("g", 80), do: assert(subscribers(cell) == [])
  end

  test "self-healing: after a refused sync, the NEXT sync restores everything",
       %{world: world} do
    # drain the sync lane
    for _ <- 1..21, do: sync(world, %{})
    assert {:error, %{reason: "rate_limited"}} = sync(world, %{"geo" => ["home"]})
    assert subscribers("home") == []

    # once allowed again, a full-set sync (identical wish) lands and the cell
    # is watched — no client-side bookkeeping can have drifted, because the
    # client never tracks what the server holds
    :ets.delete(:rate_budgets, {:sync, world.assigns.user_id})

    assert {:ok, %{geo: [%{cell: "home"}]}} = sync(world, %{"geo" => ["home"]})
    assert [{_, _}] = subscribers("home")
  end

  test "rate_limited carries an accurate retry_ms", %{world: world} do
    for _ <- 1..21, do: sync(world, %{})
    assert {:error, %{reason: "rate_limited", retry_ms: wait}} = sync(world, %{})
    # 60/min refills one sync per second
    assert wait > 0 and wait <= 1_000
  end

  test "malformed input is dropped, never a crash", %{world: world} do
    assert {:ok, %{geo: [%{cell: "ok"}]}} =
             sync(world, %{"geo" => ["ok", 7, nil, String.duplicate("x", 500)]})

    assert {:ok, %{geo: []}} = sync(world, %{"geo" => "garbage"})
    assert {:ok, _} = sync(world, %{"agg" => %{"nested" => 1}})
  end

  test "the sync lane: a burst passes, a spin loop walls out", %{world: world} do
    results = for _ <- 1..30, do: sync(world, %{})
    allowed = Enum.count(results, &match?({:ok, _}, &1))
    denied = Enum.count(results, &match?({:error, %{reason: "rate_limited"}}, &1))

    assert allowed in 20..22
    assert denied == 30 - allowed
  end

  test "a client ignoring refusals keeps being refused — never hung up, never reset",
       %{world: world} do
    for _ <- 1..30, do: sync(world, %{})
    results = for _ <- 1..80, do: sync(world, %{})
    assert Enum.all?(results, &match?({:error, %{reason: "rate_limited"}}, &1))
    assert Process.alive?(world.channel_pid)
  end
end
