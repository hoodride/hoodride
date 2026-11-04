defmodule Hoodride.InvariantFuzzTest do
  @moduledoc """
  Property-based adversarial fuzzing: the machine generates random sequences
  of marketplace operations and asserts the core invariants survive EVERY
  prefix of EVERY sequence. Catches orderings no human thinks to write.
  """
  use ExUnit.Case
  use ExUnitProperties

  alias Hoodride.{Requests, Rides}

  @moduletag timeout: 120_000

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    users =
      for key <- ["fz-1", "fz-2", "fz-3", "fz-4"] do
        {:ok, u} =
          Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

        u
      end

    %{users: users}
  end

  defp op_gen do
    idx = StreamData.integer(0..3)

    StreamData.one_of([
      StreamData.tuple({StreamData.constant(:create), idx, idx}),
      StreamData.tuple({StreamData.constant(:cancel), idx}),
      StreamData.tuple({StreamData.constant(:accept), idx, idx}),
      StreamData.tuple({StreamData.constant(:decline), idx, idx}),
      StreamData.tuple({StreamData.constant(:expire), StreamData.constant(nil)}),
      StreamData.tuple({StreamData.constant(:end_ride), idx}),
      StreamData.tuple({StreamData.constant(:offline), idx}),
      StreamData.tuple({StreamData.constant(:online), idx}),
      StreamData.tuple({StreamData.constant(:hand_up), idx}),
      StreamData.tuple({StreamData.constant(:hand_down), idx})
    ])
  end

  defp apply_op(op, users) do
    u = fn i -> Enum.at(users, i) end
    m = fn i -> %{id: u.(i).id, name: u.(i).name, photo: nil} end

    case op do
      {:create, r, d} ->
        Requests.create(m.(r), u.(d).id)

      {:cancel, r} ->
        Requests.cancel(u.(r).id)

      {:accept, d, r} ->
        Requests.accept(m.(d), u.(r).id)

      {:decline, d, r} ->
        Requests.decline(u.(d).id, u.(r).id)

      {:expire, _} ->
        Requests.expire_older_than(0)

      {:end_ride, i} ->
        case Rides.ride_id_of_user(u.(i).id) do
          nil -> :ok
          :pending -> :ok
          ride_id -> Rides.end_ride(ride_id, u.(i).id)
        end

      {:offline, i} ->
        Hoodride.Geo.driver_offline(u.(i).id)

      {:online, i} ->
        # a mid-ride user can't come back on the map (the client never offers it)
        if Rides.ride_id_of_user(u.(i).id) == nil, do: put_on_map(u.(i))

      {:hand_up, i} ->
        # mirrors the channel guard: no hands mid-ride
        if Rides.ride_id_of_user(u.(i).id) == nil,
          do: Hoodride.Geo.hand_up(u.(i).id, "cell8", "spot9", parents_for(u.(i)))

      {:hand_down, i} ->
        Hoodride.Geo.hand_down(u.(i).id)
    end
  end

  defp put_on_map(user) do
    Hoodride.Geo.driver_update(
      %{id: user.id, name: user.name, photo: nil},
      "cell8",
      nil,
      parents_for(user)
    )
  end

  # real coarse-cell parents so the aggregate tier is live under fuzz —
  # split across two res-7 cells (by id parity) plus one shared res-5 cell
  defp parents_for(user), do: ["c7-#{rem(user.id, 2)}", "c5-shared"]

  # the eight invariants live in Hoodride.TestHelpers.assert_world_invariants/1,
  # shared with the concurrency storm test — one source of world-law

  property "no random operation sequence can violate the marketplace invariants",
           %{users: users} do
    check all(ops <- StreamData.list_of(op_gen(), max_length: 40), max_runs: 150) do
      Hoodride.TestHelpers.scrub_live_state()
      # everyone starts on the map (requests need an on-map target);
      # the :offline/:online ops churn availability from there
      for u <- users, do: put_on_map(u)

      for op <- ops do
        apply_op(op, users)
        Hoodride.TestHelpers.assert_world_invariants(users)
      end
    end
  end
end
