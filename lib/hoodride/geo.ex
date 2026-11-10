defmodule Hoodride.Geo do
  @moduledoc """
  The live world: who is where, right now. All ETS, all ephemeral.
  Cells are opaque strings (H3 computed client-side via h3-js) —
  the server indexes and broadcasts by cell without doing H3 math.
  """

  @drivers :geo_drivers
  @hands :geo_hands
  @presence :geo_presence
  # client-computed coarse parent cells per user (opaque strings), for aggregates
  @parents :geo_parents
  # derived tallies per coarse cell: {agg_cell, drivers, hands} — a cache of the
  # parents table. Hybrid freshness: shifted instantly when a parents row changes
  # (shift_agg below) and rebuilt from truth on every sweeper tick (recompute),
  # so a missed shift can never be wrong for more than one tick.
  @agg :geo_agg
  # cell index: {{cell, user_id}, :driver | :hand}, one row per membership.
  # ordered_set keeps a cell's rows adjacent, so "who is in this cell" is a
  # bound-prefix range read — O(log n + k) — instead of a full scan of the
  # user-keyed tables. One row per membership means parallel writer shards
  # never share a row (no lost updates, nothing to retry).
  @by_cell :geo_by_cell
  # parent-cell membership: {{parent_cell, user_id}, :driver | :hand}, one
  # row per (user, parent cell) — the parents table keyed by CELL. A hex's
  # members sit together in the ordered_set, so the recount counts one hex
  # in place (select_count over its key range) instead of copying every
  # parents row. Written only inside a user's own writer shard, together
  # with the parents row and the count shift (set_parents/5).
  @members :geo_members
  # each writer shard's priority alias (OTP 28+, EEP 76): {shard_pid, alias}
  @writer_aliases :geo_writer_aliases

  # called once from Application.start
  def init_tables do
    Hoodride.ETS.new(@drivers, [:named_table, :public, :set])
    Hoodride.ETS.new(@hands, [:named_table, :public, :set])
    Hoodride.ETS.new(@presence, [:named_table, :public, :set])
    Hoodride.ETS.new(@parents, [:named_table, :public, :set])
    Hoodride.ETS.new(@agg, [:named_table, :public, :set])
    Hoodride.ETS.new(@by_cell, [:named_table, :public, :ordered_set])
    Hoodride.ETS.new(@members, [:named_table, :public, :ordered_set])
    Hoodride.ETS.new(@writer_aliases, [:named_table, :public, :set])
    :ok
  end

  # ===== presence (grace enforced by the sweeper, not here) =====

  def user_connected(user_id), do: :ets.insert(@presence, {user_id, :online, now()})
  def user_disconnected(user_id), do: :ets.insert(@presence, {user_id, :grace, now()})
  # a deleted account: no presence at all, not even a grace period
  def forget_presence(user_id), do: :ets.delete(@presence, user_id)

  # Presence is DERIVED, not stored: online means "a live user channel exists
  # right now" (the Registry can't lie — dead processes vanish from it), and
  # the stored row only supplies the grace clock once no channel remains.
  # Stored-status-as-truth fell to two real races: a spare tab closing
  # overwrote :online for a still-connected user, and a dirty reload's
  # heartbeat-timeout terminate landed AFTER the new tab's join.
  def presence_of(user_id) do
    if connected?(user_id) do
      {:online, now()}
    else
      case grace_since(user_id) do
        nil -> {:offline, 0}
        since -> {:grace, since}
      end
    end
  end

  # The two halves of presence_of, for hot loops (the sweeper asks 100k
  # times a pass): no clock read, no tuple — the caller supplies "now".
  def connected?(user_id), do: Registry.lookup(Hoodride.UserChannels, user_id) != []

  @doc "When the user's grace clock started (their last presence change), or nil."
  def grace_since(user_id), do: :ets.lookup_element(@presence, user_id, 3, nil)

  # ===== serialized write API =====
  # Every multi-table mutation funnels through GeoWriter — one process, one
  # mailbox, so the cross-table checks inside the *_now functions are atomic.
  # Same signatures as always; every caller serializes transparently.

  # `spot` is the display hex the driver's app chose (res 9 — the same
  # block-level fuzz as a hand). An older app sends none: the car is then
  # shown at its cell. Never an exact position: those travel only inside a
  # ride (HoodrideWeb.RideChannel).
  def driver_update(user, cell, spot \\ nil, parents \\ []) when is_binary(spot) or is_nil(spot),
    do: Hoodride.GeoWriter.exec(user.id, {:driver_update, user, cell, spot || cell, parents})

  # (`timeout`: how long to wait for the writer — a caller that doesn't
  # need the answer, like a ride starting, waits less; the change lands
  # either way: GeoWriter.exec)
  def driver_offline(user_id, timeout \\ nil),
    do: exec(user_id, {:driver_offline, user_id}, timeout)

  def hand_up(user_id, cell, spot \\ nil, parents \\ []),
    do: Hoodride.GeoWriter.exec(user_id, {:hand_up, user_id, cell, spot, parents})

  def hand_down(user_id, timeout \\ nil), do: exec(user_id, {:hand_down, user_id}, timeout)

  defp exec(key, op, nil), do: Hoodride.GeoWriter.exec(key, op)
  defp exec(key, op, timeout), do: Hoodride.GeoWriter.exec(key, op, timeout)

  # ===== drivers (online = visible) — *_now bodies run ONLY in GeoWriter =====

  @doc false
  def driver_update_now(user, cell, spot, parents) do
    # supply and demand are mutually exclusive, enforced here, not in the
    # client: becoming a car kills any leftover ✋ (e.g. a lost mode-flip).
    # Guarded by member/2 so the every-1.5s update path never churns.
    if :ets.member(@hands, user.id), do: hand_down_core(user.id)

    {old_role, old_cells} = parents_of(user.id)
    set_parents(user.id, old_role, old_cells, :driver, Enum.uniq(parents))
    do_driver_update(user, cell, spot)
  end

  defp do_driver_update(user, cell, spot) do
    {old_cell, old_spot} =
      case :ets.lookup(@drivers, user.id) do
        [{_, c, s, _}] -> {c, s}
        [] -> {nil, nil}
      end

    # {id, cell, spot, vouched_at}: no exact position and no profile —
    # the name comes only from `reveal`. vouched_at: clients heartbeat at
    # least every ~20s, so silence beyond minutes means a wedged app.
    :ets.insert(@drivers, {user.id, cell, spot, now()})

    # index moves only on a cell change — the every-few-seconds same-cell
    # position update never touches it
    if old_cell != cell do
      if old_cell, do: :ets.delete(@by_cell, {old_cell, user.id})
      :ets.insert(@by_cell, {{cell, user.id}, :driver})
    end

    if old_cell && old_cell != cell do
      broadcast(:drivers, old_cell, "driver_left", %{id: user.id})
    end

    # announced only when it MOVED (a new spot or cell): a parked car's
    # heartbeat just refreshes vouched_at and tells nobody anything
    if {old_cell, old_spot} != {cell, spot} do
      broadcast(:drivers, cell, "driver_update", %{id: user.id, cell: cell, spot: spot})
    end

    # a car just appeared: this user is a driver now. Only on the FIRST
    # row — the every-few-seconds position update changes no role.
    if old_cell == nil, do: Hoodride.Roles.changed(user.id)
  end

  # the cell a car is filed under (the topic its watchers subscribe to)
  def driver_cell(user_id), do: :ets.lookup_element(@drivers, user_id, 2, nil)

  # the cell a raised hand is filed under, or nil
  def hand_cell(user_id), do: :ets.lookup_element(@hands, user_id, 2, nil)

  # availability check for the request front door: you can only ask a driver
  # who is actually on the map right now
  def driver_on_map?(user_id), do: :ets.member(@drivers, user_id)

  # the caller's own live hand, for rehydration (cells only, as always)
  def hand_of(user_id) do
    case :ets.lookup(@hands, user_id) do
      [{_, cell, spot}] -> %{cell: cell, spot: spot}
      [] -> nil
    end
  end

  @doc false
  def driver_offline_now(user_id), do: offline_core(user_id)

  defp offline_core(user_id) do
    # the single choke point for "this driver became unavailable" — the offline
    # button, mode flips, the sweeper's grace-reap, and ride start all land here.
    # Unavailable means nobody waits on you: decline every pending request now.
    Hoodride.Requests.decline_all_for_driver(user_id)

    # role-guarded: only MY role's altitude presence dies here — a stray
    # driver_offline must never erase a raised hand's hex count (the tiers
    # would disagree: ✋ visible at street zoom, invisible at altitude)
    case parents_of(user_id) do
      {:driver, cells} -> set_parents(user_id, :driver, cells, nil, [])
      _ -> :ok
    end

    case :ets.take(@drivers, user_id) do
      [{_, cell, _, _}] ->
        :ets.delete(@by_cell, {cell, user_id})
        broadcast(:drivers, cell, "driver_left", %{id: user_id})
        # the car is gone: no longer a driver (after the write)
        Hoodride.Roles.changed(user_id)
        # …and once more now the car is off the map: a request made between
        # the first decline and this point passed "is the driver online?" and
        # landed after that sweep (2–4 in 300 truly parallel rounds waited on
        # an offline driver until the 60 s repair — RequestsPutBackTest).
        # Requests.create re-checks after saving, so between them none is missed
        Hoodride.Requests.decline_all_for_driver(user_id)

      [] ->
        :ok
    end
  end

  # ===== hands (demand; cells only — never an exact point) =====
  # `cell` is the coarse topic/registration cell (res 8 client-side);
  # `spot` is the finer display cell (res 9) — both opaque strings here.

  @doc false
  def hand_up_now(user_id, cell, spot, parents) do
    # the other half of the exclusion: becoming demand takes you off the
    # driver map — with full unavailability semantics (waiters declined)
    if :ets.member(@drivers, user_id), do: offline_core(user_id)

    spot = spot || cell
    {old_role, old_cells} = parents_of(user_id)
    set_parents(user_id, old_role, old_cells, :hand, Enum.uniq(parents))

    # a re-raised hand in a different cell leaves its old index row behind
    # ...and the drivers watching only the old cell must hear it leave, or
    # they keep a ghost ✋ there
    case :ets.lookup(@hands, user_id) do
      [{_, old_cell, _}] when old_cell != cell ->
        :ets.delete(@by_cell, {old_cell, user_id})
        broadcast(:hands, old_cell, "hand_left", %{id: user_id})

      _ ->
        :ok
    end

    :ets.insert(@hands, {user_id, cell, spot})
    :ets.insert(@by_cell, {{cell, user_id}, :hand})
    broadcast(:hands, cell, "hand_update", %{id: user_id, cell: cell, spot: spot})
  end

  @doc false
  def hand_down_now(user_id), do: hand_down_core(user_id)

  defp hand_down_core(user_id) do
    # role-guarded, mirror of driver_offline: a stray hand_down must never
    # erase an on-duty driver's hex count
    case parents_of(user_id) do
      {:hand, cells} -> set_parents(user_id, :hand, cells, nil, [])
      _ -> :ok
    end

    case :ets.take(@hands, user_id) do
      [{_, cell, _spot}] ->
        :ets.delete(@by_cell, {cell, user_id})
        broadcast(:hands, cell, "hand_left", %{id: user_id})

      [] ->
        :ok
    end
  end

  # ===== snapshots (sent on world sync) =====

  # O(log n + k) via the cell index: the cell is bound INSIDE the key
  # pattern (a guard would not narrow the ordered_set traversal). Each hit
  # is confirmed against the main table, so an index row caught mid-update
  # on another shard can never produce a ghost in a snapshot.
  def cell_snapshot(cell) do
    rows = :ets.match_object(@by_cell, {{cell, :_}, :_})

    drivers =
      for {{_, id}, :driver} <- rows,
          [{^id, ^cell, spot, _ts}] <- [:ets.lookup(@drivers, id)] do
        %{id: id, cell: cell, spot: spot}
      end

    hands =
      for {{_, id}, :hand} <- rows,
          [{^id, ^cell, spot}] <- [:ets.lookup(@hands, id)] do
        %{id: id, cell: cell, spot: spot}
      end

    %{drivers: drivers, hands: hands}
  end

  # ===== cell index repair (sweeper) =====

  @doc """
  Users whose index rows disagree with the main tables (read-only),
  collecting only the suspects; no table is copied.

  The healthy-world path is one pass over the index, checking each row is
  backed by a map row with that role, id and cell (a one-field hash
  lookup). Two index rows can't share a backing row: same role and id
  means same cell, which means the same key. So the index maps one-to-one
  into the map rows, and if the counts are also equal, every map row has
  its index row and nothing is missing.

  Only when the counts disagree do the map-side passes run, to name the
  users whose index row is missing (tree lookups in the ordered_set index,
  the costlier direction). Any concurrent change just makes the counts
  disagree, and the full check runs.
  """
  def cell_index_drift do
    import Hoodride.ETS, only: [fold_match: 4]

    # lookup_element/4 reads ONE field with a default: no row copy, and no
    # exception for a missing key
    stray =
      fold_match(@by_cell, [{:"$1", [], [:"$1"]}], [], fn
        {{cell, id}, :driver}, acc ->
          if :ets.lookup_element(@drivers, id, 2, nil) == cell, do: acc, else: [id | acc]

        {{cell, id}, :hand}, acc ->
          if :ets.lookup_element(@hands, id, 2, nil) == cell, do: acc, else: [id | acc]
      end)

    if stray == [] and
         :ets.info(@by_cell, :size) == :ets.info(@drivers, :size) + :ets.info(@hands, :size) do
      []
    else
      indexed_as? = fn cell, id, role ->
        :ets.lookup_element(@by_cell, {cell, id}, 2, nil) == role
      end

      suspects =
        fold_match(@drivers, [{{:"$1", :"$2", :_, :_}, [], [{{:"$1", :"$2"}}]}], stray, fn
          {id, cell}, acc -> if indexed_as?.(cell, id, :driver), do: acc, else: [id | acc]
        end)

      fold_match(@hands, [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}], suspects, fn
        {id, cell}, acc -> if indexed_as?.(cell, id, :hand), do: acc, else: [id | acc]
      end)
      |> Enum.uniq()
    end
  end

  # repairs run in the USER's own writer shard, so they are serialized with
  # that user's live updates and can't race them; anything in flight when the
  # sweeper looked is simply re-derived fresh here
  # (a car silent this long is frozen: the sweeper reaps it — the repair
  # never brings it back on watchers' maps meanwhile; = Sweeper's limit)
  @repair_fresh_s 3 * 60

  def reindex_user(user_id), do: Hoodride.GeoWriter.exec(user_id, {:reindex, user_id})

  @doc false
  def reindex_user_now(user_id) do
    expected =
      case :ets.lookup(@drivers, user_id) do
        [{_, cell, _, _}] -> [{{cell, user_id}, :driver}]
        [] -> []
      end ++
        case :ets.lookup(@hands, user_id) do
          [{_, cell, _}] -> [{{cell, user_id}, :hand}]
          [] -> []
        end

    actual = :ets.match_object(@by_cell, {{:_, user_id}, :_})
    stale = actual -- expected
    missing = expected -- actual
    Enum.each(stale, fn {key, _} -> :ets.delete(@by_cell, key) end)
    Enum.each(missing, &:ets.insert(@by_cell, &1))

    # the repair TELLS the watchers, as the interrupted move would have:
    # the old cell's "left" (else a ghost stays on their maps), the new
    # cell's update (else they never see them arrive) — "left" first
    Enum.each(stale, fn
      {{cell, _}, :driver} -> broadcast(:drivers, cell, "driver_left", %{id: user_id})
      {{cell, _}, :hand} -> broadcast(:hands, cell, "hand_left", %{id: user_id})
    end)

    # — but never announces what the normal path wouldn't: someone in a
    # ride (claimed seats count: the car's own "offline" is on its way), or
    # a car whose position went silent (the next sweep reaps it)
    # a "left" names only the id: an app watching the ghost cell AND the
    # real one would delete them by id — so after any "left", where they
    # really are is announced again (not only newly indexed cells)
    announce = if stale == [], do: missing, else: expected

    if Hoodride.Rides.ride_id_of_user(user_id) == nil do
      now = System.system_time(:second)

      Enum.each(announce, fn
        {{cell, _}, :driver} ->
          case :ets.lookup(@drivers, user_id) do
            [{_, ^cell, spot, ts}] when now - ts <= @repair_fresh_s ->
              broadcast(:drivers, cell, "driver_update", %{id: user_id, cell: cell, spot: spot})

            _ ->
              :ok
          end

        {{cell, _}, :hand} ->
          case :ets.lookup(@hands, user_id) do
            [{_, ^cell, spot}] ->
              broadcast(:hands, cell, "hand_update", %{id: user_id, cell: cell, spot: spot})

            _ ->
              :ok
          end
      end)
    end

    :ok
  end

  # ===== membership repair (sweeper) =====

  @doc """
  Users whose membership rows disagree with their parents row (read-only),
  run by the sweeper BEFORE the recount — the recount trusts membership.
  Same shape as cell_index_drift: one pass checking each membership row is
  backed by its user's parents row (that role, that cell); rows can't share
  a backing (a user's cell appears once, deduplicated on write), so if the
  row count also equals the total parent cells, nothing is missing. Only
  then is the costlier parents-side pass skipped.
  """
  def member_drift do
    import Hoodride.ETS, only: [fold_match: 4]

    stray =
      fold_match(@members, [{:"$1", [], [:"$1"]}], [], fn {{cell, id}, role}, acc ->
        case :ets.lookup(@parents, id) do
          [{_, ^role, cells}] -> if cell in cells, do: acc, else: [id | acc]
          _ -> [id | acc]
        end
      end)

    expected =
      fold_match(@parents, [{{:_, :_, :"$1"}, [], [:"$1"]}], 0, fn cells, n ->
        n + length(cells)
      end)

    if stray == [] and :ets.info(@members, :size) == expected do
      []
    else
      fold_match(@parents, [{:"$1", [], [:"$1"]}], stray, fn {id, role, cells}, acc ->
        if Enum.all?(cells, &(:ets.lookup_element(@members, {&1, id}, 2, nil) == role)),
          do: acc,
          else: [id | acc]
      end)
      |> Enum.uniq()
    end
  end

  # re-derived inside the user's own shard, serialized with their live ops
  def rebuild_members(user_id), do: Hoodride.GeoWriter.exec(user_id, {:rebuild_members, user_id})

  @doc false
  def rebuild_members_now(user_id) do
    expected =
      case parents_of(user_id) do
        {nil, []} -> []
        {role, cells} -> for c <- cells, do: {{c, user_id}, role}
      end

    actual = :ets.match_object(@members, {{:_, user_id}, :_})
    Enum.each(actual -- expected, fn {key, _} -> :ets.delete(@members, key) end)
    Enum.each(expected -- actual, &:ets.insert(@members, &1))
    :ok
  end

  # ===== aggregates (V1: full periodic recompute — cache of the live tables) =====

  def agg_counts_for(cell) do
    case :ets.lookup(@agg, cell) do
      [{_, drivers, hands}] -> %{drivers: drivers, hands: hands}
      [] -> %{drivers: 0, hands: 0}
    end
  end

  # ===== the recount: many tiny pauses, one batch of hexes each =====
  # The instant layer (shift_agg) keeps counts exact; the recount is the
  # safety net for what it can't see — a shard crashing between its parents
  # write and its count shift, or a future bug. It must never read that gap
  # mid-flight (a torn read "heals" a count the finishing writer then bumps
  # again: a double count), so it reads only while every writer shard is
  # paused BETWEEN ops (with_writers_held — the kernel's locking-reader form,
  # read_seqlock_excl; a shared seqlock was unsound with eight writers).
  #
  # A hex's count depends only on its own members, so each batch of hexes
  # needs only its OWN still moment: pause, count each hex's members in
  # place (select_count over its @members key range — nothing copied), read
  # its stored count, release, heal. Many short pauses instead of one that
  # grows with the world. Measured on the model (test/support/recount_model.ex,
  # bench/batch_sweep_bench.exs) against one big pause, versioned/optimistic
  # and hybrid strategies, every batch size 1..30 and eight sizing rules —
  # see ARCHITECTURE.md.

  # The longest the map may ever stall for one pause, whatever goes wrong
  # (a slow shard, a wedged recount). A healthy pause is well under 1 ms.
  @max_pause_ms 250
  @doc false
  def max_pause_ms, do: @max_pause_ms

  # How long one pause spends counting hexes. Comparable to the ~0.1-0.3 ms
  # it takes to stop the writers at all, within Metronome's 500 µs slice;
  # measured: 150-500 µs is a flat plateau, 250 the steadiest.
  @pause_target_us 250

  # smoothing weight kept from the previous per-hex cost estimate
  @ewma_keep 0.75

  @doc """
  Recount the hex tallies from truth and heal any drift. Returns :ok, or
  :skipped when a pause couldn't be taken (a writer stuck mid-op; the next
  sweep retries). Runs in the CALLER — never from inside a shard.
  """
  def recompute_aggregates do
    # one recount at a time: two holders each pausing half the shards would
    # only wait each other out
    :global.trans({__MODULE__.Recount, self()}, &recount/0, [node()])
  end

  defp recount do
    prune_orphans()

    {result, stats} =
      batch_loop(recount_cells(), :ok, %{
        pauses: 0,
        first_batch: nil,
        max_batch: 0,
        max_pause_us: 0
      })

    # what this recount did, for tests and telemetry (calling process only)
    Process.put({__MODULE__, :last_recount}, stats)
    result
  end

  # altitude orphans: a parents row whose street-map row is gone (a crash
  # between the two writes). Its OWN shard removes it — row, membership and
  # count shift together, serialized with that user's live ops.
  defp prune_orphans do
    import Hoodride.ETS, only: [each_match: 3]

    each_match(@parents, [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}], fn {id, role} ->
      table = if role == :driver, do: @drivers, else: @hands
      unless :ets.member(table, id), do: Hoodride.GeoWriter.exec(id, {:prune_orphan, id})
    end)
  end

  @doc false
  def prune_orphan_now(user_id) do
    case parents_of(user_id) do
      {:driver, cells} ->
        unless :ets.member(@drivers, user_id),
          do: set_parents(user_id, :driver, cells, nil, [])

      {:hand, cells} ->
        unless :ets.member(@hands, user_id), do: set_parents(user_id, :hand, cells, nil, [])

      {nil, []} ->
        :ok
    end
  end

  # every hex that has a stored count or any member
  defp recount_cells do
    stored = :ets.select(@agg, [{{:"$1", :_, :_}, [], [:"$1"]}])
    Enum.uniq(stored ++ member_cells(:ets.first(@members), []))
  end

  # distinct cells by key jumps: {cell, :end} sorts after every
  # {cell, integer_id}, so next/2 lands on the next cell's first row
  defp member_cells(:"$end_of_table", acc), do: acc

  defp member_cells({cell, _id}, acc),
    do: member_cells(:ets.next(@members, {cell, :end}), [cell | acc])

  defp batch_loop([], result, stats), do: {result, stats}

  defp batch_loop(cells, result, stats) do
    limit = next_batch_limit()
    t0 = System.monotonic_time(:microsecond)
    held = with_writers_held(fn _held? -> take_batch(cells, limit) end)
    # holds sent → writers released: how long this pause could stall a write
    pause_us = System.monotonic_time(:microsecond) - t0

    stats = %{
      stats
      | pauses: stats.pauses + 1,
        max_pause_us: max(stats.max_pause_us, pause_us)
    }

    case held do
      {:ok, {rows, rest, count_us}} ->
        n = length(rows)
        learn_batch(n, count_us)

        heal_cells(
          Map.new(for {c, d, h, _} <- rows, d + h > 0, do: {c, {d, h}}),
          Map.new(for {c, _, _, had} <- rows, had != nil, do: {c, had})
        )

        stats = %{stats | first_batch: stats.first_batch || n, max_batch: max(stats.max_batch, n)}
        batch_loop(rest, result, stats)

      # a writer couldn't be paused: every later pause would wait out the
      # same cap, so this sweep stops here
      :expired ->
        {:skipped, stats}
    end
  end

  # Batch sizing — the safeguarded EWMA, measured best of nine rules
  # (bench/batch_sweep_bench.exs):
  #   * predict how many hexes fit the target from a smoothed per-hex cost
  #     (pt-table-checksum's chunk-time sizing — an exponentially weighted
  #     moving average, the estimator TCP uses for round-trip time);
  #   * never more than double the previous batch (Percona's production
  #     lesson: unbounded growth once overshot a cluster);
  #   * and the clock still stops each pause at the target whatever the
  #     prediction said — so every pause is at most target + one hex.
  # The learned estimate lives in the recounting process and carries over
  # between sweeps.
  defp next_batch_limit do
    st = Process.get({__MODULE__, :batch}, %{})

    predicted =
      case st[:per_hex_us] do
        nil -> 1
        us -> max(1, round(@pause_target_us / us))
      end

    min(predicted, 2 * Map.get(st, :last, 1))
  end

  defp learn_batch(n, count_us) do
    st = Process.get({__MODULE__, :batch}, %{})
    # coarse clocks (Windows steps ~100 µs) can read 0: never claim hexes are free
    sample = max(count_us, 1) / n

    per_hex =
      case st[:per_hex_us] do
        nil -> sample
        old -> @ewma_keep * old + (1 - @ewma_keep) * sample
      end

    Process.put({__MODULE__, :batch}, %{per_hex_us: per_hex, last: n})
  end

  # inside the pause: count hexes in place until the batch is full or the
  # target time is spent (at least one hex per pause)
  defp take_batch(cells, limit) do
    start = System.monotonic_time(:microsecond)
    {rows, rest} = take_batch(cells, limit, start, [], 0)
    {rows, rest, System.monotonic_time(:microsecond) - start}
  end

  defp take_batch([], _limit, _start, rows, _n), do: {rows, []}

  defp take_batch([cell | rest] = cells, limit, start, rows, n) do
    if n >= limit or (n > 0 and System.monotonic_time(:microsecond) - start >= @pause_target_us) do
      {rows, cells}
    else
      row = {
        cell,
        :ets.select_count(@members, [{{{cell, :_}, :driver}, [], [true]}]),
        :ets.select_count(@members, [{{{cell, :_}, :hand}, [], [true]}]),
        case :ets.lookup(@agg, cell) do
          [{_, d, h}] -> {d, h}
          [] -> nil
        end
      }

      take_batch(rest, limit, start, [row | rows], n + 1)
    end
  end

  @doc """
  Run `fun` with every GeoWriter shard paused between ops. `fun` gets a
  `held?` check; the result is `{:ok, result}` only if the pause held for
  all of `fun`, else `:expired` (a shard too slow to pause, the time cap
  reached, or a shard restarted mid-pause — its fresh process was never held).
  """
  def with_writers_held(fun) do
    shards = writer_shards()
    token = make_ref()
    # every shard's own cap starts when it RECEIVES the hold, after this
    # instant — so while now < deadline, no shard can have timed out
    deadline = System.monotonic_time(:millisecond) + @max_pause_ms
    hold = {:hold, self(), token, @max_pause_ms}

    # through each shard's PRIORITY alias (OTP 28+, EEP 76) the hold skips
    # ahead of every queued update — measured 2-8× less waiting when the
    # writers are flooded, no cost otherwise
    Enum.each(shards, fn shard ->
      case :ets.lookup(@writer_aliases, shard) do
        [{_, prio_alias}] -> :erlang.send(prio_alias, hold, [:priority])
        [] -> send(shard, hold)
      end
    end)

    held? = fn ->
      System.monotonic_time(:millisecond) < deadline and writer_shards() == shards
    end

    try do
      if await_held(shards, token, deadline) do
        result = fun.(held?)
        if held?.(), do: {:ok, result}, else: :expired
      else
        :expired
      end
    after
      # sent to every shard, held or not: a late one finds it waiting
      Enum.each(shards, &send(&1, {:release, token}))
    end
  end

  defp writer_shards do
    for {_, pid, _, _} <- PartitionSupervisor.which_children(Hoodride.GeoWriters),
        is_pid(pid),
        do: pid
  end

  defp await_held([], _token, _deadline), do: true

  defp await_held(waiting, token, deadline) do
    receive do
      {:held, ^token, pid} -> await_held(List.delete(waiting, pid), token, deadline)
    after
      max(deadline - System.monotonic_time(:millisecond), 0) -> false
    end
  end

  defp heal_cells(expected, actual) do
    for cell <- Enum.uniq(Map.keys(expected) ++ Map.keys(actual)) do
      {ed, eh} = Map.get(expected, cell, {0, 0})

      case Map.get(actual, cell) do
        {^ed, ^eh} ->
          :ok

        nil ->
          # absent at snapshot: create only if STILL absent
          if :ets.insert_new(@agg, {cell, ed, eh}),
            do: settle_and_broadcast(cell, changed_sides({0, 0}, {ed, eh}))

        {ad, ah} ->
          if :ets.select_replace(@agg, [{{cell, ad, ah}, [], [{:const, {cell, ed, eh}}]}]) == 1 do
            settle_and_broadcast(cell, changed_sides({ad, ah}, {ed, eh}))
          end
      end
    end

    :ok
  end

  # ===== instant layer: shift tallies the moment one parents row changes =====
  # Called from the four row-write functions above (the ONLY places parents
  # rows change — the sweeper and ride/request code all route through them).
  # Atomic per-cell via :ets.update_counter; the periodic recompute remains
  # the source of truth and heals any interleaving within one tick.

  defp parents_of(user_id) do
    case :ets.lookup(@parents, user_id) do
      [{_, role, cells}] -> {role, cells}
      [] -> {nil, []}
    end
  end

  # The ONE place a parents row changes: the row, the instant count shift
  # and the membership rows move together, inside the user's own shard.
  # Unchanged role and cells (the every-few-seconds position update) write
  # nothing at all.
  defp set_parents(user_id, old_role, old_cells, new_role, new_cells) do
    if {old_role, old_cells} != {new_role, new_cells} do
      if new_role,
        do: :ets.insert(@parents, {user_id, new_role, new_cells}),
        else: :ets.delete(@parents, user_id)

      shift_agg(old_role, old_cells, new_role, new_cells)

      # a role change re-files every cell; otherwise only the cells that moved
      for c <- old_cells -- new_cells, do: :ets.delete(@members, {c, user_id})
      added = if old_role == new_role, do: new_cells -- old_cells, else: new_cells
      for c <- added, do: :ets.insert(@members, {{c, user_id}, new_role})
    end

    :ok
  end

  # tuple positions in @agg rows {cell, drivers, hands}
  defp role_pos(:driver), do: 2
  defp role_pos(:hand), do: 3

  defp shift_agg(old_role, old_cells, new_role, new_cells) do
    deltas =
      Map.merge(
        cell_deltas(old_role, old_cells, -1),
        cell_deltas(new_role, new_cells, +1),
        fn _k, a, b -> a + b end
      )

    # cell → the sides that moved (one shift can move both: a driver raising
    # a hand leaves the car count and joins the hand count of the same hexes)
    touched =
      for {{cell, pos}, delta} <- deltas, delta != 0, reduce: %{} do
        acc ->
          :ets.update_counter(@agg, cell, counter_op(pos, delta), {cell, 0, 0})
          Map.update(acc, cell, [pos_side(pos)], &[pos_side(pos) | &1])
      end

    Enum.each(touched, fn {cell, sides} -> settle_and_broadcast(cell, sides) end)
  end

  defp pos_side(2), do: :drivers
  defp pos_side(3), do: :hands

  # the sides whose number differs between two {drivers, hands} tallies
  defp changed_sides({d1, h1}, {d2, h2}) do
    [{:drivers, d1 != d2}, {:hands, h1 != h2}]
    |> Enum.filter(&elem(&1, 1))
    |> Enum.map(&elem(&1, 0))
  end

  # decrements floor at zero (ETS threshold form): even unforeseen mischief
  # can never push a hex count negative
  defp counter_op(pos, delta) when delta < 0, do: {pos, delta, 0, 0}
  defp counter_op(pos, delta), do: {pos, delta}

  # Publishes ONLY the sides that changed, each to its own audience. Sending
  # the other side too — even an unchanged number — would tell riders WHEN
  # hands come and go (and drivers when cars do): a timing leak.
  # (public only for its tests: two shards' interleavings are set up directly)
  @doc false
  def settle_and_broadcast(_cell, []), do: :ok

  def settle_and_broadcast(cell, sides) do
    # atomic compare-and-delete: only an exactly-zero row dies, so another
    # shard's concurrent increment on the same hex can never be lost
    sent =
      if :ets.select_delete(@agg, [{{cell, 0, 0}, [], [true]}]) == 1 do
        broadcast_agg(cell, sides, 0, 0)
        {0, 0}
      else
        case :ets.lookup(@agg, cell) do
          [{_, d, h}] ->
            broadcast_agg(cell, sides, d, h)
            {d, h}

          # gone: another shard took it to 0/0 and deleted it — its own
          # side it announced; OURS moved too, so ours is said (0), or its
          # watchers keep the old count until the hex next changes
          [] ->
            broadcast_agg(cell, sides, 0, 0)
            {0, 0}
        end
      end

    reconfirm_agg(cell, sides, sent, 3)
  end

  # Another shard counting the same hex sends the number IT read — and two
  # senders' messages land in either order: its older number could arrive
  # after ours and leave watchers on it until the hex next changed. So the
  # count is read again AFTER sending: moved meanwhile, it's sent again. The
  # last number any watcher gets was then read after the last change
  # (bounded: a hex that keeps changing has its own next send coming).
  # (`read` is the count's reader — the table; a test passes one whose
  # count never settles, to pin the bound)
  @doc false
  def reconfirm_agg(cell, sides, sent, tries, read \\ &read_agg/1)

  def reconfirm_agg(_cell, _sides, _sent, 0, _read), do: :ok

  def reconfirm_agg(cell, sides, sent, tries, read) do
    now = read.(cell)

    # per SIDE: a side is sent again only if ITS count moved — never
    # because the other side did (a repeat of the car count would tell
    # riders a hand went up or down there: the privacy law)
    moved = Enum.filter(Enum.uniq(sides), &(side_count(now, &1) != side_count(sent, &1)))

    if moved == [] do
      :ok
    else
      {d, h} = now
      broadcast_agg(cell, moved, d, h)
      reconfirm_agg(cell, sides, now, tries - 1, read)
    end
  end

  defp read_agg(cell) do
    case :ets.lookup(@agg, cell) do
      [{_, d, h}] -> {d, h}
      [] -> {0, 0}
    end
  end

  defp side_count({d, _h}, :drivers), do: d
  defp side_count({_d, h}, :hands), do: h

  defp cell_deltas(nil, _cells, _sign), do: %{}

  defp cell_deltas(role, cells, sign) do
    pos = role_pos(role)
    Enum.reduce(cells, %{}, fn c, acc -> Map.update(acc, {c, pos}, sign, &(&1 + sign)) end)
  end

  defp broadcast_agg(cell, sides, drivers, hands) do
    for side <- Enum.uniq(sides) do
      count = if side == :drivers, do: drivers, else: hands

      HoodrideWeb.Endpoint.broadcast(
        agg_topic(side, cell),
        "agg_update",
        with_json(%{:cell => cell, side => count})
      )
    end

    :ok
  end

  defp broadcast(layer, cell, event, payload) do
    HoodrideWeb.Endpoint.broadcast(geo_topic(layer, cell), event, with_json(payload))
  end

  # ENCODE ONCE: every map update carries `json`, itself encoded here ONCE,
  # which a batching map channel puts on the wire as-is — instead of every
  # watcher's channel encoding the same update again (~36% of a map
  # channel's time under load; Hoodride.MapJsonTest, WorldChannel)
  defp with_json(payload), do: Map.put(payload, :json, Jason.encode!(payload))

  # ===== topics: one per LAYER, so each role subscribes only to its own =====
  # Cars and hands used to share one topic per hex, which put every hand on
  # every rider's wire (the app merely hid it). Split, a rider's channel
  # never even receives a hand; a driver's never a rival's car.

  @doc "The live-marker topic for a layer (:drivers | :hands) of a cell."
  def geo_topic(:drivers, cell), do: "geo:d:" <> cell
  def geo_topic(:hands, cell), do: "geo:h:" <> cell

  @doc "The count topic for one side (:drivers | :hands) of a coarse cell."
  def agg_topic(:drivers, cell), do: "agg:d:" <> cell
  def agg_topic(:hands, cell), do: "agg:h:" <> cell

  defp now, do: System.system_time(:second)
end
