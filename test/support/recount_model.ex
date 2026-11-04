defmodule Hoodride.RecountModel do
  @moduledoc """
  A self-contained model of the hex-count machinery, running EITHER recount
  strategy on identical writer code, so the two can be compared fairly:

    * `:pause` — today's Hoodride.Geo design: pause every shard between ops,
      copy the tables, release, then tally and heal (per-cell CAS).
    * `:versioned` — optimistic, Silo-style: every parents row carries a
      unique stamp, plus a `{:pending, old_cells}` marker while its update
      is in flight. The recount reads parents, then the counts, then parents
      again; any user whose row moved, appeared, vanished or was pending is
      UNSTABLE, and every cell they touched is skipped this round. Nobody is
      ever paused.

  Faithful to Geo where it matters: 8 sharded writers routed by user id,
  the same two-table update (parents row, then count shift), the same shift
  arithmetic (per-cell update_counter, floor at zero, delete-at-zero),
  map rows (`present`) for orphan detection, the same pause protocol and
  the same tally/heal code. Simplified where it doesn't: one role (drivers),
  no broadcasts.

  Writers in BOTH modes skip the parents write when a user's cells didn't
  change (the common position update), so neither mode pays for the other.

  Row formats — :pause: `{u, cells}`; :versioned: `{u, cells, stamp, nil |
  {:pending, old_cells}}`.
  """

  alias Hoodride.RecountModel.Shard

  defstruct [
    :mode,
    :parents,
    :agg,
    :present,
    :members,
    :aliases,
    :shards,
    :sup,
    :name,
    batch: 100,
    prio: false
  ]

  @max_pause_ms 250

  # ===== lifecycle =====

  def start(mode, shards \\ 8) when mode in [:pause, :versioned, :hybrid, :batched] do
    name = :"recount_model_#{System.unique_integer([:positive])}"

    m = %__MODULE__{
      mode: mode,
      parents: :ets.new(:model_parents, [:set, :public, write_concurrency: true]),
      agg: :ets.new(:model_agg, [:set, :public, write_concurrency: true]),
      present: :ets.new(:model_present, [:set, :public, write_concurrency: true]),
      # :batched only — {{cell, u}}: a cell's members sit together
      members: :ets.new(:model_members, [:ordered_set, :public, write_concurrency: true]),
      # each shard's priority alias (OTP 28+, EEP 76): {shard_pid, alias}
      aliases: :ets.new(:model_aliases, [:set, :public]),
      shards: shards,
      name: name
    }

    # the tables outlive any shard crash: owned by a holder process
    holder = spawn(fn -> receive do: (:stop -> :ok) end)

    for t <- [m.parents, m.agg, m.present, m.members, m.aliases],
        do: :ets.give_away(t, holder, nil)

    {:ok, sup} =
      PartitionSupervisor.start_link(
        child_spec: {Shard, model: m},
        name: name,
        partitions: shards,
        with_arguments: fn [opts], partition -> [Keyword.put(opts, :partition, partition)] end
      )

    Process.unlink(sup)
    %{m | sup: {sup, holder}}
  end

  def stop(%__MODULE__{sup: {sup, holder}}) do
    Supervisor.stop(sup)
    send(holder, :stop)
    :ok
  end

  def stamp, do: System.unique_integer([:monotonic])

  @doc "Benchmark switch: every writer shard runs at `level` (:normal | :high) from now on."
  def set_writer_priority(m, level) do
    for pid <- shard_pids(m), do: send(pid, {:set_priority, level})
    # the switch is applied once each shard has handled everything before it
    Enum.each(shard_pids(m), &:sys.get_state/1)
    :ok
  end

  # ===== client API (routed to the user's shard) =====

  def update(m, u, cells), do: GenServer.call(via(m, u), {:update, u, cells})
  def offline(m, u), do: GenServer.call(via(m, u), {:offline, u})
  def call(m, u, msg), do: GenServer.call(via(m, u), msg, :infinity)

  defp via(m, u), do: {:via, PartitionSupervisor, {m.name, u}}

  def shard_pids(m) do
    for {_, pid, _, _} <- PartitionSupervisor.which_children(m.name), is_pid(pid), do: pid
  end

  # ===== writer bodies (run ONLY inside the user's shard) =====

  @doc false
  def update_now(m, u, cells, mid_op \\ fn -> :ok end) do
    old = cells_of(m, u)

    if old == cells do
      # same cells: only the map row (position) changes — nothing counts
      :ets.insert(m.present, {u})
    else
      case m.mode do
        plain when plain in [:pause, :batched] ->
          :ets.insert(m.parents, {u, cells})
          mid_op.()
          shift(m, old, cells)
          if plain == :batched, do: move_members(m, u, old, cells)
          :ets.insert(m.present, {u})

        # :versioned and :hybrid share the stamped writer path
        _stamped ->
          # enter: mark in flight, recording BOTH old and new cells
          :ets.insert(m.parents, {u, cells, stamp(), {:pending, old}})
          mid_op.()
          shift(m, old, cells)
          :ets.insert(m.present, {u})
          # leave: stable, with a fresh stamp
          :ets.insert(m.parents, {u, cells, stamp(), nil})
      end
    end

    :ok
  end

  @doc false
  def offline_now(m, u) do
    old = cells_of(m, u)

    if old != [] do
      case m.mode do
        plain when plain in [:pause, :batched] ->
          :ets.delete(m.parents, u)
          shift(m, old, [])
          if plain == :batched, do: move_members(m, u, old, [])

        _stamped ->
          :ets.insert(m.parents, {u, [], stamp(), {:pending, old}})
          shift(m, old, [])
          :ets.delete(m.parents, u)
      end
    end

    :ets.delete(m.present, u)
    :ok
  end

  # :batched membership upkeep: only the cells that actually changed
  defp move_members(m, u, old, new) do
    for c <- old -- new, do: :ets.delete(m.members, {c, u})
    for c <- new -- old, do: :ets.insert(m.members, {{c, u}})
  end

  @doc false
  # :batched crash recovery, run by a (re)starting shard for ITS users: the
  # parents rows are the truth, membership rows are re-derived from them
  def rebuild_members_now(m, partition) do
    mine? = fn u -> rem(u, m.shards) == partition end

    for {{c, u} = key} <- :ets.tab2list(m.members), mine?.(u) do
      still_member? =
        case :ets.lookup(m.parents, u) do
          [{_, cells}] -> c in cells
          [] -> false
        end

      unless still_member?, do: :ets.delete(m.members, key)
    end

    for {u, cells} <- :ets.tab2list(m.parents),
        mine?.(u),
        c <- cells,
        do: :ets.insert(m.members, {{c, u}})
  end

  # orphan removal, serialized with the user's own ops: only if the row is
  # still exactly what the recount saw and still has no map row
  @doc false
  def prune_orphan_now(%__MODULE__{mode: :batched} = m, {u, cells} = row) do
    if :ets.lookup(m.parents, u) == [row] and not :ets.member(m.present, u) do
      :ets.delete(m.parents, u)
      shift(m, cells, [])
      move_members(m, u, cells, [])
    end
  end

  def prune_orphan_now(m, {u, cells, _stamp, nil} = row) do
    if :ets.lookup(m.parents, u) == [row] and not :ets.member(m.present, u) do
      :ets.insert(m.parents, {u, [], stamp(), {:pending, cells}})
      shift(m, cells, [])
      :ets.delete(m.parents, u)
    end
  end

  defp cells_of(m, u) do
    case :ets.lookup(m.parents, u) do
      [{_, cells}] -> cells
      [{_, cells, _, _}] -> cells
      [] -> []
    end
  end

  # Geo.shift_agg's arithmetic, one role: per-cell update_counter, floor at
  # zero, atomic delete-at-zero.
  #
  # The stamped modes' count rows are {cell, count, version}: every change
  # bumps the version IN THE SAME update_counter call (atomic), and rows are
  # never deleted, so a version only ever grows. Their heal compares the
  # version, not the value — a value that changed and changed back (ABA)
  # still reads as changed. (Silo's TIDs, for the same reason.)
  defp shift(m, old, new) do
    deltas =
      Map.merge(Map.new(old, &{&1, -1}), Map.new(new, &{&1, 1}), fn _, a, b -> a + b end)

    for {cell, d} <- deltas, d != 0 do
      op = if d < 0, do: {2, d, 0, 0}, else: {2, d}

      if stamped?(m) do
        :ets.update_counter(m.agg, cell, [op, {3, 1}], {cell, 0, 0})
      else
        :ets.update_counter(m.agg, cell, op, {cell, 0})
        :ets.select_delete(m.agg, [{{cell, 0}, [], [true]}])
      end
    end
  end

  defp stamped?(%__MODULE__{mode: mode}), do: mode in [:versioned, :hybrid]

  # the count rows as a map cell => count (stamped: version kept alongside)
  defp agg_snapshot(m) do
    for row <- :ets.tab2list(m.agg), into: %{} do
      case row do
        {c, n} -> {c, n}
        {c, n, v} -> {c, {n, v}}
      end
    end
  end

  # ===== the two recount strategies =====

  @doc """
  Recount and heal. Returns `%{result: :ok | :skipped, healed: n,
  skipped_cells: n}`.
  """
  def recount(m, hooks \\ [])

  # :batched — many tiny pauses: a cell's count depends only on its own
  # members, so each batch of cells needs only its OWN still moment. Inside
  # a pause: count each cell's members in place (select_count over its key
  # range — nothing copied) and read its stored count. Outside: heal (CAS).
  # Orphans go to their own shard, which removes the row, its membership
  # rows and its count together.
  #
  # m.batch sets each pause's size: an integer = that many cells per pause;
  # {:budget_us, n} = keep counting cells until n µs have passed inside the
  # pause (at least one cell), then release — the pause length is bounded
  # by design and the batch adapts to how crowded the cells are.
  # If a pause can't be taken (a writer stuck mid-op), the recount stops:
  # every later pause would wait out the same cap.
  def recount(%__MODULE__{mode: :batched} = m, _hooks) do
    for {u, cells} <- :ets.tab2list(m.parents),
        not :ets.member(m.present, u),
        do: GenServer.cast(via(m, u), {:prune_orphan, {u, cells}})

    cells = Enum.uniq(Map.keys(Map.new(:ets.tab2list(m.agg))) ++ member_cells(m))

    acc =
      batch_loop(m, cells, %{
        result: :ok,
        healed: 0,
        skipped_cells: 0,
        max_pause_us: 0,
        max_acquire_us: 0,
        pauses: 0
      })

    if acc.skipped_cells > 0 and acc.skipped_cells == length(cells),
      do: %{acc | result: :skipped},
      else: acc
  end

  def recount(%__MODULE__{mode: :pause} = m, _hooks) do
    m
    |> pause_recount()
    |> Map.merge(%{
      max_pause_us: Process.get(:model_last_pause_us),
      max_acquire_us: Process.get(:model_last_acquire_us, 0)
    })
  end

  # hooks (tests only): :after_first_read / :after_counts run ops INSIDE the
  # read window, deterministically
  def recount(%__MODULE__{mode: :versioned} = m, hooks) do
    first = Map.new(:ets.tab2list(m.parents), fn {u, c, s, p} -> {u, {c, s, p}} end)
    Keyword.get(hooks, :after_first_read, fn -> :ok end).()
    agg = agg_snapshot(m)
    Keyword.get(hooks, :after_counts, fn -> :ok end).()
    second = Map.new(:ets.tab2list(m.parents), fn {u, c, s, p} -> {u, {c, s, p}} end)
    Keyword.get(hooks, :after_second_read, fn -> :ok end).()

    users = MapSet.union(MapSet.new(Map.keys(first)), MapSet.new(Map.keys(second)))

    {stable, skip} =
      Enum.reduce(users, {[], MapSet.new()}, fn u, {stable, skip} ->
        a = Map.get(first, u)
        b = Map.get(second, u)

        case {a, b} do
          # present in both reads, same stamp, never pending: untouched
          {{c, s, nil}, {c, s, nil}} -> {[{u, c, s} | stable], skip}
          _ -> {stable, MapSet.union(skip, touched(a) |> MapSet.union(touched(b)))}
        end
      end)

    # stable rows with no map row are orphans: their own shard removes them
    # (serialized with that user's ops); their cells wait a round
    {live, orphans} = Enum.split_with(stable, fn {u, _c, _s} -> :ets.member(m.present, u) end)

    skip =
      Enum.reduce(orphans, skip, fn {u, c, s}, acc ->
        GenServer.cast(via(m, u), {:prune_orphan, {u, c, s, nil}})
        MapSet.union(acc, MapSet.new(c))
      end)

    healed = heal(m, tally(Enum.map(live, &elem(&1, 1))), agg, skip)
    %{result: :ok, healed: healed, skipped_cells: MapSet.size(skip), max_pause_us: 0}
  end

  # Linux's read_seqbegin_or_lock() shape: optimistic first; only if that
  # had to skip cells, one pause to read a still world and heal everything
  # (the skipped cells included). No pause at all when nothing was skipped.
  def recount(%__MODULE__{mode: :hybrid} = m, hooks) do
    optimistic = recount(%{m | mode: :versioned}, hooks)

    if optimistic.skipped_cells == 0 do
      Map.merge(optimistic, %{paused: false, max_pause_us: 0})
    else
      case with_writers_held(m, fn held? ->
             rows = :ets.tab2list(m.parents)
             # only a crashed, not-yet-restarted shard can leave a pending
             # row while everyone is held: its user's cells wait
             {pending, settled} = Enum.split_with(rows, &match?({_, _, _, {:pending, _}}, &1))

             {live, orphans} =
               Enum.split_with(settled, fn {u, _, _, _} -> :ets.member(m.present, u) end)

             if held?.(), do: Enum.each(orphans, &:ets.delete_object(m.parents, &1))
             {live, pending, agg_snapshot(m)}
           end) do
        {:ok, {live, pending, agg}} ->
          skip =
            Enum.reduce(pending, MapSet.new(), fn {_, c, s, p}, acc ->
              MapSet.union(acc, touched({c, s, p}))
            end)

          healed = heal(m, tally(Enum.map(live, &elem(&1, 1))), agg, skip)

          %{
            result: :ok,
            healed: optimistic.healed + healed,
            skipped_cells: MapSet.size(skip),
            paused: true,
            max_pause_us: Process.get(:model_last_pause_us)
          }

        :expired ->
          # couldn't pause: keep what the optimistic pass healed
          Map.merge(optimistic, %{
            paused: :expired,
            max_pause_us: Process.get(:model_last_pause_us)
          })
      end
    end
  end

  defp batch_loop(_m, [], acc), do: acc

  defp batch_loop(m, cells, acc) do
    limit = next_limit(m.batch)
    read = with_writers_held(m, fn _held? -> take_batch(m, cells, limit) end)

    acc = %{
      acc
      | max_pause_us: max(acc.max_pause_us, Process.get(:model_last_pause_us)),
        max_acquire_us: max(acc.max_acquire_us, Process.get(:model_last_acquire_us, 0)),
        pauses: acc.pauses + 1
    }

    case read do
      {:ok, {rows, rest, count_us}} ->
        learn(m.batch, length(rows), count_us, Process.get(:model_last_acquire_us))
        expected = for {c, n, _} <- rows, n > 0, into: %{}, do: {c, n}
        actual = for {c, _, had} <- rows, had != nil, into: %{}, do: {c, had}
        batch_loop(m, rest, %{acc | healed: acc.healed + heal(m, expected, actual, MapSet.new())})

      :expired ->
        %{acc | skipped_cells: acc.skipped_cells + length(cells)}
    end
  end

  # ----- how big the next pause's batch is, per rule -----
  #   integer         fixed cells per pause
  #   {:budget_us, t} count until t µs have passed inside the pause (clock per cell)
  #   {:ewma, t}      pt-table-checksum: predict cells = t / smoothed µs-per-cell
  #   {:aimd, t}      last batch over t µs → halve it; otherwise one more cell
  #   :self_tune      cells = smoothed stop-the-writers cost / smoothed µs-per-cell
  #                   (counting time ≈ the pause's fixed cost: minimizes total
  #                   writer waiting under the fixed-overhead model)
  # Learned state lives in the recounting process and carries over between
  # recounts, as a sweeper's would.
  @ewma_keep 0.75

  defp next_limit(size) when is_integer(size), do: {:count, size}
  defp next_limit({:budget_us, t}), do: {:budget, t}

  defp next_limit(rule) do
    st = Process.get({:model_batch_state, rule}, %{})

    case rule do
      {:ewma, t} -> {:count, cells_for(t, st[:per_cell])}
      # safeguarded EWMA: the prediction may at most double the last batch
      # (Percona's production lesson), and the clock still stops the pause
      # at t whatever the prediction said — every pause ≤ t + one cell
      {:safe_ewma, t} -> {:both, min(cells_for(t, st[:per_cell]), 2 * Map.get(st, :last_b, 1)), t}
      {:aimd, _t} -> {:count, Map.get(st, :b, 1)}
      :self_tune -> {:count, cells_for(st[:overhead], st[:per_cell])}
    end
  end

  defp cells_for(_budget, nil), do: 1
  defp cells_for(nil, _per_cell), do: 1
  defp cells_for(budget, per_cell), do: max(1, round(budget / per_cell))

  defp learn(rule, _n, _count_us, _acquire_us) when is_integer(rule), do: :ok
  defp learn({:budget_us, _}, _n, _count_us, _acquire_us), do: :ok

  defp learn(rule, n, count_us, acquire_us) do
    st = Process.get({:model_batch_state, rule}, %{})
    # the clock here steps in ~100 µs on Windows: never let a 0 reading
    # claim cells are free
    sample = max(count_us, 1) / n

    st =
      case rule do
        {:ewma, _} ->
          Map.put(st, :per_cell, smooth(st[:per_cell], sample))

        {:safe_ewma, _} ->
          st |> Map.put(:per_cell, smooth(st[:per_cell], sample)) |> Map.put(:last_b, n)

        {:aimd, t} ->
          b = Map.get(st, :b, 1)
          Map.put(st, :b, if(count_us > t, do: max(1, div(b, 2)), else: b + 1))

        :self_tune ->
          st
          |> Map.put(:per_cell, smooth(st[:per_cell], sample))
          |> Map.put(:overhead, smooth(st[:overhead], max(acquire_us, 1)))
      end

    Process.put({:model_batch_state, rule}, st)
  end

  defp smooth(nil, x), do: x / 1
  defp smooth(old, x), do: @ewma_keep * old + (1 - @ewma_keep) * x

  # inside the pause: count cells until the limit is reached
  defp take_batch(m, cells, limit) do
    start = System.monotonic_time(:microsecond)

    full? =
      case limit do
        {:budget, budget} ->
          fn n -> System.monotonic_time(:microsecond) - start >= budget and n > 0 end

        {:count, size} ->
          fn n -> n >= size end

        {:both, size, budget} ->
          fn n ->
            n >= size or (n > 0 and System.monotonic_time(:microsecond) - start >= budget)
          end
      end

    {rows, rest} = take_batch(m, cells, [], 0, full?)
    {rows, rest, System.monotonic_time(:microsecond) - start}
  end

  defp take_batch(_m, [], rows, _n, _full?), do: {rows, []}

  defp take_batch(m, [c | rest] = cells, rows, n, full?) do
    if full?.(n) do
      {rows, cells}
    else
      row =
        {c, :ets.select_count(m.members, [{{{c, :_}}, [], [true]}]),
         :ets.lookup_element(m.agg, c, 2, nil)}

      take_batch(m, rest, [row | rows], n + 1, full?)
    end
  end

  defp pause_recount(m) do
    case with_writers_held(m, fn held? ->
           {live, orphans} =
             m.parents
             |> :ets.tab2list()
             |> Enum.split_with(fn {u, _} -> :ets.member(m.present, u) end)

           if held?.(), do: Enum.each(orphans, &:ets.delete_object(m.parents, &1))
           {live, :ets.tab2list(m.agg)}
         end) do
      {:ok, {live, agg}} ->
        healed = heal(m, tally(Enum.map(live, &elem(&1, 1))), Map.new(agg), MapSet.new())
        %{result: :ok, healed: healed, skipped_cells: 0}

      :expired ->
        %{result: :skipped, healed: 0, skipped_cells: 0}
    end
  end

  # distinct cells in the membership table, by key jumps: {c, :end} sorts
  # after every {c, integer_id}, so next/2 lands on the next cell's first row
  defp member_cells(m), do: member_cells(m, :ets.first(m.members), [])
  defp member_cells(_m, :"$end_of_table", acc), do: acc

  defp member_cells(m, {c, _u}, acc),
    do: member_cells(m, :ets.next(m.members, {c, :end}), [c | acc])

  defp touched(nil), do: MapSet.new()
  defp touched({c, _s, nil}), do: MapSet.new(c)
  defp touched({c, _s, {:pending, old}}), do: MapSet.new(c ++ old)

  # Geo.tallies: counting in a private scratch table's update_counter
  defp tally(cell_lists) do
    scratch = :ets.new(:model_tally, [:set, :private])

    try do
      for cells <- cell_lists,
          cell <- cells,
          do: :ets.update_counter(scratch, cell, {2, 1}, {cell, 0})

      Map.new(:ets.tab2list(scratch))
    after
      :ets.delete(scratch)
    end
  end

  # Geo.heal_cells: per-cell CAS against what was read. Stamped rows CAS on
  # the version (ABA-proof); plain rows on the value — sound there because
  # their expected counts come from a consistent (paused) read, so a value
  # back where it was means the truth is back where it was too.
  defp heal(m, expected, actual, skip) do
    for cell <- Enum.uniq(Map.keys(expected) ++ Map.keys(actual)),
        not MapSet.member?(skip, cell),
        reduce: 0 do
      n ->
        want = Map.get(expected, cell, 0)

        case Map.get(actual, cell) do
          ^want ->
            n

          {^want, _ver} ->
            n

          nil when want == 0 ->
            n

          {had, ver} ->
            replaced =
              :ets.select_replace(m.agg, [
                {{cell, had, ver}, [], [{:const, {cell, want, ver + 1}}]}
              ])

            n + replaced

          nil ->
            row = if stamped?(m), do: {cell, want, 1}, else: {cell, want}
            if :ets.insert_new(m.agg, row), do: n + 1, else: n

          # an emptied cell's row dies (as Geo's settle does), atomically
          had when want == 0 ->
            n + :ets.select_delete(m.agg, [{{cell, had}, [], [true]}])

          had ->
            n + :ets.select_replace(m.agg, [{{cell, had}, [], [{:const, {cell, want}}]}])
        end
    end
  end

  # Geo.with_writers_held, verbatim in logic
  defp with_writers_held(m, fun) do
    shards = shard_pids(m)
    token = make_ref()
    deadline = System.monotonic_time(:millisecond) + @max_pause_ms
    hold = {:hold, self(), token, @max_pause_ms}

    # with m.prio the hold jumps each shard's mailbox queue (a priority
    # message is placed before every ordinary one already waiting)
    Enum.each(shards, fn shard ->
      case m.prio and :ets.lookup(m.aliases, shard) do
        [{_, prio_alias}] -> :erlang.send(prio_alias, hold, [:priority])
        _ -> send(shard, hold)
      end
    end)

    held? = fn -> System.monotonic_time(:millisecond) < deadline and shard_pids(m) == shards end

    t0 = System.monotonic_time(:microsecond)

    try do
      if await_held(shards, token, deadline) do
        # the pause's fixed cost: every writer finishing its current op
        Process.put(:model_last_acquire_us, System.monotonic_time(:microsecond) - t0)
        result = fun.(held?)
        if held?.(), do: {:ok, result}, else: :expired
      else
        :expired
      end
    after
      Enum.each(shards, &send(&1, {:release, token}))
      # how long writers could have been stalled: hold sent → release sent
      Process.put(:model_last_pause_us, System.monotonic_time(:microsecond) - t0)
    end
  end

  defp await_held([], _token, _deadline), do: true

  defp await_held(waiting, token, deadline) do
    receive do
      {:held, ^token, pid} -> await_held(List.delete(waiting, pid), token, deadline)
    after
      max(deadline - System.monotonic_time(:millisecond), 0) -> false
    end
  end

  # ===== truth, for assertions =====

  @doc "Counts implied by the parents rows of users on the map (all must be stable)."
  def truth(m) do
    cells =
      for row <- :ets.tab2list(m.parents), :ets.member(m.present, elem(row, 0)) do
        case row do
          {_u, c} -> c
          {_u, c, _s, nil} -> c
          {u, _c, _s, p} -> raise "user #{u} still mid-update: #{inspect(p)}"
        end
      end

    tally(cells)
  end

  @doc "The counts as cell => n (zero rows, which stamped modes keep, left out)."
  def counts(m) do
    for row <- :ets.tab2list(m.agg), elem(row, 1) > 0, into: %{}, do: {elem(row, 0), elem(row, 1)}
  end

  @doc "Test/bench corruption: force a cell's count, bumping its version if stamped."
  def plant(m, cell, n) do
    case :ets.lookup(m.agg, cell) do
      [{_, _, v}] -> :ets.insert(m.agg, {cell, n, v + 1})
      _ -> :ets.insert(m.agg, if(stamped?(m), do: {cell, n, 1}, else: {cell, n}))
    end
  end

  def bump(m, cell, k) do
    if stamped?(m),
      do: :ets.update_counter(m.agg, cell, [{2, k}, {3, 1}], {cell, 0, 0}),
      else: :ets.update_counter(m.agg, cell, {2, k}, {cell, 0})
  end
end
