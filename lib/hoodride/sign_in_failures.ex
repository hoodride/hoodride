defmodule Hoodride.SignInFailures do
  @moduledoc """
  Codes the providers refused, counted SITE-WIDE — to WATCH, never to
  block (RFC 6819 §4.4.1.12, "DoS Using Manufactured Authorization
  'codes'"). Only a refused CODE counts (HoodrideWeb.AuthController:
  Google's `invalid_grant`, Facebook's code 100) — never our own setup
  errors or their throttling.

    * over `alert` in `alert_window_ms`: one warning in the log
      ("sign-in: N codes refused…", deploy/errors.sh shows it) — someone
      may be trying made-up codes; the time to switch Turnstile on. A
      site-wide count that REFUSED sign-ins would be an off switch anyone
      could flip (one address makes hundreds of refused codes an hour): a
      known anti-pattern — global counts are telemetry, enforcement is per
      source (the sign-in budget, per address);
    * a provider throttling us (429, Facebook's 4/17/32/613): Google's own
      rule — its Retry-After if it gave one, else truncated exponential
      backoff with jitter (`backoff_ms` doubling to `backoff_max_ms`),
      reset by the next success. Only the providers can start this pause.

  It used to block an ADDRESS for an hour after 30 refused codes in 3
  minutes: one person on a café's Wi-Fi blocked sign-in for everyone there,
  and a Google outage counted too (review 2026-11-14 — OWASP: use IP limits
  "with caution", prefer soft limits). With the state one-time
  (Hoodride.SignInStates), each refused code needs a fresh sign-in start,
  and those are limited per address (`:sign_in_budget`).

  `config :hoodride, :sign_in_failures, alert:, alert_window_ms:,
  backoff_ms:, backoff_max_ms:`; nil = off (dev, tests). Monotonic ms.
  Rows: `{:alert, count, start}`, `{:backoff, level}`, `{:paused, until}`.
  """
  require Logger

  @table :sign_in_failures

  def init_table do
    Hoodride.ETS.new(@table, [:named_table, :public, :set])
    :ok
  end

  @doc "A provider refused a code: counted; past the mark, one warning for the owner."
  def record(now \\ now()) do
    case conf() do
      nil ->
        :ok

      c ->
        recent = bump(:alert, now, c[:alert_window_ms])

        # once per window: the count reaching the mark, not every one past it
        if recent == c[:alert],
          do:
            Logger.warning(
              "sign-in: #{recent} codes refused in #{div(c[:alert_window_ms], 60_000)} min — " <>
                "someone may be trying made-up codes (Turnstile stops it: GOOGLE_SETUP.md)"
            )

        :ok
    end
  end

  @doc """
  A provider throttling us: paused for its Retry-After (ms) if it gave one,
  else the next step of truncated exponential backoff with jitter
  (Google's rule: 1 s, 2 s, 4 s… at most 32 s).
  """
  def throttled(provider, retry_after_ms \\ nil, now \\ now()) do
    case conf() do
      nil ->
        :ok

      c ->
        level = :ets.update_counter(@table, :backoff, {2, 1}, {:backoff, 0})
        step = min(c[:backoff_max_ms], c[:backoff_ms] * Integer.pow(2, min(level - 1, 30)))
        wait = retry_after_ms || step + :rand.uniform(c[:backoff_ms]) - 1
        pause(wait, "#{provider} is throttling us", now)
    end
  end

  @doc "A provider answered: the backoff starts over."
  def answered do
    :ets.delete(@table, :backoff)
    :ok
  end

  @doc "Codes refused in the current alert window (tests, the log)."
  def count do
    case :ets.lookup(@table, :alert) do
      [{_, n, _}] -> n
      [] -> 0
    end
  end

  @doc "Are calls to the providers paused right now?"
  def paused?(now \\ now()), do: wait_ms(now) > 0

  @doc "How long the pause still runs (ms), 0 when none."
  def wait_ms(now \\ now()) do
    case conf() != nil and :ets.lookup(@table, :paused) do
      [{_, until}] when until > now -> until - now
      _ -> 0
    end
  end

  # one log line when a pause starts (not on each later failure)
  defp pause(ms, why, now) do
    until = now + ms

    case :ets.lookup(@table, :paused) do
      [{_, old}] when old >= until ->
        :ok

      [{_, old}] when old > now ->
        :ets.insert(@table, {:paused, until})

      _ ->
        :ets.insert(@table, {:paused, until})
        Logger.warning("sign-in: calls to Google and Facebook paused #{div(ms, 1000)} s — #{why}")
    end

    :ok
  end

  # ATOMIC — refusals arrive at the same instant (each its own request on
  # its own core): the first creates the row (`insert_new`, only one can);
  # a finished window is restarted only if the row still holds what was
  # read (compare-and-swap); every other one is one `update_counter`. No
  # count is lost (measured, 2026-10-29: a read-then-write lost most).
  defp bump(key, now, window) do
    if :ets.insert_new(@table, {key, 1, now}) do
      1
    else
      case :ets.lookup(@table, key) do
        [{_, _, start} = old] when now - start >= window ->
          if :ets.select_replace(@table, [{old, [], [{:const, {key, 1, now}}]}]) == 1,
            do: 1,
            else: bump(key, now, window)

        [_] ->
          :ets.update_counter(@table, key, {2, 1})

        [] ->
          bump(key, now, window)
      end
    end
  end

  @doc "Sweeper: forget a pause that's over and a window that ended."
  def sweep(now \\ now()) do
    c = conf() || [alert_window_ms: 0]

    :ets.select_delete(@table, [
      {{:paused, :"$1"}, [{:"=<", :"$1", now}], [true]},
      {{:alert, :_, :"$1"}, [{:"=<", {:+, :"$1", c[:alert_window_ms]}, now}], [true]}
    ])

    :ok
  end

  defp conf, do: Hoodride.Limits.budget(:sign_in_failures)

  defp now, do: System.monotonic_time(:millisecond)
end
