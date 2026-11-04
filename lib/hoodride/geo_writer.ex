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

  def start_link(_), do: GenServer.start_link(__MODULE__, nil)

  @impl true
  def init(_) do
    # a priority alias (OTP 28+, EEP 76): the recount's holds, sent through
    # it with :priority, skip ahead of every queued update
    :ets.insert(:geo_writer_aliases, {self(), :erlang.alias([:priority])})
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
  happen). Other exits (a writer that's gone) still raise: a real fault.
  """
  def exec(key, op, timeout \\ Application.get_env(:hoodride, :geo_call_timeout, 5_000)),
    do: call({:via, PartitionSupervisor, {Hoodride.GeoWriters, key}}, op, timeout)

  @doc false
  def call(writer, op, timeout) do
    GenServer.call(writer, op, timeout)
  catch
    :exit, {:timeout, _} -> {:error, :timeout}
  end

  @impl true
  def handle_call({:driver_update, user, cell, spot, parents}, _from, s) do
    # race-proof twin of the channel's mid-ride guard: this check runs INSIDE
    # the serialized section, so it sees any ride start that already landed
    if Hoodride.Rides.ride_id_of_user(user.id) == nil do
      Hoodride.Geo.driver_update_now(user, cell, spot, parents)
    end

    {:reply, :ok, s}
  end

  def handle_call({:hand_up, user_id, cell, spot, parents}, _from, s) do
    if Hoodride.Rides.ride_id_of_user(user_id) == nil do
      Hoodride.Geo.hand_up_now(user_id, cell, spot, parents)
    end

    {:reply, :ok, s}
  end

  def handle_call({:driver_offline, user_id}, _from, s) do
    Hoodride.Geo.driver_offline_now(user_id)
    {:reply, :ok, s}
  end

  def handle_call({:hand_down, user_id}, _from, s) do
    Hoodride.Geo.hand_down_now(user_id)
    {:reply, :ok, s}
  end

  def handle_call({:reindex, user_id}, _from, s) do
    Hoodride.Geo.reindex_user_now(user_id)
    {:reply, :ok, s}
  end

  def handle_call({:prune_orphan, user_id}, _from, s) do
    Hoodride.Geo.prune_orphan_now(user_id)
    {:reply, :ok, s}
  end

  def handle_call({:rebuild_members, user_id}, _from, s) do
    Hoodride.Geo.rebuild_members_now(user_id)
    {:reply, :ok, s}
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
end
