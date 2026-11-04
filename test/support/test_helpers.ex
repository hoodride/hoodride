defmodule Hoodride.TestHelpers do
  @moduledoc "Scrub all live (ETS + process) state between tests — the DB sandbox can't."

  @tables [
    :ride_requests,
    :requests_by_driver,
    :rides_by_user,
    :chat_conversations,
    :chat_messages,
    :chat_by_user,
    :chat_spots,
    :request_spots,
    :geo_drivers,
    :geo_hands,
    :geo_presence,
    :geo_parents,
    :geo_agg,
    :geo_by_cell,
    :geo_members,
    :rate_budgets,
    :sign_in_failures,
    :socket_slots,
    :session_highest
  ]

  @doc """
  The module of a migration file, for tests of its SQL. Loaded once per VM:
  a second `Code.require_file` returns nil (`mix test --repeat-until-failure`
  reruns the suite in the same VM).
  """
  def migration(path) do
    case Code.require_file(path) do
      [{mod, _}] ->
        :persistent_term.put({__MODULE__, path}, mod)
        mod

      nil ->
        :persistent_term.get({__MODULE__, path})
    end
  end

  @doc "A signed-in session for `user_id` (HoodrideWeb.Auth needs the sign-in time)."
  def session_for(user_id),
    do: %{"user_id" => user_id, "signed_in_at" => System.system_time(:millisecond)}

  @doc """
  Put app settings back as they were (`[{key, value}]`, saved before a test
  changed them). Restore, never just delete: a setting the test config
  provides (config.exs budgets are ON in tests) would stay OFF for every
  test after, depending on the random order.
  """
  def restore_env(saved) do
    for {k, v} <- saved do
      if v == nil,
        do: Application.delete_env(:hoodride, k),
        else: Application.put_env(:hoodride, k, v)
    end

    :ok
  end

  def scrub_live_state do
    # kill ride processes leaked by a previous test (their timers and
    # registry entries would otherwise bleed into this one)
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Hoodride.Rides.Supervisor) do
      DynamicSupervisor.terminate_child(Hoodride.Rides.Supervisor, pid)
    end

    for table <- @tables, do: :ets.delete_all_objects(table)
    # Hammer's shared rate counters (table named after the module): user ids
    # repeat across tests, so a leftover counter would leak between them
    :ets.delete_all_objects(Hoodride.RateLimit)
    :ok
  end

  @doc """
  The eight marketplace invariants — the single source of world-law, asserted
  by the sequential fuzzer after every op and by the concurrency storm.
  `scope: :geo` checks only the geo invariants (5–8), which the GeoWriter
  makes atomic — they must hold the moment the storm quiesces, sweep or not.
  Scope :all adds the request/ride invariants (1–4), whose cross-system races
  are healed by the sweep. `users` is the closed set of actors in play.
  """
  def assert_world_invariants(users, scope \\ :all) do
    import ExUnit.Assertions

    alias Hoodride.{Geo, Requests, Rides}

    if scope == :all do
      slots = :ets.tab2list(:rides_by_user)

      # 1. ride seats always come in consistent pairs pointing at a live ride
      for {user_id, ride_id} <- slots, ride_id != :pending do
        case Rides.get(ride_id) do
          {:ok, st} ->
            assert user_id in [st.rider, st.driver],
                   "seat #{user_id} points at ride #{ride_id} that doesn't include them"

            assert Rides.ride_id_of_user(st.rider) == ride_id
            assert Rides.ride_id_of_user(st.driver) == ride_id

          {:error, :gone} ->
            flunk("seat #{user_id} points at dead ride #{ride_id}")
        end
      end

      # 2. nobody is simultaneously riding and openly requesting
      for u <- users do
        in_ride = Rides.ride_id_of_user(u.id) not in [nil, :pending]

        if in_ride do
          assert Requests.open_request_of(u.id) == nil,
                 "user #{u.id} is in a ride AND has an open request"
        end
      end

      # 3. no request targets a rider == driver (self-rides impossible)
      for {rider_id, driver_id, _ts} <- :ets.tab2list(:ride_requests) do
        assert rider_id != driver_id
      end

      # 4. nobody waits on an unavailable driver
      for {rider_id, driver_id, _ts} <- :ets.tab2list(:ride_requests) do
        assert Geo.driver_on_map?(driver_id),
               "request from #{rider_id} targets off-map driver #{driver_id}"

        assert Rides.ride_id_of_user(driver_id) in [nil, :pending],
               "request from #{rider_id} targets mid-ride driver #{driver_id}"
      end

      # 11. every open request is findable from its driver's side (the
      # per-driver index): a missing row would hide it from the driver's
      # reload and from decline-all. Scope :all — its one same-second gap
      # is closed by the sweep.
      for {rider_id, driver_id, _ts} <- :ets.tab2list(:ride_requests) do
        assert :ets.member(:requests_by_driver, {driver_id, rider_id}),
               "request #{rider_id}→#{driver_id} is missing from the driver index"
      end

      # 14. every live ride has its pair's conversation (opened at ride
      # start): the first mid-ride message is never a cold contact, and a
      # silent ride stays reachable after it ends
      for {user_id, ride_id} <- slots,
          ride_id != :pending,
          {:ok, st} <- [Rides.get(ride_id)],
          user_id == st.rider do
        assert Hoodride.Chat.exists?(st.rider, st.driver),
               "ride #{ride_id} has no conversation between its two seats"
      end
    end

    # 5. supply and demand never overlap
    for {uid, _cell, _spot} <- :ets.tab2list(:geo_hands) do
      refute Geo.driver_on_map?(uid),
             "user #{uid} is simultaneously a driver and a raised hand"
    end

    # 6. mid-ride users are invisible: no car, no hand, no hex footprint
    for u <- users, Rides.ride_id_of_user(u.id) not in [nil, :pending] do
      refute Geo.driver_on_map?(u.id), "mid-ride user #{u.id} has a driver row"
      assert :ets.lookup(:geo_hands, u.id) == [], "mid-ride user #{u.id} has a hand up"
      assert :ets.lookup(:geo_parents, u.id) == [], "mid-ride user #{u.id} counts in a hex"
    end

    # 7. the instant aggregate layer always equals the truth
    expected =
      :ets.tab2list(:geo_parents)
      |> Enum.reduce(%{}, fn {_uid, role, cells}, acc ->
        Enum.reduce(cells, acc, fn cell, a ->
          Map.update(a, cell, tally_one(role), fn {d, h} -> tally_add(role, d, h) end)
        end)
      end)

    actual = :ets.tab2list(:geo_agg) |> Map.new(fn {c, d, h} -> {c, {d, h}} end)

    assert actual == expected,
           "aggregate drift: counters say #{inspect(actual)}, truth says #{inspect(expected)}"

    # 8. the tiers agree on who exists
    parents = :ets.tab2list(:geo_parents) |> Map.new(fn {uid, role, _} -> {uid, role} end)

    for {uid, _cell, _spot, _ts} <- :ets.tab2list(:geo_drivers) do
      assert parents[uid] == :driver,
             "driver #{uid} is on the street map but not counted at altitude"
    end

    for {uid, _cell, _spot} <- :ets.tab2list(:geo_hands) do
      assert parents[uid] == :hand,
             "hand #{uid} is on the street map but not counted at altitude"
    end

    for {uid, role} <- parents do
      fine =
        case role do
          :driver -> :ets.member(:geo_drivers, uid)
          :hand -> :ets.member(:geo_hands, uid)
        end

      assert fine, "user #{uid} counts at altitude as #{role} but has no street-map row"
    end

    # 10. the cell index equals the main tables EXACTLY: every driver/hand has
    # one index row with its cell and role, and every index row is backed by
    # a live driver/hand in that cell (no ghosts, no omissions)
    idx_expected =
      MapSet.new(
        for({id, cell, _, _} <- :ets.tab2list(:geo_drivers), do: {{cell, id}, :driver}) ++
          for({id, cell, _} <- :ets.tab2list(:geo_hands), do: {{cell, id}, :hand})
      )

    idx_actual = MapSet.new(:ets.tab2list(:geo_by_cell))

    assert idx_expected == idx_actual,
           "cell index drift — missing: #{inspect(MapSet.difference(idx_expected, idx_actual))}, " <>
             "stale: #{inspect(MapSet.difference(idx_actual, idx_expected))}"

    # 13. parent-cell membership equals the parents table EXACTLY: one row
    # {{cell, user}, role} per parent cell of every parents row — the
    # recount counts from membership, so a miss or stray here is a wrong count
    members_expected =
      MapSet.new(
        for {uid, role, cells} <- :ets.tab2list(:geo_parents),
            cell <- cells,
            do: {{cell, uid}, role}
      )

    members_actual = MapSet.new(:ets.tab2list(:geo_members))

    assert members_expected == members_actual,
           "membership drift — missing: #{inspect(MapSet.difference(members_expected, members_actual))}, " <>
             "stray: #{inspect(MapSet.difference(members_actual, members_expected))}"

    # 9. chat history is bounded and whole: at most 50 messages per
    # conversation, all ids distinct (no loss-by-duplication, no runaway)
    for {key, _last} <- Hoodride.Chat.all_conversations() do
      msgs = :ets.lookup(:chat_messages, key)
      ids = Enum.map(msgs, fn {_k, id, _s, _t, _ts} -> id end)
      assert length(ids) <= 50, "conversation #{inspect(key)} holds #{length(ids)} messages"
      assert length(Enum.uniq(ids)) == length(ids), "duplicate message ids in #{inspect(key)}"

      # 12. every conversation is findable from BOTH sides (the per-user
      # index) — write order makes a miss impossible, sweep or not
      {a, b} = key

      assert :ets.member(:chat_by_user, {a, key}) and :ets.member(:chat_by_user, {b, key}),
             "conversation #{inspect(key)} is missing from the per-user index"
    end

    :ok
  end

  defp tally_one(:driver), do: {1, 0}
  defp tally_one(:hand), do: {0, 1}
  defp tally_add(:driver, d, h), do: {d + 1, h}
  defp tally_add(:hand, d, h), do: {d, h + 1}
end
