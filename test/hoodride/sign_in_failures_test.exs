defmodule Hoodride.SignInFailuresTest do
  @moduledoc """
  Codes the providers refuse, counted SITE-WIDE and watched — never a block
  (review 2026-11-14; RFC 6819 §4.4.1.12). It used to block an ADDRESS for
  an hour after 30 refused codes in 3 minutes (GitLab's numbers): one
  person on a café's Wi-Fi could lock sign-in out for everyone there. A
  site-wide count that refused sign-ins would be worse — an off switch
  anyone could flip — so it only WARNS the owner (global counts are
  telemetry; enforcement is per address: the sign-in budget). The only
  pause: Google or Facebook throttling us — their Retry-After, else
  truncated exponential backoff with jitter (Google's own rule).
  """
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  alias Hoodride.SignInFailures, as: F

  @min 60_000

  setup do
    :ets.delete_all_objects(:sign_in_failures)

    Application.put_env(:hoodride, :sign_in_failures,
      alert: 50,
      alert_window_ms: 10 * @min,
      backoff_ms: 1_000,
      backoff_max_ms: 32_000
    )

    on_exit(fn -> Application.put_env(:hoodride, :sign_in_failures, nil) end)
    :ok
  end

  test "what ships: a warning at 50 in 10 minutes; Google's backoff (1 s doubling to 32 s); off in dev" do
    assert Hoodride.Limits.sign_in_failures() == [
             alert: 50,
             alert_window_ms: 600_000,
             backoff_ms: 1_000,
             backoff_max_ms: 32_000
           ]

    prod = Config.Reader.read!("config/config.exs", env: :prod)[:hoodride]
    refute Keyword.has_key?(prod, :sign_in_failures), "prod runs Hoodride.Limits' numbers"
    dev = Config.Reader.read!("config/config.exs", env: :dev)[:hoodride]
    assert Keyword.fetch!(dev, :sign_in_failures) == nil
  end

  test "however many are refused: one warning per window — and never a pause" do
    log = capture_log(fn -> for i <- 1..120, do: F.record(i) end)
    assert length(Regex.scan(~r/sign-in: 50 codes refused in 10 min/, log)) == 1
    refute F.paused?(200)
  end

  test "spread over more than the window: they don't add up" do
    log =
      capture_log(fn ->
        for i <- 1..49, do: F.record(i)
        for i <- 1..49, do: F.record(11 * @min + i)
      end)

    refute log =~ "codes refused"
  end

  # refusals arriving at the SAME instant (each its own request on its own
  # core): each one counts — the first versions lost counts to a race
  describe "at the same instant" do
    # truly parallel: each process busy-waits for one shared moment, which
    # spreads them over every core (measured: plain spawn hid the race)
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

    test "50 at once are all counted" do
      for _ <- 1..10 do
        :ets.delete_all_objects(:sign_in_failures)
        at_once(50, fn -> F.record(5_000) end)
        assert F.count() == 50
      end
    end

    test "a window restart at the same instant still counts every one" do
      for _ <- 1..10 do
        :ets.delete_all_objects(:sign_in_failures)
        F.record(0)
        at_once(50, fn -> F.record(11 * @min) end)
        assert F.count() == 50
      end
    end
  end

  describe "the providers throttling us" do
    test "their Retry-After, exactly" do
      F.throttled("google", 7_000, 1_000)
      assert F.wait_ms(1_000) == 7_000
      refute F.paused?(8_000)
    end

    test "none given: backoff doubling with jitter, at most 32 s; an answer starts it over" do
      waits =
        for _ <- 1..7 do
          :ets.delete(:sign_in_failures, :paused)
          F.throttled("google", nil, 0)
          F.wait_ms(0)
        end

      assert Enum.at(waits, 0) in 1_000..1_999
      assert Enum.at(waits, 1) in 2_000..2_999
      assert Enum.at(waits, 2) in 4_000..4_999
      assert Enum.at(waits, 6) in 32_000..32_999
      F.answered()
      :ets.delete(:sign_in_failures, :paused)
      F.throttled("google", nil, 0)
      assert F.wait_ms(0) in 1_000..1_999
    end

    test "a shorter wait never cuts a longer one short" do
      F.throttled("google", 20_000, 0)
      F.throttled("google", 1_000, 0)
      assert F.wait_ms(0) == 20_000
    end
  end

  test "switched off (dev): nothing counted, never paused" do
    Application.put_env(:hoodride, :sign_in_failures, nil)
    for i <- 1..100, do: F.record(i)
    F.throttled("google", 60_000, 0)
    assert F.count() == 0
    refute F.paused?(1)
  end

  test "the sweep forgets an ended pause and an old window" do
    F.record(1)
    F.throttled("google", 1_000, 0)
    F.answered()
    F.sweep(11 * @min)
    assert :ets.tab2list(:sign_in_failures) == []
  end
end
