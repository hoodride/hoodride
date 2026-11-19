defmodule Hoodride.SignInStatesTest do
  @moduledoc """
  The sign-in states' cleanup and cap (owner, 2026-11-18: the one gap in the
  Sweeper's tests). The one-time rule itself is HoodrideWeb.SignInHardeningTest.
  Why it matters: a cleanup that silently stopped would let used states pile
  up to `sign_in_states_max` — then EVERY sign-in answered "try again in a
  moment" until a restart. A sign-in outage nothing else would catch.
  """
  use ExUnit.Case, async: false

  alias Hoodride.{Limits, SignInStates}

  @table :sign_in_states

  setup do
    # (the whole pass runs in one test: its database steps need a connection)
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    :ets.delete_all_objects(@table)
    on_exit(fn -> :ets.delete_all_objects(@table) end)
    :ok
  end

  defp life, do: SignInStates.lifetime_s()
  defp now, do: System.os_time(:second)
  defp state(i), do: "state-#{i}-" <> Base.url_encode64(:crypto.strong_rand_bytes(16))

  test "15 minutes, from Hoodride.Limits" do
    assert life() == div(Limits.sign_in_state_ms(), 1000)
    assert life() == 15 * 60
  end

  describe "the cleanup" do
    test "forgets states past their lifetime; keeps the fresh ones" do
      t = now()
      old = state(1)
      fresh = state(2)
      :ok = SignInStates.consume(old, t - life() - 10)
      :ok = SignInStates.consume(fresh, t - 60)

      :ok = SignInStates.sweep(t)

      assert :ets.info(@table, :size) == 1
      # the fresh one is still "used": a replay is still refused
      assert SignInStates.consume(fresh, t - 60) == :used
      # the old one is gone: usable as new again (no "seen before")
      assert SignInStates.consume(old, t) == :ok
    end

    test "the edge: kept AT its lifetime's end, gone one second past" do
      t = now()
      s = state(3)
      :ok = SignInStates.consume(s, t - life())

      :ok = SignInStates.sweep(t)
      assert :ets.info(@table, :size) == 1, "at the end: still kept (and still fresh)"
      assert SignInStates.fresh?(t - life(), t)

      :ok = SignInStates.sweep(t + 1)
      assert :ets.info(@table, :size) == 0, "one second past: gone"
      refute SignInStates.fresh?(t - life(), t + 1)
    end

    test "the Sweeper's pass runs it (by the real clock)" do
      :ok = SignInStates.consume(state(4), now() - life() - 5)
      :ok = SignInStates.consume(state(5), now())
      Hoodride.Sweeper.sweep_now()
      assert :ets.info(@table, :size) == 1
    end

    test "only a fingerprint is kept, never the state" do
      s = state(6)
      :ok = SignInStates.consume(s, now())
      [{key, _expires}] = :ets.tab2list(@table)
      assert key == :crypto.hash(:sha256, s)
      refute key == s
    end
  end

  describe "the cap" do
    test "full: 'try again' (never 'used', never let through); the cleanup frees it" do
      max = Limits.sign_in_states_max()
      t = now()
      # all started long ago — what a stopped cleanup would leave behind
      rows = for i <- 1..max, do: {:crypto.hash(:sha256, "old-#{i}"), t - 1}
      true = :ets.insert(@table, rows)

      assert SignInStates.consume(state(7), t) == :full
      assert :ets.info(@table, :size) == max, "nothing added past the cap"

      :ok = SignInStates.sweep(t)
      assert :ets.info(@table, :size) == 0
      assert SignInStates.consume(state(7), t) == :ok, "sign-in works again"
    end

    test "one under the cap: still let through" do
      max = Limits.sign_in_states_max()
      t = now()
      true = :ets.insert(@table, for(i <- 1..(max - 1), do: {"k#{i}", t + 60}))
      assert SignInStates.consume(state(8), t) == :ok
      assert SignInStates.consume(state(9), t) == :full
    end
  end
end
