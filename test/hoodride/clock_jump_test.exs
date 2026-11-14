defmodule Hoodride.ClockJumpTest do
  @moduledoc """
  The server's clock jumping (crash review, 2026-11-14). Cars, requests and
  chats are aged by the wall clock: when it steps — most likely booting with
  a wrong clock that time sync then corrects — every age jumps at once, and
  the next cleanup pass took every car off the map, expired every request,
  closed chats.

    * the app starts only once the clock is synced (deploy/hoodride.service,
      and setup.sh switches on the wait for it);
    * the cleanup notices a jump (the wall clock moved differently from the
      steady one since its last pass) and skips that pass's time-based
      steps. Live cars and rides refresh their times within seconds, so the
      next pass judges by the new clock — only what's really stale goes.
  """
  use HoodrideWeb.ConnCase, async: false
  import ExUnit.CaptureLog

  alias Hoodride.{Accounts, Geo, Sweeper}

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp stale_car(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, @spot, [])
    [row] = :ets.lookup(:geo_drivers, u.id)
    :ets.insert(:geo_drivers, put_elem(row, 3, System.system_time(:second) - 3600))
    u.id
  end

  test "how far the clock jumped: the wall clock's move less the steady clock's" do
    assert Sweeper.clock_jump_s({1_000, 50}, {1_060, 110}) == 0
    assert Sweeper.clock_jump_s({1_000, 50}, {1_660, 110}) == 600
    assert Sweeper.clock_jump_s({1_000, 50}, {400, 110}) == 660
  end

  test "a pass after a jump skips the time-based steps — only those" do
    names = fn opts -> Enum.map(Sweeper.steps(opts), &elem(&1, 0)) end
    all = names.([])
    skipped = all -- names.(skip_timed: true)

    assert Enum.sort(skipped) ==
             Enum.sort([
               :sign_in_states,
               :expire_stale_requests,
               :sweep_stale_geo,
               :sweep_empty_room_chats,
               :session_tokens
             ])
  end

  test "the clock jumps 10 minutes: that pass leaves the cars; the next, judging by the new clock, cleans up" do
    id = stale_car("cj-1")
    pid = start_supervised!({Sweeper, name: :clock_jump_sweeper, every_ms: :manual})

    # its last pass: 10 minutes ago by the wall clock, a moment ago by the
    # steady one — the wall clock jumped
    :sys.replace_state(pid, fn s ->
      %{s | clock: {System.system_time(:second) - 600, System.monotonic_time(:second)}}
    end)

    log =
      capture_log(fn ->
        send(pid, :sweep)
        :sys.get_state(pid)
      end)

    assert Geo.driver_on_map?(id), "the jump's pass reaped the car"
    assert log =~ "clock jumped"

    # no jump since: an ordinary pass — the hour-silent car goes
    send(pid, :sweep)
    :sys.get_state(pid)
    refute Geo.driver_on_map?(id)
  end

  test "the app waits for the clock to be synced before starting" do
    unit = File.read!("deploy/hoodride.service")
    assert unit =~ ~r/^After=.*time-sync\.target/m
    assert unit =~ ~r/^Wants=.*time-sync\.target/m
    # (time-sync.target means "synced" only with the wait switched on)
    assert File.read!("deploy/setup.sh") =~ "systemctl enable systemd-time-wait-sync"
  end
end
