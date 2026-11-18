defmodule Hoodride.Blocks do
  @moduledoc """
  Blocks (owner, 2026-11-15). Ann blocks Bob: EITHER WAY the two don't see
  each other on the map and can't message or ask each other for a ride;
  their chat, any request between them and a ride together end (the block
  itself: HoodrideWeb.UserChannel). Bob isn't told — every refusal is the
  ordinary "can't reach them".

  THE DATABASE IS THE RECORD (`blocks`): a block survives a restart, until
  the one who blocked unblocks, or either account is deleted (the
  database's cascade). Only who and when.

  MEMORY HOLDS THE BLOCKS OF PEOPLE IN USE — "cache-aside": a person's rows
  (theirs and the ones naming them) are read from the database the first
  time they're needed and dropped once they're GONE by the app's own
  presence (the Sweeper): not connected, past the grace a leaver gets
  (`Limits.presence_grace_ms` — the one their car, ✋ and chats get), and
  in no ride or request. A person who comes back is read again. Checked on every map update a viewer receives, so it must be a
  memory lookup; but memory grows with who's in use, not with every block
  ever made. A person NOT in memory is never "not blocked": their rows are
  read first. The database unable to answer: blocked (closed, not open) —
  for that moment nobody unknown is shown or reached.

  Every change takes both people's locks (as Hoodride.SessionTokens): the
  database first, then memory. A load takes the person's lock too, so a
  block can't slip in between a load's database read and its memory write
  (BlocksTest "a load and a block at the same moment").

  At most `Limits.blocks_per_person` blocked people each; at most
  `Limits.block_actions_per_day` blocks or unblocks a day, together
  (Hoodride.Throttle) — a refusal costs nothing.
  """
  import Ecto.Query
  require Logger

  alias Hoodride.{Repo, Throttle}

  # {{user_id, other_id}}: either blocked the other (one row per person in
  # memory: each side has its own)
  @rows :block_rows
  # {user_id}: this person's rows are in memory
  @loaded :block_loaded
  @cap Hoodride.Limits.blocks_per_person()

  def init_table do
    # (one call per table: Hoodride.EtsTablesTest counts them)
    Hoodride.ETS.new(@rows, [:named_table, :public, :set, read_concurrency: true])
    Hoodride.ETS.new(@loaded, [:named_table, :public, :set, read_concurrency: true])
    :ok
  end

  # ---------- the check (every map update, message, request) ----------

  @doc "Did either block the other? Never false for someone not in memory: read first."
  def blocked?(a, b) when a == b, do: false

  def blocked?(a, b), do: check(a, b) != false

  @doc """
  The same, telling the database being unable to answer apart: `true`,
  `false`, or `:unknown` (treated as blocked; the map channel tries again
  and sends what it held back — HoodrideWeb.WorldChannel).
  """
  def check(a, b) when a == b, do: false

  def check(a, b) when is_integer(a) and is_integer(b), do: check_loaded(a, b, 3)
  def check(_a, _b), do: false

  # "loaded?", the read, then "STILL loaded?" (owner, 2026-11-17): the
  # Sweeper may drop `a` in between — it takes the mark first, then the
  # rows (drop/1), so a read that could have missed a row always finds the
  # mark gone after it: read again from the database. Without this, a
  # check caught mid-drop answered "not blocked" — a blocked car shown.
  # Dropped three times running (never seen): :unknown — treated as blocked
  defp check_loaded(_a, _b, 0), do: :unknown

  defp check_loaded(a, b, tries) do
    case ensure(a) do
      :ok ->
        # (tests: a pause between "loaded" and the read)
        hook(:checked)
        blocked = :ets.member(@rows, {a, b})
        if loaded?(a), do: blocked, else: check_loaded(a, b, tries - 1)

      :unavailable ->
        :unknown
    end
  end

  @doc "This person's blocks into memory now (a map joining): `:ok` or `:unavailable`."
  def preload(user_id) when is_integer(user_id), do: ensure(user_id)

  @doc false
  def loaded?(user_id), do: :ets.member(@loaded, user_id)

  defp ensure(user_id), do: if(loaded?(user_id), do: :ok, else: load(user_id))

  # under the person's lock: a change can't land between the read and the write
  defp load(user_id) do
    locked([user_id], fn ->
      if loaded?(user_id) do
        :ok
      else
        hook(:read)

        others =
          from(b in "blocks",
            where: b.blocker_id == ^user_id or b.blocked_id == ^user_id,
            select: {b.blocker_id, b.blocked_id}
          )
          |> Repo.all()
          |> Enum.map(fn {x, y} -> if x == user_id, do: y, else: x end)

        hook(:loaded)
        :ets.insert(@rows, for(o <- others, do: {{user_id, o}}))
        :ets.insert(@loaded, {user_id})
        :ok
      end
    end)
  rescue
    e ->
      if Repo.down?(e) do
        Logger.warning(
          "blocks: couldn't read #{user_id}'s from the database — treated as blocked for now"
        )

        :unavailable
      else
        reraise(e, __STACKTRACE__)
      end
  end

  @doc false
  # The warm start (Hoodride.WarmStart): many people's blocks in ONE query,
  # as load/1 for each — both directions, then the mark (someone with none
  # is known to have none). Start-up only, before the Sweeper and the web
  # server: nothing else reads or changes blocks yet, so no locks. Anyone
  # already in memory is left as is. Raises if the database can't answer.
  def preload_many(ids) do
    case Enum.reject(ids, &loaded?/1) do
      [] ->
        :ok

      ids ->
        hook(:read)
        set = MapSet.new(ids)

        rows =
          from(b in "blocks",
            where: b.blocker_id in ^ids or b.blocked_id in ^ids,
            select: {b.blocker_id, b.blocked_id}
          )
          |> Repo.all()

        entries =
          Enum.flat_map(rows, fn {x, y} ->
            if(MapSet.member?(set, x), do: [{{x, y}}], else: []) ++
              if(MapSet.member?(set, y), do: [{{y, x}}], else: [])
          end)

        :ets.insert(@rows, entries)
        :ets.insert(@loaded, for(id <- ids, do: {id}))
        :ok
    end
  end

  # ---------- changes ----------

  @doc """
  `me` blocks `other`: `:ok` (also when already blocked), or `{:error,
  :self | :none | :full | :rate_limited | :failed}` — nothing changed.
  """
  def block(me, other) when is_integer(me) and is_integer(other) do
    cond do
      me == other -> {:error, :self}
      not exists?(other) -> {:error, :none}
      true -> with_allowance(me, fn -> do_block(me, other) end)
    end
  end

  def block(_me, _other), do: {:error, :none}

  defp do_block(me, other) do
    locked([me, other], fn ->
      cond do
        row?(me, other) ->
          # already blocked: nothing done, nothing spent
          :again

        count(me) >= @cap ->
          {:error, :full}

        true ->
          Repo.insert_all("blocks", [%{blocker_id: me, blocked_id: other, inserted_at: now()}],
            on_conflict: :nothing
          )

          hook(:inserted)

          if loaded?(me), do: :ets.insert(@rows, {{me, other}})
          if loaded?(other), do: :ets.insert(@rows, {{other, me}})
          :ok
      end
    end)
  end

  @doc """
  `me` unblocks `other` (only the one who blocked can): `:ok`, or
  `{:error, :self | :none | :rate_limited | :failed}`. If `other` blocked
  `me` too, that block stays.
  """
  def unblock(me, other) when is_integer(me) and is_integer(other) do
    if me == other, do: {:error, :self}, else: with_allowance(me, fn -> do_unblock(me, other) end)
  end

  def unblock(_me, _other), do: {:error, :none}

  defp do_unblock(me, other) do
    locked([me, other], fn ->
      {n, _} =
        from(b in "blocks", where: b.blocker_id == ^me and b.blocked_id == ^other)
        |> Repo.delete_all()

      cond do
        n == 0 ->
          {:error, :none}

        # the other's own block stays: still blocked either way
        row?(other, me) ->
          :ok

        true ->
          :ets.delete(@rows, {me, other})
          :ets.delete(@rows, {other, me})
          :ok
      end
    end)
  end

  # one of the day's allowance taken first; given back unless something changed
  defp with_allowance(me, fun) do
    case Throttle.take_block_action(me) do
      :ok ->
        result =
          try do
            fun.()
          rescue
            e -> if Repo.down?(e), do: {:error, :failed}, else: reraise(e, __STACKTRACE__)
          end

        case result do
          :ok ->
            :ok

          :again ->
            Throttle.give_back_block_action(me)
            :ok

          error ->
            Throttle.give_back_block_action(me)
            error
        end

      {:deny, _} ->
        {:error, :rate_limited}
    end
  end

  # ---------- reads (the database: the Blocked people list, rare) ----------

  @doc "The people `me` blocked, newest first (all of them)."
  def list(me), do: page(me, nil, @cap).ids

  @doc """
  One page of the people `me` blocked, newest first (owner, 2026-11-15:
  in pages, as the chat list). `before`: `{inserted_at, row_id}` — only
  older blocks than that one; nil for the first page. → `%{ids, more}`,
  `more` the cursor of this page's last block, or nil.
  """
  def page(me, before, limit) do
    older =
      case before do
        nil -> dynamic(true)
        {at, row} -> dynamic([b], b.inserted_at < ^at or (b.inserted_at == ^at and b.id < ^row))
      end

    rows =
      from(b in "blocks",
        where: b.blocker_id == ^me,
        where: ^older,
        order_by: [desc: b.inserted_at, desc: b.id],
        limit: ^(limit + 1),
        select: {b.blocked_id, b.inserted_at, b.id}
      )
      |> Repo.all()

    {shown, rest} = Enum.split(rows, limit)

    %{
      ids: Enum.map(shown, &elem(&1, 0)),
      more:
        case {rest, List.last(shown)} do
          {[], _} -> nil
          {_, {_, at, row}} -> {at, row}
        end
    }
  end

  @doc "How many `me` blocked."
  def count(me),
    do: from(b in "blocks", where: b.blocker_id == ^me, select: count()) |> Repo.one()

  defp row?(blocker, blocked),
    do:
      from(b in "blocks", where: b.blocker_id == ^blocker and b.blocked_id == ^blocked)
      |> Repo.exists?()

  defp exists?(user_id), do: from(u in "users", where: u.id == ^user_id) |> Repo.exists?()

  # ---------- memory upkeep ----------

  @doc """
  The Sweeper: the blocks of people who are GONE leave memory — not
  connected, past the presence grace (their car, ✋ and chats go then
  too), and in no ride or request. Read again when next needed.
  `now`: seconds, the presence clock.
  """
  def sweep(now \\ System.system_time(:second)) do
    for {user_id} <- :ets.tab2list(@loaded), not Hoodride.Presence.around?(user_id, now) do
      locked([user_id], fn -> drop(user_id) end)
    end

    :ok
  end

  @doc "A deleted account: gone from memory, both sides (its rows went with it)."
  def forget(user_id) do
    locked([user_id], fn ->
      drop(user_id)
      :ets.match_delete(@rows, {{:_, user_id}})
    end)

    :ok
  end

  @doc false
  # (tests: memory as after a restart)
  def reset_memory do
    :ets.delete_all_objects(@rows)
    :ets.delete_all_objects(@loaded)
    :ok
  end

  # the mark FIRST, then the rows: a check reading meanwhile finds the mark
  # gone after its read, and reads again (check_loaded)
  defp drop(user_id) do
    :ets.delete(@loaded, user_id)
    # (tests: a pause between the two)
    hook(:dropping)
    :ets.match_delete(@rows, {{user_id, :_}})
  end

  # both people's locks, always in the same order (no deadlock)
  defp locked(ids, fun) do
    ids
    |> Enum.uniq()
    |> Enum.sort()
    |> Enum.reduce(fun, fn id, inner ->
      fn -> :global.trans({{__MODULE__, id}, self()}, inner, [node()]) end
    end)
    |> then(& &1.())
  end

  defp hook(step) do
    if f = Application.get_env(:hoodride, :blocks_hook), do: f.(step)
    :ok
  end

  defp now, do: System.system_time(:millisecond)
end
