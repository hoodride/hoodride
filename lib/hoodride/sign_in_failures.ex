defmodule Hoodride.SignInFailures do
  @moduledoc """
  Failed sign-ins per address — Google refusing the code we sent it
  (2026-10-29). A made-up code still costs a call to Google, and a provider
  may throttle an app that sends many invalid requests. RFC 6819
  §4.4.1.12 ("DoS Using Manufactured Authorization 'codes'"): check
  `state` before asking the provider (HoodrideWeb.AuthController), and cut
  off senders of too many invalid codes. The numbers are GitLab's
  published ones: 30 failures in 3 minutes → the address can't sign in
  for 1 hour. Real people almost never cause a failed exchange, so a
  shared address (a carrier's CGNAT) is rarely caught; anyone already
  signed in is untouched.

  `config :hoodride, :sign_in_failures, max:, window_ms:, block_ms:`;
  nil = off (dev). Rows: `{address, count, window_start}` and
  `{{:block, address}, until}`, monotonic ms; the Sweeper drops old ones.
  """

  @table :sign_in_failures

  def init_table do
    Hoodride.ETS.new(@table, [:named_table, :public, :set])
    :ok
  end

  @doc "Google refused a code from `address`: count it; the max-th blocks the address."
  def record(address, now \\ now()) do
    case conf() do
      nil ->
        :ok

      c ->
        count = bump(address, now, c[:window_ms])
        if count >= c[:max], do: :ets.insert(@table, {{:block, address}, now + c[:block_ms]})
        :ok
    end
  end

  # ATOMIC — failures arrive at the same instant (made-up codes fired in
  # parallel, each its own request on its own core). The first version read
  # the row, then wrote it: parallel first failures each wrote "1" over the
  # others, and a burst of 30 counted as low as 2 (measured, 2026-10-29) —
  # parallel bursts dodged the block. Now: the first failure creates the
  # row with `insert_new` (only one can); a finished window is restarted
  # only if the row still holds what was read (compare-and-swap,
  # `select_replace`, else read again); every other failure is one atomic
  # `update_counter`. No failure is ever lost.
  defp bump(address, now, window) do
    if :ets.insert_new(@table, {address, 1, now}) do
      1
    else
      case :ets.lookup(@table, address) do
        [{_, _, start} = old] when now - start >= window ->
          if :ets.select_replace(@table, [{old, [], [{:const, {address, 1, now}}]}]) == 1,
            do: 1,
            else: bump(address, now, window)

        [_] ->
          :ets.update_counter(@table, address, {2, 1})

        # swept away in between: start over
        [] ->
          bump(address, now, window)
      end
    end
  end

  @doc "May `address` not sign in right now?"
  def blocked?(address, now \\ now()) do
    conf() != nil and
      match?([{_, until}] when until > now, :ets.lookup(@table, {:block, address}))
  end

  @doc "Sweeper: forget lifted blocks and finished windows."
  def sweep(now \\ now()) do
    window = (conf() || [window_ms: 0])[:window_ms]

    :ets.select_delete(@table, [
      {{{:block, :_}, :"$1"}, [{:"=<", :"$1", now}], [true]},
      {{:_, :_, :"$1"}, [{:"=<", {:+, :"$1", window}, now}], [true]}
    ])

    :ok
  end

  defp conf, do: Hoodride.Limits.budget(:sign_in_failures)

  defp now, do: System.monotonic_time(:millisecond)
end
