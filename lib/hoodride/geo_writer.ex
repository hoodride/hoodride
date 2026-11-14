defmodule Hoodride.GeoWriter do
  @moduledoc """
  The single writer: every multi-table geo mutation is serialized through this
  process, which makes the cross-table invariants atomic — two tabs of one
  account can no longer interleave their car/hand/ride checks. Reads stay
  direct-ETS and fully parallel.

  Cost: each op is a few microseconds of ETS work, so one core sustains on the
  order of 10^5 ops/s; at 1,000 drivers broadcasting every 1.5s the writer is
  ~99% idle. If city scale ever arrives, shard this process by user-id hash.

  The sweeper's reconcilers stay on duty behind this: the writer prevents the
  geo-internal races, the heals repair anything that bends through other doors
  (request-vs-geo edges, crashes, bugs). Belt and gate. The hex-count recount
  pauses every shard between ops (the :hold message) so it reads a world with
  no write in flight.

  SHARDED via PartitionSupervisor: N writers (one per scheduler), routed by
  user id — the same user always lands on the same shard, so same-account
  ops stay strictly serialized (the only atomicity the races ever needed),
  while different users spread across cores. Raising capacity is raising N.
  """
  use GenServer
  require Logger

  def start_link(_), do: GenServer.start_link(__MODULE__, nil)

  @impl true
  def init(_) do
    # a priority alias (OTP 28+, EEP 76): the recount's holds, sent through
    # it with :priority, skip ahead of every queued update
    :ets.insert(:geo_writer_aliases, {self(), :erlang.alias([:priority])})
    # a writer this one replaces left its row behind: gone (one row per
    # writer — a handful — so a plain walk; Hoodride.HardeningTest)
    for {pid, _} <- :ets.tab2list(:geo_writer_aliases),
        not Process.alive?(pid),
        do: :ets.delete(:geo_writer_aliases, pid)

    {:ok, nil}
  end

  @doc """
  Run `op` in `key`'s writer and wait for it — at most `timeout` ms. Past
  that (the server overloaded: the capacity test's 6,000 on 4 cores), the
  caller CARRIES ON: `{:error, :timeout}` instead of the exit GenServer.call
  raises, which crashed user channels and would have stopped a ride from
  starting. Nothing is lost: the request was already in the writer's queue
  (OTP gen.erl sends, then waits) and lands when the writer catches up — in
  order, one writer per key. Since OTP 24 a late reply never reaches the
  caller (process aliases). Every reply is `:ok`; no caller needs it.
  No retries (a second copy) and no deadlines (a late "lower ✋" must still
  happen). A writer that's gone: `{:error, :unavailable}`; an op that
  failed inside it: `{:error, :failed}` (2026-11-13) — never a caller crash.
  """
  def exec(key, op, timeout \\ nil),
    do: call({:via, PartitionSupervisor, {Hoodride.GeoWriters, key}}, op, timeout || wait())

  @short_wait :hoodride_geo_short_wait

  # how long a caller waits: inside short_waits/2 its own budget, else
  # :geo_call_timeout (5 s)
  defp wait,
    do: Process.get(@short_wait) || Application.get_env(:hoodride, :geo_call_timeout, 5_000)

  @doc """
  Run `fun` with this process's writer waits (those not given a time of
  their own) at most `ms` — and once one has run out, none at all for the
  rest of `fun`: the writers are backed up, so waiting on each in turn only
  stalls the caller (the cleanup pass waited ~5 s per stale car: 100 of
  them, 8 minutes — Hoodride.SweeperStallTest). Nothing is lost: each
  change is already queued and lands in order. Only this process, only
  for `fun`.
  """
  def short_waits(ms, fun) do
    previous = Process.put(@short_wait, ms)

    try do
      fun.()
    after
      if previous, do: Process.put(@short_wait, previous), else: Process.delete(@short_wait)
    end
  end

  @doc false
  def call(writer, op, timeout) do
    GenServer.call(writer, op, timeout)
  catch
    :exit, {:timeout, _} ->
      # inside short_waits: the writers are backed up — stop waiting on them
      if Process.get(@short_wait), do: Process.put(@short_wait, 0)
      {:error, :timeout}

    # the writer gone (crashed, restarting): the caller carries on — never
    # crashing with it (owner, 2026-11-13; Hoodride.HardeningTest)
    :exit, _ ->
      {:error, :unavailable}
  end

  # Each op runs on its own: one that fails (a bug — no known input does)
  # is logged and answered {:error, :failed}; the writer keeps running, so
  # its other callers' ops still land and repeated failures can't add up to
  # a supervisor giving up (owner, 2026-11-13, crash hardening;
  # Hoodride.HardeningTest). What a failed op left half-done, the sweeper's
  # reconcilers repair, as for any other bend.
  @impl true
  def handle_call(op, _from, s) do
    {:reply, run(op), s}
  rescue
    e ->
      Logger.error("map update failed: #{op_name(op)}: #{inspect(e.__struct__)}")
      {:reply, {:error, :failed}, s}
  catch
    kind, _reason ->
      Logger.error("map update failed: #{op_name(op)}: #{kind}")
      {:reply, {:error, :failed}, s}
  end

  # only the op's name and the error's KIND are logged: an error's message
  # can quote the person's record (a name)
  defp op_name(op) when is_tuple(op) and tuple_size(op) > 0 and is_atom(elem(op, 0)),
    do: elem(op, 0)

  defp op_name(_), do: :unknown

  defp run({:driver_update, user, cell, spot, parents}) do
    # race-proof twin of the channel's mid-ride guard: this check runs INSIDE
    # the serialized section, so it sees any ride start that already landed
    if Hoodride.Rides.ride_id_of_user(user.id) == nil do
      Hoodride.Geo.driver_update_now(user, cell, spot, parents)
    end

    :ok
  end

  defp run({:hand_up, user_id, cell, spot, parents}) do
    if Hoodride.Rides.ride_id_of_user(user_id) == nil do
      Hoodride.Geo.hand_up_now(user_id, cell, spot, parents)
    end

    :ok
  end

  defp run({:driver_offline, user_id}) do
    Hoodride.Geo.driver_offline_now(user_id)
    :ok
  end

  defp run({:hand_down, user_id}) do
    Hoodride.Geo.hand_down_now(user_id)
    :ok
  end

  defp run({:reindex, user_id}) do
    Hoodride.Geo.reindex_user_now(user_id)
    :ok
  end

  defp run({:prune_orphan, user_id}) do
    Hoodride.Geo.prune_orphan_now(user_id)
    :ok
  end

  defp run({:rebuild_members, user_id}) do
    Hoodride.Geo.rebuild_members_now(user_id)
    :ok
  end

  # The recount's pause (Geo.with_writers_held). A message, so it is only
  # ever handled BETWEEN ops: the op before it has fully finished, the ops
  # after it wait in the mailbox. Ends on release, on the holder's death,
  # or at max_ms — a crashed or wedged holder can never freeze the map.
  @impl true
  def handle_info({:hold, holder, token, max_ms}, s) do
    mref = Process.monitor(holder)
    send(holder, {:held, token, self()})

    receive do
      {:release, ^token} -> :ok
      {:DOWN, ^mref, :process, _, _} -> :ok
    after
      max_ms -> :ok
    end

    Process.demonitor(mref, [:flush])
    {:noreply, s}
  end

  # a release that arrives after this shard already timed out of its hold
  def handle_info({:release, _token}, s), do: {:noreply, s}

  # anything else (nothing known sends one): ignored, never a crash
  def handle_info(_other, s), do: {:noreply, s}
end
