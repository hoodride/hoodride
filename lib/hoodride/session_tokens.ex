defmodule Hoodride.SessionTokens do
  @moduledoc """
  Who is signed in, on which device — Phoenix's own design (phx.gen.auth
  session tokens), adapted (owner, 2026-11-08):

    * signing in makes a RANDOM token (32 bytes); the session cookie holds
      it, the `user_tokens` table only its SHA-256 (a copy of the table
      can't sign anyone in). One row per signed-in device;
    * a token is valid 30 days; while the app is in use it is REPLACED by a
      new one once it is a week old (`rotate/1`, as the standard's reissue)
      — so you're signed out only after 30 days without opening the app,
      and a stolen copy of an old cookie stops working within 30 days even
      while you keep using the app. The old token simply expires;
    * at most a YEAR after you really signed in (`authenticated_at`, carried
      over to each replacement): then once more "Sign in with Google";
    * signing out deletes EVERY token of the account (Hood Ride's sign-out is
      "on all your devices"); deleting the account deletes them with it.

  Read from MEMORY (`:session_tokens`, loaded before the web server starts,
  as Hoodride.SignOuts): no database read per request — the capacity test's
  thousands of connects at once ran the pool dry. Every change writes the
  DATABASE FIRST, then memory, and takes the account's lock (`:global.trans`
  on this one node), so two changes of one account never interleave: a
  replacement can't slip in between a sign-out's database step and its
  memory step and bring a signed-out session back. The changes run in the
  caller (no extra process to crash or fall behind).

  Before this, a sign-in was a signed cookie with its sign-in time, checked
  against a list of sign-out times; a connection pass made DURING a sign-out
  carried a later time and stayed valid for a day (server review,
  2026-11-08). A pass now names its token, which the sign-out deletes.
  """
  import Ecto.Query

  alias Hoodride.Repo

  @table :session_tokens
  @day 86_400_000
  @valid_ms 30 * @day
  @rotate_after_ms 7 * @day
  @cap_ms 365 * @day

  def init_table do
    Hoodride.ETS.new(@table, [:named_table, :public, :set, read_concurrency: true])
    :ok
  end

  @doc "The token's stored form (SHA-256)."
  def hash(raw) when is_binary(raw), do: :crypto.hash(:sha256, raw)

  # ---------- reads (memory only) ----------

  @doc """
  The token behind a session cookie: `{:ok, info}` while valid (30 days from
  its making, a year from the real sign-in), else `:error`. `info` =
  `%{user_id, hash, inserted_at, authenticated_at}`.
  """
  def lookup(raw, now \\ now()),
    do: if(is_binary(raw), do: lookup_hash(hash(raw), now), else: :error)

  @doc "The same, by the stored form (a connection pass carries only that)."
  def lookup_hash(hash, now \\ now())

  def lookup_hash(hash, now) when is_binary(hash) do
    case :ets.lookup(@table, hash) do
      [{^hash, user_id, inserted_at, authenticated_at}] ->
        if valid?(inserted_at, authenticated_at, now),
          do:
            {:ok,
             %{
               user_id: user_id,
               hash: hash,
               inserted_at: inserted_at,
               authenticated_at: authenticated_at
             }},
          else: :error

      [] ->
        :error
    end
  end

  def lookup_hash(_, _now), do: :error

  @doc "Is this token a week old (time to replace it — `rotate/1`)?"
  def due?(%{inserted_at: at}, now \\ now()), do: now - at >= @rotate_after_ms

  defp valid?(inserted_at, authenticated_at, now),
    do: now - inserted_at <= @valid_ms and now - authenticated_at <= @cap_ms

  # ---------- changes (the account's lock; database first, then memory) ----------

  @doc """
  Sign in: a new token for `user_id` — `{:ok, raw}` or `{:error, :unavailable}`.
  `previous` (the browser's last token, if any) is deleted when it is the
  same account's: signing in again (the silent Google refresh does, on every
  return to the app) never piles up rows.
  """
  def create(user_id, previous \\ nil) do
    now = now()

    locked(user_id, fn ->
      raw = :crypto.strong_rand_bytes(32)
      h = hash(raw)
      old = previous_of(user_id, previous)

      Repo.transaction(fn ->
        if old, do: from(t in "user_tokens", where: t.token_hash == ^old) |> Repo.delete_all()
        insert!(user_id, h, now, now)
        prune_rows(now)
      end)

      if old, do: :ets.delete(@table, old)
      :ets.insert(@table, {h, user_id, now, now})
      {:ok, raw}
    end)
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error, Ecto.ConstraintError] ->
      {:error, :unavailable}
  end

  defp previous_of(user_id, previous) do
    with true <- is_binary(previous),
         h = hash(previous),
         [{^h, ^user_id, _, _}] <- :ets.lookup(@table, h),
         do: h,
         else: (_ -> nil)
  end

  @doc """
  Replace a week-old token (the standard's reissue): `{:ok, new_raw}`, or
  `:error` — the old token is gone (signed out meanwhile: nothing is made),
  or the database couldn't (the old one simply stays in use). The real
  sign-in time carries over; the old token expires on its own.
  """
  def rotate(raw) when is_binary(raw) do
    now = now()
    old = hash(raw)

    case :ets.lookup(@table, old) do
      [{^old, user_id, _, _}] ->
        locked(user_id, fn ->
          # re-checked INSIDE the lock: a sign-out may have just run
          with [{^old, ^user_id, ins, auth}] <- :ets.lookup(@table, old),
               true <- valid?(ins, auth, now) do
            new_raw = :crypto.strong_rand_bytes(32)
            h = hash(new_raw)
            insert!(user_id, h, now, auth)
            # (tests: a pause here, between the database and memory — the
            # moment a sign-out must not slip into; nil in production)
            if hook = Application.get_env(:hoodride, :session_tokens_hook), do: hook.(:rotate)
            :ets.insert(@table, {h, user_id, now, auth})
            {:ok, new_raw}
          else
            _ -> :error
          end
        end)

      [] ->
        :error
    end
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error, Ecto.ConstraintError] -> :error
  end

  def rotate(_), do: :error

  @doc """
  Sign out everywhere: every token of the account deleted — together with
  `also.(at)` (the account's other sign-out records) in ONE transaction, the
  time `at` taken inside the lock. `{:ok, at}`, or `{:error, :failed}` when
  the database couldn't: then NOTHING changed (never half signed out).
  """
  def revoke_all(user_id, also \\ fn _at -> :ok end) do
    locked(user_id, fn ->
      at = now()

      Repo.transaction(fn ->
        from(t in "user_tokens", where: t.user_id == ^user_id) |> Repo.delete_all()
        also.(at)
      end)

      forget_now(user_id)
      {:ok, at}
    end)
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :failed}
  end

  @doc """
  After the account's row was deleted (its tokens went with it, the
  database's cascade): drop them from memory too — under the account's lock,
  so a replacement made just before can't outlive it.
  """
  def forget(user_id), do: locked(user_id, fn -> forget_now(user_id) end)

  defp forget_now(user_id) do
    :ets.select_delete(@table, [{{:_, user_id, :_, :_}, [], [true]}])
    :ok
  end

  @doc "Drop expired tokens from memory (the Sweeper, every tick)."
  def sweep(now \\ now()) do
    :ets.select_delete(@table, [
      {{:_, :_, :"$1", :"$2"},
       [{:orelse, {:<, :"$1", now - @valid_ms}, {:<, :"$2", now - @cap_ms}}], [true]}
    ])

    :ok
  end

  @doc "Refill memory from the database (start-up): the valid tokens; expired rows deleted."
  def load(now \\ now()) do
    prune_rows(now)

    from(t in "user_tokens",
      select: {t.token_hash, t.user_id, t.inserted_at, t.authenticated_at}
    )
    |> Repo.all()
    |> Enum.each(&:ets.insert(@table, &1))

    :ok
  end

  # the TABLE is trimmed by code that already writes it (each sign-in) and
  # at start-up, so the Sweeper stays memory-only (as Hoodride.SignOuts)
  defp prune_rows(now) do
    from(t in "user_tokens",
      where: t.inserted_at < ^(now - @valid_ms) or t.authenticated_at < ^(now - @cap_ms)
    )
    |> Repo.delete_all()
  end

  defp insert!(user_id, h, inserted_at, authenticated_at) do
    Repo.insert_all("user_tokens", [
      %{
        user_id: user_id,
        token_hash: h,
        context: "session",
        inserted_at: inserted_at,
        authenticated_at: authenticated_at
      }
    ])
  end

  # one change of an account at a time (this node only: one server)
  defp locked(user_id, fun), do: :global.trans({{__MODULE__, user_id}, self()}, fun, [node()])

  defp now, do: System.system_time(:millisecond)

  # the start-up step: load, then step aside (as Hoodride.SignOuts)
  @doc false
  def child_spec(_),
    do: %{id: __MODULE__, start: {__MODULE__, :start_link, []}, restart: :transient}

  @doc false
  def start_link do
    :ok = load()
    :ignore
  end
end
