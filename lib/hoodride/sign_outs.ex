defmodule Hoodride.SignOuts do
  @moduledoc """
  When each account last signed out — in memory, so a socket connect needs
  no database read (the capacity test: 3,000 connects at once ran the pool
  of 5 dry and about half got HTTP 500).

  Token revocation's usual answer, a DENYLIST: entries kept only while what
  they revoke could still be valid. Sessions live 30 days, socket tokens one
  (HoodrideWeb.Auth), so a sign-out older than 30 days refuses nothing that
  isn't already expired — the sweep drops it. The table holds only the last
  30 days' sign-outs: small, since most people never sign out.

  The database keeps the record in its OWN table, `sign_outs` (one row per
  account: the latest sign-out or deletion; `persist/2`). It used to be
  `users.logged_out_at` — deleted WITH the account, so after any restart a
  deleted account's leftover socket token connected again. `load/1`
  refills memory from it at start-up — a step of its own between the
  migrations and the web server, which BLOCKS until done (a background load
  would let the server accept connections before the list is there).
  Sign-out writes the database FIRST, then memory
  (Hoodride.Accounts.mark_logged_out/2): if the database can't, nothing
  changes and the person is told — never half signed out. Deleting an
  account saves its revocation in the SAME transaction that deletes the row
  (Hoodride.AccountDeletion). Rows older than 30 days go: from memory in
  the Sweeper's sweep, from the table at each write and at start-up.

  The table is created with the others in Hoodride.Application, so it lives
  as long as the app. Were it ever missing, `allowed?/3` raises and the
  connect is refused — never let in. One server: a second one would need
  this shared (ARCHITECTURE.md, scaling).
  """
  import Ecto.Query

  alias Hoodride.Repo

  @table :sign_outs
  @keep_ms 30 * 86_400_000

  def init_table do
    Hoodride.ETS.new(@table, [:named_table, :public, :set, read_concurrency: true])
    :ok
  end

  @doc "May a credential issued at `issued_at` (ms) for `user_id` be used? Strictly after a sign-out."
  def allowed?(user_id, issued_at, table \\ @table) do
    case :ets.lookup(table, user_id) do
      [] -> true
      [{_, at}] -> issued_at > at
    end
  end

  @doc "Record a sign-out; of two, the later wins (an older one never overwrites a newer)."
  def put(user_id, at_ms) do
    # insert_new or keep the max, atomically per row
    unless :ets.insert_new(@table, {user_id, at_ms}) do
      :ets.select_replace(@table, [
        {{user_id, :"$1"}, [{:<, :"$1", at_ms}], [{{user_id, at_ms}}]}
      ])
    end

    :ok
  end

  @doc """
  Save a revocation in the database (`sign_outs`): one row per account, and
  of two the later wins — an older one never overwrites a newer. Raises if
  the database can't (callers decide: deletion rolls back; sign-out has
  already refused in memory).
  """
  def persist(user_id, at_ms, now \\ System.system_time(:millisecond)) do
    Repo.insert_all(
      "sign_outs",
      [%{user_id: user_id, at: at_ms}],
      conflict_target: [:user_id],
      on_conflict:
        from(s in "sign_outs", update: [set: [at: fragment("MAX(?, excluded.at)", s.at)]])
    )

    prune_rows(now)
    :ok
  end

  @doc "Refill from the database: the sign-outs of the last 30 days (older rows are dropped)."
  def load(now \\ System.system_time(:millisecond)) do
    since = now - @keep_ms
    prune_rows(now)

    from(s in "sign_outs", where: s.at > ^since, select: {s.user_id, s.at})
    |> Repo.all()
    |> Enum.each(fn {id, at} -> put(id, at) end)

    :ok
  end

  @doc "Drop sign-outs older than 30 days (all they revoke has expired) from memory."
  def sweep(now \\ System.system_time(:millisecond)) do
    since = now - @keep_ms
    :ets.select_delete(@table, [{{:_, :"$1"}, [{:<, :"$1", since}], [true]}])
    :ok
  end

  # the TABLE is trimmed by the code that already uses the database — each
  # write (rows only ever arrive with a sign-out or a deletion) and the
  # start-up load — so the Sweeper stays memory-only
  defp prune_rows(now) do
    since = now - @keep_ms
    from(s in "sign_outs", where: s.at < ^since) |> Repo.delete_all()
  end

  # the start-up step: load, then step aside (no process to keep; :transient
  # so the supervisor keeps its entry — an ignored :temporary child vanishes)
  @doc false
  def child_spec(_),
    do: %{id: __MODULE__, start: {__MODULE__, :start_link, []}, restart: :transient}

  @doc false
  def start_link do
    :ok = load()
    :ignore
  end
end
