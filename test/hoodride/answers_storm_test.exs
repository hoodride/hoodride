defmodule Hoodride.AnswersStormTest do
  @moduledoc """
  "Answers are true" under parallel load (2026-10-29). The other storms
  check the world ends LEGAL; a lost cancel leaves a perfectly legal request
  behind, so they couldn't see the take-and-put-back bug (RequestsPutBackTest).
  This checks every ANSWER against the world right after it.

  Exact checks without false alarms: each rider is driven by ONE worker —
  the only process that ever creates or cancels that rider's requests —
  while driver workers accept, decline (other drivers' requests too), and
  go online/offline at the same time. So, right after:

    * cancel said :ok or "none"  → the rider has no request;
    * create said :ok            → the request is to THAT driver, or already
                                   gone (accepted/declined) — never another;
    * accept said {:ok, ride}    → rider and driver are both in that ride.

  Workers start truly in parallel (busy-wait to one shared moment — plain
  spawns hid both races found today). After each round: one repair sweep,
  then every world rule (TestHelpers.assert_world_invariants).
  """
  use ExUnit.Case

  alias Hoodride.{Requests, Rides, Geo}

  @moduletag timeout: 300_000
  @rounds 150
  @ops 12

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    make = fn key ->
      {:ok, u} =
        Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

      Geo.user_connected(u.id)
      u
    end

    %{riders: Enum.map(1..3, &make.("as-r#{&1}")), drivers: Enum.map(1..3, &make.("as-d#{&1}"))}
  end

  defp m(u), do: %{id: u.id, name: u.name, photo: nil}
  defp online(d), do: Geo.driver_update(m(d), "cell8", nil, ["c7-0", "c5-shared"])

  defp wait_until(t), do: if(System.monotonic_time(:microsecond) < t, do: wait_until(t))

  # a rider's worker: only it creates/cancels for this rider → exact checks
  defp rider_worker(r, drivers) do
    for _ <- 1..@ops, reduce: [] do
      bad ->
        if :rand.uniform(2) == 1 do
          d = Enum.random(drivers)
          res = Requests.create(m(r), d.id)
          open = Requests.open_request_of(r.id)

          if res == :ok and open != nil and open.driver_id != d.id,
            do: [{:create_ok_but_other_driver, r.id, d.id, open} | bad],
            else: bad
        else
          res = Requests.cancel(r.id)
          open = Requests.open_request_of(r.id)

          if res in [:ok, {:error, :none}] and open != nil,
            do: [{:cancel_said_gone_but_still_there, r.id, res, open} | bad],
            else: bad
        end
    end
  end

  # a driver's worker: answers requests (anyone's, as a modified app could),
  # goes online and offline
  defp driver_worker(d, riders) do
    for _ <- 1..@ops, reduce: [] do
      bad ->
        r = Enum.random(riders)

        case :rand.uniform(4) do
          1 ->
            case Requests.accept(m(d), r.id) do
              {:ok, ride_id} ->
                if Rides.ride_id_of_user(r.id) == ride_id and
                     Rides.ride_id_of_user(d.id) == ride_id,
                   do: bad,
                   else: [{:accept_ok_but_not_in_ride, d.id, r.id, ride_id} | bad]

              _ ->
                bad
            end

          2 ->
            Requests.decline(d.id, r.id)
            bad

          3 ->
            Geo.driver_offline(d.id)
            bad

          4 ->
            online(d)
            bad
        end
    end
  rescue
    _ -> []
  catch
    :exit, _ -> []
  end

  defp end_all_rides(users) do
    for u <- users,
        ride_id = Rides.ride_id_of_user(u.id),
        is_binary(ride_id) or is_reference(ride_id) or is_integer(ride_id) do
      try do
        Rides.end_ride(ride_id, u.id)
      catch
        :exit, _ -> :ok
      end
    end
  end

  test "every answer is true right after it, under a truly parallel storm", %{
    riders: riders,
    drivers: drivers
  } do
    everyone = riders ++ drivers

    bad =
      for round <- 1..@rounds, reduce: [] do
        bad ->
          end_all_rides(everyone)
          for r <- riders, do: Requests.cancel(r.id)
          for d <- drivers, do: online(d)

          parent = self()
          start = System.monotonic_time(:microsecond) + 3_000

          workers =
            Enum.map(riders, &{:rider, &1}) ++ Enum.map(drivers, &{:driver, &1})

          for {kind, u} <- workers do
            spawn(fn ->
              wait_until(start)

              found =
                case kind do
                  :rider -> rider_worker(u, drivers)
                  :driver -> driver_worker(u, riders)
                end

              send(parent, {:done, found})
            end)
          end

          found =
            for _ <- workers, reduce: [] do
              acc ->
                receive do
                  {:done, f} -> f ++ acc
                after
                  20_000 -> flunk("a worker never finished in round #{round}")
                end
            end

          # the world after the storm: one repair sweep, then every rule
          Hoodride.Sweeper.sweep_now()
          Hoodride.TestHelpers.assert_world_invariants(everyone, :all)

          Enum.map(found, &{round, &1}) ++ bad
      end

    end_all_rides(everyone)
    assert bad == [], "#{length(bad)} false answers, e.g. #{inspect(Enum.take(bad, 4))}"
  end
end
