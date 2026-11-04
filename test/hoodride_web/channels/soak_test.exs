defmodule HoodrideWeb.SoakTest do
  @moduledoc """
  The slow-leak check: minutes of nonstop churn, sampling what can only
  grow if something leaks — processes, PubSub subscriptions, registry
  entries, live tables, memory. Short tests can't see a leak of a few
  entries per switch; a long run multiplies it into a trend.

  Excluded from the normal suite (it runs for minutes):

      mix test --only soak                      # 10 minutes
      $env:SOAK_SECONDS="120"; mix test --only soak
  """
  use ExUnit.Case

  alias Hoodride.{Geo, Rides, TestClient}
  import TestClient, only: [frames: 1, request: 4]

  @moduletag :soak
  @moduletag timeout: :infinity

  @cells ["sk1", "sk2", "sk3"]
  @agg "skA"

  setup do
    # no ownership time limit: the default revokes the DB connection after a
    # couple of minutes, and every ride start (it looks both users up) then
    # failed quietly — the first 10-minute run lost its rides that way
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo, ownership_timeout: :infinity)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  defp prof(u), do: %{id: u.id, name: u.name, photo: nil}

  defp wish do
    %{"geo" => Enum.filter(@cells, fn _ -> :rand.uniform(3) > 1 end), "agg" => [@agg]}
  end

  defp reset_budgets(c) do
    :ets.delete_all_objects(Hoodride.RateLimit)

    for budget <- [:sync, :events], do: :ets.delete(:rate_budgets, {budget, c.user.id})
  end

  defp churn(users, clients) do
    u = Enum.random(users)
    c = Enum.random(clients)
    cell = Enum.random(@cells)

    case :rand.uniform(11) do
      1 ->
        Geo.driver_update(prof(u), cell, nil, [@agg])

      2 ->
        Geo.driver_offline(u.id)

      3 ->
        Geo.hand_up(u.id, cell, "s", [@agg])

      4 ->
        Geo.hand_down(u.id)

      5 ->
        # counted, so the run can prove rides kept happening to the end
        with [a, b] <- Enum.take_random(users, 2),
             {:ok, _} <- Rides.start_ride(a.id, b.id),
             do: Process.put(:rides_started, Process.get(:rides_started, 0) + 1)

      6 ->
        with id when is_binary(id) <- Rides.ride_id_of_user(u.id), do: Rides.end_ride(id, u.id)

      7 ->
        request(c, "world", "sync", wish())

      8 ->
        request(c, "user:#{c.user.id}", "send_msg", %{"to" => u.id, "text" => "hi"})

      9 ->
        Geo.driver_update(
          %{id: 970 + :rand.uniform(9), name: "S", photo: nil},
          cell,
          nil,
          [@agg]
        )

      10 ->
        Geo.hand_up(980 + :rand.uniform(9), cell, "s", [@agg])

      11 ->
        Geo.driver_offline(970 + :rand.uniform(9))
    end
  end

  @tables ~w(geo_drivers geo_hands geo_by_cell geo_members geo_parents geo_agg rides_by_user
             chat_conversations chat_by_user chat_messages ride_requests requests_by_driver)a

  defp sample do
    %{
      processes: :erlang.system_info(:process_count),
      pubsub: Registry.count(Hoodride.PubSub),
      world_channels: Registry.count(Hoodride.WorldChannels),
      user_channels: Registry.count(Hoodride.UserChannels),
      rides: length(DynamicSupervisor.which_children(Hoodride.Rides.Supervisor)),
      rides_started: Process.get(:rides_started, 0),
      rows: Enum.sum(for t <- @tables, do: :ets.info(t, :size)),
      memory_mb: Float.round(:erlang.memory(:total) / 1_048_576, 1),
      # the TEST's own footprint, kept apart from the app's: a growing
      # mailbox here would be the harness, not the server
      test_mailbox: elem(Process.info(self(), :message_queue_len), 1),
      test_mem_kb: div(elem(Process.info(self(), :memory), 1), 1024)
    }
  end

  defp drain_mailbox do
    receive do
      {_name, :got, _msg} -> drain_mailbox()
    after
      0 -> :ok
    end
  end

  test "minutes of churn: nothing grows that shouldn't" do
    seconds = String.to_integer(System.get_env("SOAK_SECONDS") || "600")
    seed = :erlang.phash2(make_ref())
    :rand.seed(:exsss, {seed, 1, 2})

    users = for i <- 1..6, do: user("sk-#{i}")
    clients = for {u, i} <- Enum.with_index(users), do: TestClient.start(:"sk#{i}", u)
    for c <- clients, do: {:ok, _} = request(c, "world", "sync", wish())

    deadline = System.monotonic_time(:second) + seconds
    sample_every = max(div(seconds, 20), 5)

    samples =
      Stream.unfold(System.monotonic_time(:second), fn next_sample ->
        if System.monotonic_time(:second) >= deadline do
          nil
        else
          # a burst of churn, then settle: drain every app, resync those told
          # their role changed (as the app does), and check the leak law
          for _ <- 1..200 do
            Enum.each(clients, &reset_budgets/1)
            churn(users, clients)
          end

          for c <- clients do
            if Enum.any?(frames(c), &match?({"role", _}, &1)) do
              reset_budgets(c)
              {:ok, _} = request(c, "world", "sync", wish())
            end

            TestClient.assert_subscriptions_match(c)
          end

          # the apps relay EVERYTHING they receive to this process; frames/1
          # only collects map ("world") frames, so chat pushes and ride
          # notices would pile up here and slow every later receive (a test
          # artifact the first 10-minute runs measured as falling throughput
          # and stepping memory). Drop the rest each burst.
          drain_mailbox()

          now = System.monotonic_time(:second)

          if now >= next_sample,
            do: {[sample()], now + sample_every},
            else: {[], next_sample}
        end
      end)
      |> Enum.concat()

    IO.puts("\nsoak #{seconds}s, seed #{seed}:")
    for s <- samples, do: IO.puts("  " <> inspect(s))

    # the CHANNEL side is fixed by construction: six apps, six map channels,
    # six user channels — any drift there is a leak, at any moment
    for s <- samples do
      assert s.world_channels == 6 and s.user_channels == 6,
             "channel count drifted: #{inspect(s)}"
    end

    # everything else may move with the random world, but must not TREND:
    # the last third of the run is no bigger than the first third (+ slack
    # for the random state of the moment)
    third = max(div(length(samples), 3), 1)
    {early, late} = {Enum.take(samples, third), Enum.take(samples, -third)}
    peak = fn xs, k -> xs |> Enum.map(&Map.fetch!(&1, k)) |> Enum.max() end

    for {k, slack} <- [processes: 20, pubsub: 20, rides: 3, rows: 200] do
      assert peak.(late, k) <= peak.(early, k) + slack,
             "#{k} grew: early peak #{peak.(early, k)}, late peak #{peak.(late, k)}"
    end

    assert peak.(late, :memory_mb) <= peak.(early, :memory_mb) * 1.25,
           "memory grew: early #{peak.(early, :memory_mb)} MB, late #{peak.(late, :memory_mb)} MB"

    # COVERAGE to the very end: rides kept starting in the last third (a run
    # that silently stopped exercising something is not a clean soak)
    started_late = List.last(samples).rides_started - hd(late).rides_started
    assert started_late > 0, "no ride started in the last third of the run: #{inspect(late)}"
  end
end
