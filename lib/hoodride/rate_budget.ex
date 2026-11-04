defmodule Hoodride.RateBudget do
  @moduledoc """
  Per-USER rate budgets for the hot paths: map syncs and taps (`:sync`),
  user-channel actions (`:events`), ride actions (`:ride`), channel joins
  (`:join`) and socket connects (`:connect`).

  A budget is an allowance that refills at a steady rate: `burst` actions
  at once, then `per_minute`. Before doing an action the server asks "may
  this user do one more now?" — yes (one unit spent) or no, with exactly
  how long until one fits (`wait_ms`, the `retry_ms` the app honours).

  WHY PER USER, in a shared table: these budgets used to live in each
  channel's own state, so leaving and rejoining refilled them (a probe got
  210 syncs through in 15 ms against 60/min), and a ride channel opened on
  several connections had a budget on each at once. Here every connection
  and channel of a user spends from the same row. (Per-user limits that
  don't need this precision — messages, new contacts, the request cooldown
  — stay on Hammer: Hoodride.Throttle.)

  ALGORITHM: GCRA. One number per {budget, user}: the time at which the
  allowance is full again ("theoretical arrival time"). Each action pushes
  it one interval later; an action that would push it more than the burst
  ahead of now is refused. No timers: an idle allowance refills by the
  clock alone, and a row whose time has passed (full) is the same as no
  row — the sweeper deletes those.

  ATOMIC: two connections of one user can spend at the same instant. Every
  spend first tries `insert_new` (no row = a full allowance; creating it is
  one atomic step, so two first spends can never both find "no row" and
  both pass); if a row exists, a compare-and-swap (`select_replace` swaps
  the row only if it still holds the value read; otherwise read again and
  retry). So concurrent spends are all counted and never overshoot.
  Hammer's own buckets were rejected for this: a
  read-then-write (two racing spends both pass), whole-second clocks and
  whole tokens per second (30/min can't be said; retry only to the second).

  Denials don't spend, and keep refusing a client that ignores them.
  """

  @table :rate_budgets

  def init_table do
    Hoodride.ETS.new(@table, [:named_table, :public, :set])
    :ok
  end

  @doc """
  Spend one unit of `budget` for `who` (a socket with a user_id, or a user
  id). Returns {:ok, who} or {:deny, who} — `who` unchanged, so channel code
  reads as before.
  """
  def spend(who, budget, per_minute, burst, now \\ System.monotonic_time(:millisecond)) do
    interval = 60_000 / per_minute
    limit = burst * interval + interval

    case take({budget, user_id(who)}, now, interval, limit) do
      :ok -> {:ok, who}
      :deny -> {:deny, who}
    end
  end

  defp take(key, now, interval, limit) do
    # No row = a full allowance. Creating it is ONE atomic step (insert_new
    # first, not "look, then insert"), so two first spends can't both find
    # "no row" and both pass. If a row exists, the compare-and-swap below.
    if :ets.insert_new(@table, {key, now + interval}) do
      :ok
    else
      case :ets.lookup(@table, key) do
        # swept between the two steps: start over
        [] ->
          take(key, now, interval, limit)

        [{^key, tat}] ->
          new_tat = max(tat, now) + interval

          cond do
            new_tat - now > limit ->
              :deny

            :ets.select_replace(@table, [{{key, tat}, [], [{:const, {key, new_tat}}]}]) == 1 ->
              :ok

            # another spend got in between: read again
            true ->
              take(key, now, interval, limit)
          end
      end
    end
  end

  @doc """
  Milliseconds until `budget` allows one more action for `who` (0 when it
  does now). Allowed once `tat - now <= tolerance`, so the wait is
  `tat - tolerance - now`.
  """
  def wait_ms(who, budget, per_minute, burst, now \\ System.monotonic_time(:millisecond)) do
    tolerance = burst * (60_000 / per_minute)

    case :ets.lookup(@table, {budget, user_id(who)}) do
      [] -> 0
      [{_, tat}] -> max(ceil(tat - tolerance - now), 0)
    end
  end

  @doc "Sweeper: forget allowances that are full again (a full one = no row)."
  def sweep(now \\ System.monotonic_time(:millisecond)) do
    :ets.select_delete(@table, [{{:_, :"$1"}, [{:<, :"$1", now}], [true]}])
    :ok
  end

  defp user_id(%Phoenix.Socket{assigns: %{user_id: id}}), do: id
  defp user_id(id), do: id
end
