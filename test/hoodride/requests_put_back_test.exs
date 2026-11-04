defmodule Hoodride.RequestsPutBackTest do
  @moduledoc """
  "Take, then put back" (found in the race audit, 2026-10-29): a driver
  answering a request that ISN'T theirs used to take it out of the table,
  see it was someone else's, and put it back. In that gap the request was
  missing, so the rider's own action at that instant went wrong:

    * a cancel found nothing ("no request"), and the put-back then brought
      the cancelled request back — it lingered on the driver's screen;
    * a new request succeeded into the empty slot, and the put-back
      overwrote it with the old one.

  Truly parallel (each process busy-waits for one shared moment, which
  spreads them over every core — plain spawns run one after another and
  hide races; Hoodride.SignInFailuresTest). A normal app never sends another
  driver's request id; a modified one can.
  """
  use ExUnit.Case

  alias Hoodride.Requests

  @moduletag timeout: 120_000
  @rounds 300

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    [rider, d1, d2, w] =
      for key <- ["pb-rider", "pb-d1", "pb-d2", "pb-wrong"] do
        {:ok, u} =
          Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

        u
      end

    for u <- [rider, d1, d2, w], do: Hoodride.Geo.user_connected(u.id)
    for d <- [d1, d2], do: Hoodride.Geo.driver_update(m(d), "cell8", nil, ["c7-0", "c5-shared"])
    %{rider: rider, d1: d1, d2: d2, w: w}
  end

  defp m(u), do: %{id: u.id, name: u.name, photo: nil}

  # every fun starts at the same moment, each in its own process
  defp at_once(funs) do
    parent = self()
    start = System.monotonic_time(:microsecond) + 3_000

    for {tag, fun} <- funs do
      spawn(fn ->
        wait_until(start)
        send(parent, {tag, fun.()})
      end)
    end

    for {tag, _} <- funs, into: %{} do
      receive do
        {^tag, result} -> {tag, result}
      after
        5_000 -> flunk("#{inspect(tag)} never finished")
      end
    end
  end

  defp wait_until(t), do: if(System.monotonic_time(:microsecond) < t, do: wait_until(t))

  # several "wrong driver" answers at once widen the gap, as a modified app
  # could send them
  defp wrong_answers(w, rider) do
    for i <- 1..6 do
      {{:wrong, i},
       if(rem(i, 2) == 0,
         do: fn -> Requests.decline(w.id, rider.id) end,
         else: fn -> Requests.accept(m(w), rider.id) end
       )}
    end
  end

  defp reset(rider), do: Requests.cancel(rider.id)

  test "a cancel at that instant always works, and the request is gone", %{
    rider: rider,
    d1: d1,
    w: w
  } do
    bad =
      for round <- 1..@rounds, reduce: [] do
        bad ->
          reset(rider)
          :ok = Requests.create(m(rider), d1.id)
          r = at_once([{:cancel, fn -> Requests.cancel(rider.id) end} | wrong_answers(w, rider)])

          if r[:cancel] == :ok and Requests.open_request_of(rider.id) == nil,
            do: bad,
            else: [{round, r[:cancel], Requests.open_request_of(rider.id)} | bad]
      end

    assert bad == [], "#{length(bad)} of #{@rounds} rounds: e.g. #{inspect(Enum.take(bad, 3))}"
  end

  test "a new request at that instant is never overwritten by the old one", %{
    rider: rider,
    d1: d1,
    d2: d2,
    w: w
  } do
    bad =
      for round <- 1..@rounds, reduce: [] do
        bad ->
          reset(rider)
          :ok = Requests.create(m(rider), d1.id)

          r =
            at_once([
              {:renew,
               fn ->
                 Requests.cancel(rider.id)
                 Requests.create(m(rider), d2.id)
               end}
              | wrong_answers(w, rider)
            ])

          open = Requests.open_request_of(rider.id)

          if r[:renew] == :ok and (open == nil or open.driver_id != d2.id),
            do: [{round, open} | bad],
            else: bad
      end

    assert bad == [], "#{length(bad)} of #{@rounds} rounds: e.g. #{inspect(Enum.take(bad, 3))}"
  end

  # the RIGHT driver declining while the rider re-asks someone else: the
  # driver read their own request, but by the time they remove it, it may be
  # the rider's NEW one — only the exact row read may go (compare-and-swap).
  # Honest limit: that exact interleaving needs the rider's whole cancel +
  # re-request (tens of µs) inside the driver's ~1 µs read-to-delete gap, so
  # timing alone can't force it — a mutant removing the compare-and-swap
  # survives this test. It guards the outcome, not that step.
  test "the right driver's decline never removes the rider's new request", %{
    rider: rider,
    d1: d1,
    d2: d2
  } do
    bad =
      for round <- 1..@rounds, reduce: [] do
        bad ->
          reset(rider)
          :ok = Requests.create(m(rider), d1.id)

          r =
            at_once(
              [
                {:renew,
                 fn ->
                   Requests.cancel(rider.id)
                   Requests.create(m(rider), d2.id)
                 end}
              ] ++ for(i <- 1..6, do: {{:d1, i}, fn -> Requests.decline(d1.id, rider.id) end})
            )

          open = Requests.open_request_of(rider.id)

          if r[:renew] == :ok and (open == nil or open.driver_id != d2.id),
            do: [{round, open} | bad],
            else: bad
      end

    assert bad == [], "#{length(bad)} of #{@rounds} rounds: e.g. #{inspect(Enum.take(bad, 3))}"
  end

  # a request at the instant its driver goes offline: going offline declines
  # every waiting request, then takes the car off the map — a request made
  # between the two passed "is the driver online?" and waited on an offline
  # driver until the 60 s repair job (2–4 in 300 rounds before the fix).
  # Checked with NO repair run. Of the fix's two halves, removing the second
  # decline (Geo.offline_core) fails this; removing create's re-check does
  # not — the interleaving it covers (a save after the second sweep, by a
  # creator who checked before the car left) is too narrow for timing to
  # force. It stays as the complete fix; this test proves the other half.
  test "a request at the instant its driver goes offline never waits on an offline driver",
       %{rider: rider, d1: d1} do
    bad =
      for round <- 1..1000, reduce: [] do
        bad ->
          reset(rider)
          Hoodride.Geo.driver_update(m(d1), "cell8", nil, ["c7-0", "c5-shared"])

          r =
            at_once([
              {:create, fn -> Requests.create(m(rider), d1.id) end},
              {:offline, fn -> Hoodride.Geo.driver_offline(d1.id) end}
            ])

          open = Requests.open_request_of(rider.id)

          if open != nil and not Hoodride.Geo.driver_on_map?(open.driver_id),
            do: [{round, r[:create]} | bad],
            else: bad
      end

    assert bad == [], "#{length(bad)} of 1000 rounds: e.g. #{inspect(Enum.take(bad, 3))}"
  end

  test "the right driver still declines and accepts (no regression)", %{
    rider: rider,
    d1: d1,
    w: w
  } do
    :ok = Requests.create(m(rider), d1.id)
    assert Requests.decline(w.id, rider.id) == {:error, :not_yours}
    assert Requests.accept(m(w), rider.id) == {:error, :not_yours}
    assert Requests.open_request_of(rider.id).driver_id == d1.id, "untouched by the wrong driver"
    assert Requests.decline(d1.id, rider.id) == :ok
    assert Requests.open_request_of(rider.id) == nil
  end
end
