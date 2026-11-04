defmodule HoodrideWeb.RolePrivacyStormTest do
  @moduledoc """
  The privacy laws under CONCURRENT load: many processes changing roles and
  moving cars and hands at the same time, so broadcasts and role pings race
  each other inside the map channels' mailboxes for real.

  A step-by-step check can't be strict here (with everything at once there
  is no "before/after the step"), so the apps are split by role:

    - sentinels whose role NEVER changes during the storm — a viewer, an
      online driver, two riders in a ride. Strict laws: the viewer never
      receives a hand, the driver never a rival's car, the riders nothing
      from the map at all. They sit in the busiest hexes the whole time.
    - churners: apps whose own roles flip constantly, concurrently with
      everything else. Law at rest: once the storm stops, every map channel
      holds only what its live role allows, and the same wish resynced
      returns only that layer.
  """
  use ExUnit.Case

  alias Hoodride.{Geo, Rides, Roles, TestClient}
  import TestClient, only: [frames: 1, request: 4]

  @cells ["st1", "st2"]
  @agg "stA"
  @ops 1_500

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

  defp prof(u), do: %{id: u.id, name: u.name, photo: nil}
  defp wish, do: %{"geo" => @cells, "agg" => [@agg]}
  defp watch(c), do: {:ok, _} = request(c, "world", "sync", wish())

  defp map_frames(c) do
    for {e, p} <- frames(c),
        e in ~w(driver_update driver_left hand_update hand_left agg_update),
        do: {e, p}
  end

  defp random_op(churners) do
    u = Enum.random(churners)
    cell = Enum.random(@cells)

    case :rand.uniform(8) do
      1 ->
        Geo.driver_update(prof(u), cell, nil, [@agg])

      2 ->
        Geo.driver_offline(u.id)

      3 ->
        Geo.hand_up(u.id, cell, "s", [@agg])

      4 ->
        Geo.hand_down(u.id)

      5 ->
        with [a, b] <- Enum.take_random(churners, 2), do: Rides.start_ride(a.id, b.id)

      6 ->
        with id when is_binary(id) <- Rides.ride_id_of_user(u.id), do: Rides.end_ride(id, u.id)

      # strangers' traffic in the sentinels' hexes
      7 ->
        Geo.driver_update(
          %{id: 950 + :rand.uniform(6), name: "S", photo: nil},
          cell,
          nil,
          [@agg]
        )

      8 ->
        Geo.hand_up(960 + :rand.uniform(6), cell, "s", [@agg])
    end
  end

  test "under concurrent churn: sentinels never see a forbidden layer; everyone settles right" do
    # the sentinels
    viewer = TestClient.start(:viewer, user("st-viewer"))
    driver_u = user("st-driver")
    driver = TestClient.start(:driver, driver_u)
    Geo.driver_update(prof(driver_u), "elsewhere", nil)
    [ra, rb] = [user("st-ra"), user("st-rb")]
    {:ok, _} = Rides.start_ride(ra.id, rb.id)
    rider_a = TestClient.start(:rider_a, ra)
    rider_b = TestClient.start(:rider_b, rb)
    sentinels = [viewer, driver, rider_a, rider_b]
    for s <- sentinels, do: watch(s)
    for s <- sentinels, do: frames(s)

    # the churners
    churn_users = for i <- 1..6, do: user("st-c#{i}")
    churners = for {u, i} <- Enum.with_index(churn_users), do: TestClient.start(:"churn#{i}", u)
    for c <- churners, do: watch(c)

    # THE STORM: 8 processes at once, each doing random ops
    1..@ops
    |> Task.async_stream(fn _ -> random_op(churn_users) end,
      max_concurrency: 8,
      ordered: false,
      timeout: 30_000
    )
    |> Stream.run()

    # ---- sentinels: strict ----
    assert Roles.of(viewer.user.id) == :viewer
    assert Roles.of(driver_u.id) == :driver

    got_v = map_frames(viewer)
    assert got_v != [], "the viewer saw no traffic at all — the storm didn't reach it"

    for {e, p} <- got_v do
      refute e in ~w(hand_update hand_left), "the viewer got #{e}"
      refute Map.has_key?(p, :hands), "the viewer got #{inspect(p)}"

      # a car is its spot: never a position, a name or a photo
      if e == "driver_update",
        do: assert(p |> Map.keys() |> Enum.sort() == [:cell, :id, :spot], inspect(p))
    end

    got_d = map_frames(driver)
    assert got_d != [], "the driver saw no traffic at all — the storm didn't reach it"

    for {e, p} <- got_d do
      refute e in ~w(driver_update driver_left), "the driver got #{e} #{inspect(p)}"
      refute Map.has_key?(p, :drivers), "the driver got #{inspect(p)}"
    end

    for r <- [rider_a, rider_b] do
      assert Roles.of(r.user.id) == :in_ride
      assert map_frames(r) == [], "#{r.name}, in a ride, got map frames"
    end

    # ---- churners: at rest, settled to their live role ----
    for c <- sentinels, do: TestClient.assert_subscriptions_match(c)

    for c <- churners do
      _ = frames(c)
      # what PubSub delivers to it is exactly what it believes it holds
      TestClient.assert_subscriptions_match(c)
      role = Roles.of(c.user.id)
      layer = Roles.layer(role)
      held = :sys.get_state(TestClient.channel_pid(c)).assigns.held

      for topic <- held do
        ok =
          case layer do
            :drivers -> String.starts_with?(topic, ["geo:d:", "agg:d:"])
            :hands -> String.starts_with?(topic, ["geo:h:", "agg:h:"])
            nil -> false
          end

        assert ok, "#{c.name} (#{role}) settled holding #{topic}"
      end

      # the app's resync brings exactly its own layer
      :ets.delete(:rate_budgets, {:sync, c.user.id})

      {:ok, reply} = request(c, "world", "sync", wish())

      for s <- reply.geo ++ reply.agg do
        assert s |> Map.keys() |> Enum.reject(&(&1 == :cell)) == List.wrap(layer),
               "#{c.name} (#{role}) resync returned #{inspect(s)}"
      end
    end
  end
end
