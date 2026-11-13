defmodule Hoodride.RateLimit do
  @moduledoc """
  Hammer's ETS backend — the shared counters behind Hoodride.Throttle.

  Algorithm: per-key fixed window (`fix_window_per_key`), chosen from
  Hammer's source: O(1) direct-key lookup, atomic `update_counter`, and
  each key's window starts at its first hit — which is exactly a cooldown
  for the re-request limit. Rejected: `token_bucket` (refill rate must be
  a whole number of tokens per SECOND; our budgets are per minute/hour)
  and `sliding_window` (counts a key with a match-spec guard, i.e. a scan
  of the whole table on every hit). Accepted cost: up to 2x a budget can
  slip through across one key's window boundary.
  """
  use Hammer, backend: :ets, algorithm: :fix_window_per_key

  @doc """
  One taken back (Hoodride.Throttle's give-backs): the count down by one,
  never below 0. Never starts a window: `inc(key, scale, -1)` on a window
  that just ended would start a new one at -1 — a free extra. Gone (swept):
  nothing to give back.
  """
  def give_back(key) do
    # rows are {key, count, expires_at} (Hammer's fix_window_per_key)
    :ets.update_counter(__MODULE__, key, {2, -1, 0, 0})
    :ok
  rescue
    ArgumentError -> :ok
  end
end
