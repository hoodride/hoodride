defmodule Hoodride.SignInFailuresTest do
  @moduledoc """
  Failed sign-ins per address (2026-10-29): Google refusing the code —
  made-up codes sent to our callback, each costing a call to Google. RFC
  6819 §4.4.1.12 ("DoS Using Manufactured Authorization 'codes'"): check
  `state` first (AuthController), and cut off whoever sends too many
  invalid ones. GitLab's published numbers: 30 failures in 3 minutes →
  that address is blocked for 1 hour. Real people almost never cause a
  failed exchange, so a shared address (a carrier's CGNAT) is rarely hit.
  """
  use ExUnit.Case, async: false

  alias Hoodride.SignInFailures, as: F

  @min 60_000

  setup do
    :ets.delete_all_objects(:sign_in_failures)

    Application.put_env(:hoodride, :sign_in_failures,
      max: 30,
      window_ms: 3 * @min,
      block_ms: 60 * @min
    )

    on_exit(fn -> Application.delete_env(:hoodride, :sign_in_failures) end)
    :ok
  end

  test "what ships: GitLab's numbers — 30 in 3 minutes, blocked 1 hour; off in dev" do
    prod = Config.Reader.read!("config/config.exs", env: :prod)[:hoodride]
    assert prod[:sign_in_failures] == [max: 30, window_ms: 180_000, block_ms: 3_600_000]
    dev = Config.Reader.read!("config/config.exs", env: :dev)[:hoodride]
    assert dev[:sign_in_failures] == nil
  end

  test "29 failures in 3 minutes: still allowed; the 30th blocks the address" do
    for i <- 1..29, do: F.record({1, 2, 3, 4}, i * 1000)
    refute F.blocked?({1, 2, 3, 4}, 30_000)
    F.record({1, 2, 3, 4}, 30_000)
    assert F.blocked?({1, 2, 3, 4}, 30_001)
  end

  # failures arriving at the SAME instant (many made-up codes at once): each
  # one counts — the first versions could lose counts to a race (two first
  # failures both creating the row, two window restarts both writing 1)
  describe "at the same instant" do
    # truly parallel, as separate web requests are: each process busy-waits
    # for one shared moment, which spreads them over every core (plain
    # spawn + message ran them one after another and hid the race — measured:
    # counts as low as 2 of 30 with this, none lost without)
    defp at_once(n, fun) do
      parent = self()
      start = System.monotonic_time(:microsecond) + 3_000

      for _ <- 1..n do
        spawn(fn ->
          wait_until(start)
          send(parent, {:done, fun.()})
        end)
      end

      for _ <- 1..n, do: assert_receive({:done, :ok}, 5_000)
    end

    defp wait_until(t) do
      if System.monotonic_time(:microsecond) < t, do: wait_until(t)
    end

    defp all_at_once(address, n), do: at_once(n, fn -> F.record(address, 5_000) end)

    test "30 at once block the address; 29 at once don't" do
      for round <- 1..20 do
        all_at_once({:thirty, round}, 30)
        assert F.blocked?({:thirty, round}, 5_001), "round #{round}: 30 at once must block"
        all_at_once({:twenty_nine, round}, 29)
        refute F.blocked?({:twenty_nine, round}, 5_001), "round #{round}: 29 at once must not"
      end
    end

    test "a window restart at the same instant still counts every failure" do
      for round <- 1..20 do
        address = {:restart, round}
        F.record(address, 0)
        # four minutes later the old window is over: 30 at once start a new one
        at_once(30, fn -> F.record(address, 4 * @min) end)
        assert F.blocked?(address, 4 * @min + 1), "round #{round}"
      end
    end
  end

  test "the block lasts an hour, then lifts" do
    for i <- 1..30, do: F.record(:a, i)
    assert F.blocked?(:a, 60 * @min)
    refute F.blocked?(:a, 60 * @min + 31)
  end

  test "failures spread over more than 3 minutes don't add up" do
    # 29 now, 29 more four minutes later: never 30 inside one window
    for i <- 1..29, do: F.record(:b, i)
    for i <- 1..29, do: F.record(:b, 4 * @min + i)
    refute F.blocked?(:b, 4 * @min + 100)
  end

  test "one address's failures never block another" do
    for i <- 1..30, do: F.record(:c, i)
    assert F.blocked?(:c, 100)
    refute F.blocked?(:d, 100)
  end

  test "switched off (dev): nothing is counted, nothing blocked" do
    Application.put_env(:hoodride, :sign_in_failures, nil)
    for i <- 1..100, do: F.record(:e, i)
    refute F.blocked?(:e, 200)
  end

  test "the sweep forgets lifted blocks and old windows" do
    for i <- 1..30, do: F.record(:f, i)
    F.record(:g, 1)
    F.sweep(61 * @min)
    assert :ets.tab2list(:sign_in_failures) == []
  end
end
