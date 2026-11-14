defmodule Hoodride.SignInStates do
  @moduledoc """
  Each sign-in's `state`, used up ONCE (RFC 9700: one-time CSRF tokens
  bound to the browser). The state lives in the session — a cookie the
  BROWSER keeps — so a copy saved once could be replayed over and over,
  each time making us call Google with a made-up code (review 2026-11-14).
  A cookie can prove we issued it; only the server can say it's been used.

  At the return, before the provider is asked: `consume/2` — atomic
  (`insert_new`: two returns at once, one wins). A state lives
  `sign_in_state_ms` from its start (the start time rides in the session);
  its row is kept that long and swept after. Only a FINGERPRINT is kept
  (sha256), never the state. At most `sign_in_states_max` rows: full, a
  return is asked to try again in a moment — memory stays bounded whatever
  a botnet does (a row is ~100 bytes).
  """

  @table :sign_in_states

  def init_table do
    Hoodride.ETS.new(@table, [:named_table, :public, :set])
    :ok
  end

  @doc "How long a state is good for, from its start (s)."
  def lifetime_s, do: div(Hoodride.Limits.sign_in_state_ms(), 1000)

  @doc "Is a state started at `issued_at` (wall clock, s) still good?"
  def fresh?(issued_at, now \\ now())
  def fresh?(at, now) when is_integer(at), do: now - at <= lifetime_s() and at <= now + 60
  def fresh?(_, _), do: false

  @doc "Use `state` up: `:ok` (first time), `:used` (seen before), `:full`."
  def consume(state, issued_at) do
    cond do
      :ets.info(@table, :size) >= Hoodride.Limits.sign_in_states_max() -> :full
      :ets.insert_new(@table, {key(state), issued_at + lifetime_s()}) -> :ok
      true -> :used
    end
  end

  @doc "Not used after all (the providers paused): the same return may try again."
  def give_back(state) do
    :ets.delete(@table, key(state))
    :ok
  end

  @doc "Sweeper: forget states past their lifetime (they're refused anyway)."
  def sweep(now \\ now()) do
    :ets.select_delete(@table, [{{:_, :"$1"}, [{:<, :"$1", now}], [true]}])
    :ok
  end

  defp key(state), do: :crypto.hash(:sha256, state)
  defp now, do: System.os_time(:second)
end
