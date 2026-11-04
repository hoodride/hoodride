defmodule HoodrideWeb.RolePrivacyFuzzTest do
  @moduledoc """
  The privacy laws under random traffic. Real apps (one process each, via
  TestClient) watch the same hexes while their users go online and offline,
  raise and lower hands, start and end rides, and resync as the app does on
  a `role` push — and strangers' cars and hands come and go around them.
  Some of it happens in a hex nobody watches (`@unwatched`), so a role change
  can't be "noticed" by accident through the user's own car's broadcast.

  After EVERY step, for every app:

    1. no map frame of a layer its role forbids. A step can change a role
       once, so a frame is allowed if the role before OR after the step
       allows its layer; in a ride before AND after → no map frame at all.
    2. every count update carries exactly ONE side (its layer's).
    3. a count update always CHANGES the number (an unchanged one would be
       the timing leak: it tells you the OTHER role's people moved).
    4. every role change is announced in that same step (`role` push).
    5. at rest, the map channel holds only topics its live role allows.
    6. every resync's snapshots carry only the live role's layer.
    7. what PubSub delivers to it is exactly what it holds (no stale
       subscription left behind).
    8. a marker (live or in a snapshot) is {id, cell, spot} — a departure
       just {id}: never a position, a name or a photo. Cars travel like
       hands; who someone is comes only from `reveal`.

  Seeded, so a failure replays exactly: the seed is in the failure message.
  (Two things it can't see by design, each covered by its own test in
  role_privacy_test: a broadcast racing a role ping inside one mailbox —
  the steps here are sequential — and two map channels of one account.)
  """
  use ExUnit.Case

  alias Hoodride.{Geo, Rides, Roles, TestClient}
  import TestClient, only: [frames: 1, request: 4]

  @cells ["fz1", "fz2"]
  @unwatched "fzX"
  @agg "fzA"
  @steps 300

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  defp wish, do: %{"geo" => @cells, "agg" => [@agg]}

  defp role_name(:viewer), do: "viewer"
  defp role_name(:driver), do: "driver"
  defp role_name(:in_ride), do: "in_ride"

  defp layer_of_frame("driver_update", _), do: :drivers
  defp layer_of_frame("driver_left", _), do: :drivers
  defp layer_of_frame("hand_update", _), do: :hands
  defp layer_of_frame("hand_left", _), do: :hands

  defp layer_of_frame("agg_update", p) do
    case {Map.has_key?(p, :drivers), Map.has_key?(p, :hands)} do
      {true, false} ->
        :drivers

      {false, true} ->
        :hands

      other ->
        flunk("an agg_update must carry exactly one side, got #{inspect(other)}: #{inspect(p)}")
    end
  end

  defp layer_of_frame(_event, _p), do: nil

  # ---- the random actions ----

  # half the cars and hands land in the hex nobody watches: a role change
  # there can only be noticed through its role ping
  defp somewhere, do: if(:rand.uniform(2) == 1, do: @unwatched, else: pick(@cells))

  defp step(:drive, w) do
    u = pick(w.users)
    Geo.driver_update(prof(u), somewhere(), nil, [@agg])
    w
  end

  defp step(:offline, w) do
    Geo.driver_offline(pick(w.users).id)
    w
  end

  defp step(:hand, w) do
    Geo.hand_up(pick(w.users).id, somewhere(), "s", [@agg])
    w
  end

  defp step(:lower, w) do
    Geo.hand_down(pick(w.users).id)
    w
  end

  defp step(:ride, w) do
    case Enum.filter(w.users, &(Rides.ride_id_of_user(&1.id) == nil)) |> Enum.shuffle() do
      [a, b | _] ->
        {:ok, ride} = Rides.start_ride(a.id, b.id)
        %{w | rides: [{ride, a.id} | w.rides]}

      _ ->
        w
    end
  end

  defp step(:end_ride, %{rides: []} = w), do: w

  defp step(:end_ride, w) do
    {ride, by} = pick(w.rides)
    Rides.end_ride(ride, by)
    %{w | rides: List.delete(w.rides, {ride, by})}
  end

  # a ride process killed outright (no terminate): its seats stay until the
  # sweeper reclaims them, which it does here in the same step
  defp step(:kill_ride, %{rides: []} = w), do: w

  defp step(:kill_ride, w) do
    {ride, by} = pick(w.rides)

    case Registry.lookup(Hoodride.Rides.Registry, ride) do
      [{pid, _}] ->
        ref = Process.monitor(pid)
        Process.exit(pid, :kill)
        assert_receive {:DOWN, ^ref, :process, ^pid, _}

      [] ->
        :ok
    end

    Hoodride.Sweeper.heal_orphan_ride_slots()
    %{w | rides: List.delete(w.rides, {ride, by})}
  end

  # a ride that fails to start (its partner doesn't exist): the claimed seat
  # is freed again on the error path
  defp step(:bad_ride, w) do
    case Enum.filter(w.users, &(Rides.ride_id_of_user(&1.id) == nil)) do
      [] ->
        w

      free ->
        ExUnit.CaptureLog.capture_log(fn ->
          {:error, _} = Rides.start_ride(pick(free).id, 9_999_999_999)
        end)

        w
    end
  end

  # strangers (no app of their own) making traffic around the apps
  defp step(:stranger_car, w) do
    Geo.driver_update(
      %{id: 900 + :rand.uniform(4), name: "S", photo: nil},
      somewhere(),
      nil,
      [@agg]
    )

    w
  end

  defp step(:stranger_gone, w) do
    Geo.driver_offline(900 + :rand.uniform(4))
    w
  end

  defp step(:stranger_hand, w) do
    Geo.hand_up(910 + :rand.uniform(4), somewhere(), "s", [@agg])
    w
  end

  defp step(:stranger_lower, w) do
    Geo.hand_down(910 + :rand.uniform(4))
    w
  end

  defp step(:resync, w) do
    c = pick(w.clients)
    %{w | counts: Map.put(w.counts, c.name, resync(c))}
  end

  @actions ~w(drive offline hand lower ride end_ride kill_ride bad_ride stranger_car stranger_gone stranger_hand stranger_lower resync)a

  defp pick(list), do: Enum.at(list, :rand.uniform(length(list)) - 1)
  defp prof(u), do: %{id: u.id, name: u.name, photo: nil}

  # The app's answer to a role push: the same wish again. Its snapshots must
  # carry only the live role's layer (law 6). Returns the counts it now
  # knows, %{{layer, cell} => n}, the baseline for law 3.
  defp resync(client) do
    # 160 steps run in about a second, far faster than the sync lane allows
    # (a real app honours retry_ms and waits). This test is about privacy,
    # not rate limits (world_channel_test covers those), so the user's sync budget is reset.
    :ets.delete(:rate_budgets, {:sync, client.user.id})

    {:ok, reply} = request(client, "world", "sync", wish())
    role = Roles.of(client.user.id)

    for s <- reply.geo ++ reply.agg do
      keys = s |> Map.keys() |> Enum.reject(&(&1 == :cell))

      assert keys == List.wrap(Roles.layer(role)),
             "#{client.name} (#{role}) got a snapshot with #{inspect(keys)}: #{inspect(s)}"
    end

    for s <- reply.geo, {_layer, markers} <- Map.delete(s, :cell), m <- markers do
      assert_marker_shape("snapshot", m, "#{client.name}'s resync")
    end

    for a <- reply.agg, {layer, n} <- Map.delete(a, :cell), into: %{}, do: {{layer, a.cell}, n}
  end

  # law 8
  defp assert_marker_shape(event, payload, where) do
    expected =
      case event do
        e when e in ~w(driver_left hand_left) -> [:id]
        e when e in ~w(driver_update hand_update snapshot) -> [:cell, :id, :spot]
        _ -> nil
      end

    if expected do
      assert payload |> Map.keys() |> Enum.sort() == expected,
             "#{where} got #{event} carrying #{inspect(payload)}"
    end
  end

  test "the privacy laws hold after every random step" do
    seed = :erlang.phash2(make_ref())
    :rand.seed(:exsss, {seed, 7, 11})

    users = for i <- 1..5, do: user("fz-#{i}")
    clients = for {u, i} <- Enum.with_index(users), do: TestClient.start(:"app#{i}", u)
    counts = Map.new(clients, &{&1.name, resync(&1)})

    world = %{users: users, clients: clients, rides: [], counts: counts}

    Enum.reduce(1..@steps, world, fn n, w ->
      before = Map.new(clients, &{&1.name, Roles.of(&1.user.id)})
      action = pick(@actions)
      w = step(action, w)
      after_ = Map.new(clients, &{&1.name, Roles.of(&1.user.id)})

      Enum.reduce(clients, w, fn c, w ->
        got = frames(c)
        {r0, r1} = {before[c.name], after_[c.name]}
        where = "seed #{seed}, step #{n} (#{action}): #{c.name} (#{r0} → #{r1})"
        allowed = MapSet.new([Roles.layer(r0), Roles.layer(r1)]) |> MapSet.delete(nil)

        # laws 1, 2, 3
        known =
          Enum.reduce(got, w.counts[c.name], fn {event, payload}, known ->
            case layer_of_frame(event, payload) do
              nil ->
                known

              layer ->
                assert layer in allowed, "#{where} got #{event} #{inspect(payload)}"
                assert_marker_shape(event, payload, where)

                if event == "agg_update" do
                  key = {layer, payload.cell}
                  n = Map.fetch!(payload, layer)

                  assert Map.get(known, key) != n,
                         "#{where} got an UNCHANGED count #{inspect(payload)}"

                  Map.put(known, key, n)
                else
                  known
                end
            end
          end)

        # law 4: a role change is always announced
        if r0 != r1 do
          assert {"role", %{role: role_name(r1)}} in got,
                 "#{where}: the role changed but no role push came (#{inspect(got)})"
        end

        # law 7: what PubSub delivers to it is exactly what it holds (a stale
        # subscription would be dropped by the live check — invisible to
        # every other law, but a leak of work and memory)
        TestClient.assert_subscriptions_match(c)

        # law 5: at rest, only topics its live role allows
        held = :sys.get_state(TestClient.channel_pid(c)).assigns.held

        for topic <- held do
          ok =
            case Roles.layer(r1) do
              :drivers -> String.starts_with?(topic, ["geo:d:", "agg:d:"])
              :hands -> String.starts_with?(topic, ["geo:h:", "agg:h:"])
              nil -> false
            end

          assert ok, "#{where} still holds #{topic}"
        end

        # the app resyncs whenever it was told its role changed (law 6 runs there)
        known = if Enum.any?(got, &match?({"role", _}, &1)), do: resync(c), else: known
        %{w | counts: Map.put(w.counts, c.name, known)}
      end)
    end)
  end
end
