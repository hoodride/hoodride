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
  as the app's other start-up lists): no database read per request — the capacity test's
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
  require Logger

  alias Hoodride.Repo

  @table :session_tokens
  # a replaced token → its replacement: {old_hash, new_hash, user_id}
  # (the database's `replaced_by`)
  @links :session_token_links
  # replacements not used yet by any request: {hash, user_id} (the
  # database's `unused`, so a restart doesn't forget a lost reply)
  @fresh :session_token_fresh
  @valid_ms Hoodride.Limits.sign_in_valid_ms()
  @rotate_after_ms Hoodride.Limits.sign_in_renew_after_ms()
  @cap_ms Hoodride.Limits.sign_in_max_age_ms()
  # the key fix (owner, 2026-11-12): at most this many sign-ins per account
  # — one device keeps ~5 over a month (its current one and the replaced
  # ones in their 30 days), so two devices never lose one
  @max_per_account Hoodride.Limits.sign_ins_per_account()
  # a replaced token may renew again only when its replacement went unused
  # this long: a phone's requests sent together all carry the old one, and
  # a second renewal among them would take back the one the phone kept
  @lost_reply_ms Hoodride.Limits.lost_reply_ms()

  def init_table do
    # (one call per table: Hoodride.EtsTablesTest counts them)
    Hoodride.ETS.new(@table, [:named_table, :public, :set, read_concurrency: true])
    Hoodride.ETS.new(@links, [:named_table, :public, :set, read_concurrency: true])
    Hoodride.ETS.new(@fresh, [:named_table, :public, :set, read_concurrency: true])
    :ok
  end

  @doc false
  def max_per_account, do: @max_per_account

  @doc """
  A request came with this token: a replacement is now in use (its reply
  arrived), never taken back by a renewal of the token it replaced.
  """
  def used(hash) when is_binary(hash) do
    # (only the first use of a replacement does anything: a lookup)
    case :ets.lookup(@fresh, hash) do
      [{^hash, user_id}] ->
        # under the account's lock: never in the middle of a renewal taking
        # it back; the database first — if it can't, it stays unused here
        # too, and the next request tries again
        locked(user_id, fn ->
          if :ets.member(@fresh, hash) do
            from(t in "user_tokens", where: t.token_hash == ^hash)
            |> Repo.update_all(set: [unused: 0])

            :ets.delete(@fresh, hash)
          end
        end)

      [] ->
        :ok
    end

    :ok
  rescue
    e -> if Hoodride.Repo.down?(e), do: :ok, else: reraise(e, __STACKTRACE__)
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

  @doc """
  Any sign-in of `user_id` left in memory? A sign-out or a deletion removes
  every one (revoke_all, forget) before it looks for a ride (A1: a ride's
  start asks this of its rider — Requests.accept).
  """
  def any?(user_id),
    do: :ets.select(@table, [{{:_, user_id, :_, :_}, [], [true]}], 1) != :"$end_of_table"

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
      # at most @max_per_account: signing in again and again without the
      # old cookie (a script) piled up a token each time (abuse review,
      # 2026-11-12)
      dropped = over_cap(user_id, 1 - if(old, do: 1, else: 0), [old])

      Repo.transaction(fn ->
        delete_rows!(Enum.reject([old | dropped], &is_nil/1))
        insert!(user_id, h, now, now)
        prune_rows(now)
      end)

      # the new one in FIRST, then the old one out: never a moment with
      # none — a ride's start asks "any sign-in left?" of its rider (any?/1,
      # A1), and a rider signing in again (the silent Google refresh) would
      # read as signed out in between (third review, 2026-11-11)
      :ets.insert(@table, {h, user_id, now, now})
      # (a test can look at the moment between the two; nil in production)
      if hook = Application.get_env(:hoodride, :session_tokens_hook), do: hook.(:replace)
      forget_hashes(Enum.reject([old | dropped], &is_nil/1))
      {:ok, raw}
    end)
  rescue
    _ in Ecto.ConstraintError -> {:error, :unavailable}
    e -> if Hoodride.Repo.down?(e), do: {:error, :unavailable}, else: reraise(e, __STACKTRACE__)
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
  already replaced (below), or the database couldn't (the old one simply
  stays in use). The real sign-in time carries over; the old token stays
  valid (requests already on their way carry it) and expires on its own.

  A token is replaced ONCE (the key fix, owner 2026-11-12): a replayed old
  cookie made a new token on every request — thousands a day, kept 30 days,
  reloaded at start-up. Again only when its replacement was never used for
  @lost_reply_ms — its reply was lost on the way (bad signal), so the
  phone still has only the old one: the unused replacement is taken back
  and a new one made (the count stays the same), as Supabase's and Auth0's
  "the token just before may renew" rule — but never taking back one a
  device is using.
  """
  def rotate(raw) when is_binary(raw) do
    now = now()
    old = hash(raw)

    case :ets.lookup(@table, old) do
      [{^old, user_id, _, _}] ->
        locked(user_id, fn ->
          # re-checked INSIDE the lock: a sign-out may have just run
          with [{^old, ^user_id, ins, auth}] <- :ets.lookup(@table, old),
               true <- valid?(ins, auth, now),
               {:ok, unused} <- renewable(old, now) do
            new_raw = :crypto.strong_rand_bytes(32)
            h = hash(new_raw)
            gone = Enum.reject([unused], &is_nil/1)
            dropped = over_cap(user_id, 1 - length(gone), [old | gone])

            Repo.transaction(fn ->
              delete_rows!(gone ++ dropped)
              insert!(user_id, h, now, auth, 1)

              from(t in "user_tokens", where: t.token_hash == ^old)
              |> Repo.update_all(set: [replaced_by: h])
            end)

            # (tests: a pause here, between the database and memory — the
            # moment a sign-out must not slip into; nil in production)
            if hook = Application.get_env(:hoodride, :session_tokens_hook), do: hook.(:rotate)
            :ets.insert(@table, {h, user_id, now, auth})
            :ets.insert(@fresh, {h, user_id})
            :ets.insert(@links, {old, h, user_id})
            forget_hashes(gone ++ dropped)
            {:ok, new_raw}
          else
            _ -> :error
          end
        end)

      [] ->
        :error
    end
  rescue
    _ in Ecto.ConstraintError -> :error
    e -> if Hoodride.Repo.down?(e), do: :error, else: reraise(e, __STACKTRACE__)
  end

  def rotate(_), do: :error

  @doc """
  Sign out everywhere: every token of the account deleted, the time `at`
  taken inside the lock. `{:ok, at}`, or `{:error, :failed}` when the
  database couldn't: then NOTHING changed (never half signed out).
  """
  def revoke_all(user_id) do
    locked(user_id, fn ->
      at = now()
      from(t in "user_tokens", where: t.user_id == ^user_id) |> Repo.delete_all()

      forget_now(user_id)
      {:ok, at}
    end)
  rescue
    e -> if Hoodride.Repo.down?(e), do: {:error, :failed}, else: reraise(e, __STACKTRACE__)
  end

  @doc """
  After the account's row was deleted (its tokens went with it, the
  database's cascade): drop them from memory too — under the account's lock,
  so a replacement made just before can't outlive it.
  """
  def forget(user_id), do: locked(user_id, fn -> forget_now(user_id) end)

  defp forget_now(user_id) do
    :ets.select_delete(@table, [{{:_, user_id, :_, :_}, [], [true]}])
    :ets.select_delete(@links, [{{:_, :_, user_id}, [], [true]}])
    :ets.select_delete(@fresh, [{{:_, user_id}, [], [true]}])
    :ok
  end

  # ---------- the key fix: replace once; at most @max_per_account ----------

  # may `old` be renewed? `{:ok, nil}`: never replaced (or its replacement
  # is gone — expired, or dropped by the cap); `{:ok, unused}`: replaced,
  # but the replacement went unused @lost_reply_ms — its reply was lost:
  # take it back, make another; else `:replaced` — a device has it
  defp renewable(old, now) do
    with [{^old, succ, _}] <- :ets.lookup(@links, old),
         [{^succ, _, made, _}] <- :ets.lookup(@table, succ) do
      if :ets.member(@fresh, succ) and now - made >= @lost_reply_ms,
        do: {:ok, succ},
        else: :replaced
    else
      _ -> {:ok, nil}
    end
  end

  # the account's tokens to drop so that, with `added` more, it holds at
  # most @max_per_account — never one in `keep`. In order: expired ones
  # (not swept yet); replacements no request ever used (their device has
  # the token they replaced — that one is kept); replaced ones (their
  # device moved on); then the oldest
  defp over_cap(user_id, added, keep) do
    now = now()
    mine = :ets.select(@table, [{{:"$1", user_id, :"$2", :"$3"}, [], [{{:"$1", :"$2", :"$3"}}]}])
    excess = length(mine) + added - @max_per_account

    if excess <= 0 do
      []
    else
      mine
      |> Enum.reject(fn {h, _, _} -> h in keep end)
      |> Enum.sort_by(fn {h, ins, auth} -> {drop_order(h, ins, auth, now), ins} end)
      |> Enum.take(excess)
      |> Enum.map(&elem(&1, 0))
    end
  end

  defp drop_order(h, ins, auth, now) do
    cond do
      not valid?(ins, auth, now) -> 0
      :ets.member(@fresh, h) -> 1
      :ets.member(@links, h) -> 2
      true -> 3
    end
  end

  defp delete_rows!([]), do: :ok

  defp delete_rows!(hashes),
    do: from(t in "user_tokens", where: t.token_hash in ^hashes) |> Repo.delete_all()

  defp forget_hashes(hashes) do
    for h <- hashes, t <- [@table, @links, @fresh], do: :ets.delete(t, h)
    :ok
  end

  @doc "Drop expired tokens from memory (the Sweeper, every tick)."
  def sweep(now \\ now()) do
    :ets.select_delete(@table, [
      {{:_, :_, :"$1", :"$2"},
       [{:orelse, {:<, :"$1", now - @valid_ms}, {:<, :"$2", now - @cap_ms}}], [true]}
    ])

    # a token gone: what was kept about it goes too
    for t <- [@links, @fresh],
        h <- :ets.select(t, [{:"$1", [], [{:element, 1, :"$1"}]}]),
        not :ets.member(@table, h),
        do: :ets.delete(t, h)

    :ok
  end

  @doc "Refill memory from the database (start-up): the valid tokens; expired rows deleted."
  def load(now \\ now()) do
    # tidying, not loading: a delete the database refuses (a full disk, a
    # lock) is logged and skipped — the valid sign-ins still load and the
    # app starts (it used to stop the start: crash review 2026-11-13;
    # Hoodride.BootResilienceTest). The next sign-in prunes again.
    try do
      Application.get_env(:hoodride, :token_prune, &prune_rows/1).(now)
    rescue
      e in [Exqlite.Error, DBConnection.ConnectionError] ->
        Logger.warning(
          "start-up: couldn't delete expired sign-ins (#{Exception.message(e)}) — skipped"
        )
    end

    from(t in "user_tokens",
      select: {t.token_hash, t.user_id, t.inserted_at, t.authenticated_at}
    )
    |> Repo.all()
    |> Enum.each(&:ets.insert(@table, &1))

    # which were replaced, and by what; which replacements no request has
    # used yet (a reply lost just before a restart still renews after it)
    from(t in "user_tokens",
      where: not is_nil(t.replaced_by),
      select: {t.token_hash, t.replaced_by, t.user_id}
    )
    |> Repo.all()
    |> Enum.each(&:ets.insert(@links, &1))

    from(t in "user_tokens", where: t.unused == 1, select: {t.token_hash, t.user_id})
    |> Repo.all()
    |> Enum.each(&:ets.insert(@fresh, &1))

    :ok
  end

  # the TABLE is trimmed by code that already writes it (each sign-in) and
  # at start-up, so the Sweeper stays memory-only
  defp prune_rows(now) do
    from(t in "user_tokens",
      where: t.inserted_at < ^(now - @valid_ms) or t.authenticated_at < ^(now - @cap_ms)
    )
    |> Repo.delete_all()
  end

  defp insert!(user_id, h, inserted_at, authenticated_at, unused \\ 0) do
    Repo.insert_all("user_tokens", [
      %{
        user_id: user_id,
        token_hash: h,
        context: "session",
        inserted_at: inserted_at,
        authenticated_at: authenticated_at,
        unused: unused
      }
    ])
  end

  # one change of an account at a time (this node only: one server)
  defp locked(user_id, fun), do: :global.trans({{__MODULE__, user_id}, self()}, fun, [node()])

  defp now, do: System.system_time(:millisecond)

  # the start-up step: load, then step aside
  @doc false
  def child_spec(_),
    do: %{id: __MODULE__, start: {__MODULE__, :start_link, []}, restart: :transient}

  @doc false
  def start_link do
    :ok = load()
    :ignore
  end
end
