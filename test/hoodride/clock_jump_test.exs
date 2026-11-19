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
    :ets.insert(:geo_drivers, put_elem(row, 3, System.monotonic_time(:second) - 3600))
    u.id
  end

  test "how far the clock jumped: the wall clock's move less the steady clock's" do
    assert Sweeper.clock_jump_s({1_000, 50}, {1_060, 110}) == 0
    assert Sweeper.clock_jump_s({1_000, 50}, {1_660, 110}) == 600
    assert Sweeper.clock_jump_s({1_000, 50}, {400, 110}) == 660
  end

  test "a pass after a jump skips the steps that judge by the wall clock — only those" do
    names = fn opts -> Enum.map(Sweeper.steps(opts), &elem(&1, 0)) end
    all = names.([])
    skipped = all -- names.(skip_timed: true)
    # (only times from outside this running server: a sign-in's, stored; a
    # sign-in state's, in the browser's cookie)
    assert Enum.sort(skipped) == Enum.sort([:sign_in_states, :session_tokens])
  end

  # (2026-11-18, independent review) cars, ✋, presence, requests and rides
  # are aged by the STEADY clock: a jump of the wall clock — either way —
  # changes nothing. The skipped pass only ever helped a forward jump; a
  # step BACK kept departed cars and requests for as long as the step
  test "the wall clock jumps (either way): live cars stay, departed ones go — in that very pass" do
    live = stale_car("cj-live")
    # connected, its position fresh
    {:ok, _} = Registry.register(Hoodride.UserChannels, live, nil)
    Geo.user_connected(live)
    [row] = :ets.lookup(:geo_drivers, live)
    :ets.insert(:geo_drivers, put_elem(row, 3, System.monotonic_time(:second)))
    # (a departed car of its own for each jump: the first pass's removal
    # mustn't make the second's pass for free — the third review)
    for {jump, name} <- [{600, :cj_fwd}, {-3600, :cj_back}] do
      gone = stale_car("cj-gone-#{name}")
      :ets.insert(:geo_presence, {gone, :grace, System.monotonic_time(:second) - 3600})
      assert Geo.driver_on_map?(gone)
      pid = start_supervised!({Sweeper, name: name, every_ms: :manual}, id: name)

      :sys.replace_state(pid, fn s ->
        %{s | clock: {System.system_time(:second) - jump, System.monotonic_time(:second)}}
      end)

      log =
        capture_log(fn ->
          send(pid, :sweep)
          :sys.get_state(pid)
        end)

      assert log =~ "clock jumped"
      assert Geo.driver_on_map?(live), "jump #{jump}: a live car went"
      refute Geo.driver_on_map?(gone), "jump #{jump}: a departed car stayed"
    end
  end

  # what decides each age is the clock it's KEPT by: the steady one is
  # nowhere near the wall clock, so a row kept by the wall clock shows
  describe "ages kept by the steady clock" do
    defp steady?(t), do: abs(t - System.monotonic_time(:second)) <= 2

    test "presence: when someone came or went" do
      Geo.user_connected(701)
      assert [{_, :online, t1}] = :ets.lookup(:geo_presence, 701)
      assert steady?(t1), "kept by the wall clock (#{t1})"
      Geo.user_disconnected(701)
      assert [{_, :grace, t2}] = :ets.lookup(:geo_presence, 701)
      assert steady?(t2), "kept by the wall clock (#{t2})"
    end

    test "a car's last position" do
      id = stale_car("cj-pos")
      :ok = Geo.driver_update(%{id: id, name: "x", photo: nil}, @cell, @spot, [])
      [{_, _, _, ts}] = :ets.lookup(:geo_drivers, id)
      assert steady?(ts), "kept by the wall clock (#{ts})"
    end

    test "a request — and what the app is sent is the wall clock's time" do
      Geo.user_connected(702)
      :ok = Geo.driver_update(%{id: 702, name: "D", photo: nil}, @cell, @spot, [])
      :ok = Hoodride.Requests.create(%{id: 703, name: "R", photo: nil}, 702)
      [{_, _, ts}] = :ets.lookup(:ride_requests, 703)
      assert steady?(ts), "kept by the wall clock (#{ts})"
      assert abs(Hoodride.Requests.wall_ts(ts) - System.system_time(:second)) <= 2
    end

    test "a ride's last word from each side (abandonment)" do
      {:ok, r} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "cj-r", name: "R"})
      {:ok, d} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "cj-d", name: "D"})
      {:ok, id} = Hoodride.Rides.start_ride(r.id, d.id)
      [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, id)
      st = :sys.get_state(pid)
      assert steady?(st.last_rider) and steady?(st.last_driver), "kept by the wall clock"
      :ok = Hoodride.Rides.end_ride(id, r.id)
    end
  end

  # (owner, 2026-11-18 — the sweeper review) two more limits judged by the
  # WALL clock, and not only in the sweep: a message's retry id (10 min —
  # Chat.sent_receipt read it too, so after a forward jump a phone's retry
  # of a lost reply was "never seen": the message delivered TWICE) and
  # "which device you chose" for an account offline a day (SessionStamp: a
  # day-long jump forgot them all — an old tab could take over). Neither is
  # a time anyone sees: they measure how long, so they use the steady clock,
  # which never jumps (as RateBudget and SignInFailures already do; Erlang's
  # time guide). A real jump can't be made in a test: what's checked is the
  # clock each is kept by — the steady one is nowhere near the wall clock.
  describe "lengths of time, by the steady clock" do
    defp steady_s, do: System.monotonic_time(:second)

    test "a message's retry id is kept by the steady clock" do
      _ = Hoodride.Chat.remember_sent(601, "cid-1", %{id: 1})
      [{_, _, at}] = :ets.lookup(:chat_sent_ids, {601, "cid-1"})
      assert abs(at - steady_s()) <= 2, "kept by the wall clock (#{at}): a jump loses it"
    end

    test "a retry id stored a moment ago (steady clock) still answers; past 10 min it doesn't" do
      :ets.insert(:chat_sent_ids, {{602, "now"}, %{id: 2}, steady_s()})
      :ets.insert(:chat_sent_ids, {{602, "old"}, %{id: 3}, steady_s() - 601})
      assert Hoodride.Chat.sent_receipt(602, "now") == %{id: 2}
      assert Hoodride.Chat.sent_receipt(602, "old") == nil
      Hoodride.Chat.sweep_sent_ids()
      assert [_] = :ets.lookup(:chat_sent_ids, {602, "now"})
      assert :ets.lookup(:chat_sent_ids, {602, "old"}) == []
    end

    test "'last seen' for the device you chose is kept by the steady clock" do
      {:ok, u} =
        Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "cj-st", name: "cj-st"})

      _ = Hoodride.SessionStamp.saw(u.id, Hoodride.SessionStamp.issue())
      Hoodride.SessionStamp.prune()
      [{_, at}] = :ets.lookup(:session_last_live, u.id)
      steady_ms = System.monotonic_time(:millisecond)
      assert abs(at - steady_ms) <= 2_000, "kept by the wall clock (#{at}): a jump forgets it"
    end
  end

  test "the app waits for the clock to be synced before starting" do
    unit = File.read!("deploy/hoodride.service")
    assert unit =~ ~r/^After=.*time-sync\.target/m
    assert unit =~ ~r/^Wants=.*time-sync\.target/m
    # (time-sync.target means "synced" only with the wait switched on)
    assert File.read!("deploy/setup.sh") =~ "systemctl enable systemd-time-wait-sync"
  end
end
