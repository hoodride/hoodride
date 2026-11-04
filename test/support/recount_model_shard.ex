defmodule Hoodride.RecountModel.Shard do
  @moduledoc """
  One writer shard of Hoodride.RecountModel — the model of a GeoWriter shard.
  Same serialization (one op at a time), same pause protocol ({:hold, ...}
  handled between ops), same two-table update as Hoodride.Geo.
  """
  use GenServer

  alias Hoodride.RecountModel, as: M

  def start_link(args), do: GenServer.start_link(__MODULE__, args)

  @impl true
  def init(args) do
    m = Keyword.fetch!(args, :model)
    partition = Keyword.fetch!(args, :partition)

    # :versioned/:hybrid crash recovery — this shard is the ONLY writer of its users'
    # rows, so on (re)start it settles any row it left mid-update: the row's
    # new cells become the truth (whether or not the count shift landed —
    # the next recount sees a stable row and heals the counts either way)
    if m.mode != :pause do
      for {u, cells, _stamp, {:pending, _old}} <- :ets.tab2list(m.parents),
          rem(u, m.shards) == partition do
        :ets.insert(m.parents, {u, cells, M.stamp(), nil})
      end
    end

    if m.mode == :batched, do: M.rebuild_members_now(m, partition)

    # a priority alias (OTP 28+, EEP 76): holds sent through it with the
    # :priority option skip ahead of every queued update
    :ets.insert(m.aliases, {self(), :erlang.alias([:priority])})

    {:ok, m}
  end

  @impl true
  def handle_call({:update, u, cells}, _from, m) do
    M.update_now(m, u, cells)
    {:reply, :ok, m}
  end

  def handle_call({:offline, u}, _from, m) do
    M.offline_now(m, u)
    {:reply, :ok, m}
  end

  # test hook: do the first write of an update, report, wait to be told to
  # finish — a writer caught mid-op, deterministically
  def handle_call({:update_paused_mid_op, u, cells, notify}, _from, m) do
    M.update_now(m, u, cells, fn ->
      send(notify, {:mid_op, self()})
      receive do: (:continue -> :ok)
    end)

    {:reply, :ok, m}
  end

  # test hook: crash between the parents write and the count shift — the
  # residue the recount exists to heal
  def handle_call({:crash_mid_update, u, cells}, _from, m) do
    M.update_now(m, u, cells, fn -> exit(:crash_mid_update) end)
    {:reply, :ok, m}
  end

  @impl true
  def handle_cast({:prune_orphan, row}, m) do
    M.prune_orphan_now(m, row)
    {:noreply, m}
  end

  # the :pause strategy's hold — identical to Hoodride.GeoWriter's
  @impl true
  def handle_info({:hold, holder, token, max_ms}, m) do
    mref = Process.monitor(holder)
    send(holder, {:held, token, self()})

    receive do
      {:release, ^token} -> :ok
      {:DOWN, ^mref, :process, _, _} -> :ok
    after
      max_ms -> :ok
    end

    Process.demonitor(mref, [:flush])
    {:noreply, m}
  end

  def handle_info({:release, _token}, m), do: {:noreply, m}

  # benchmark switch: run this writer at another scheduling priority
  # (:normal | :high) — high-priority processes are scheduled ahead of
  # normal ones on every scheduler
  def handle_info({:set_priority, level}, m) do
    Process.flag(:priority, level)
    {:noreply, m}
  end
end
