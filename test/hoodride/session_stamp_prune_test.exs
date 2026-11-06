defmodule Hoodride.SessionStampPruneTest do
  @moduledoc """
  The session-stamp rows (`SessionStamp`: an account's highest device stamp)
  were never removed — one per account that connected since boot. A row
  matters only in GAPS with no device connected (it remembers which device
  you chose last, so an old tab waking up is told "moved"); while a device
  is connected, the live stamps protect the session, and a restart forgets
  every row anyway.

  So (owner's rule, a day): the Sweeper drops an account's row once NO
  device of it has been connected for a day. A separate table remembers
  when each account was last seen connected; the fencing code is untouched.
  Never two connections: an automatic reconnect still faces the live
  stamps; a dropped row only lets an old tab back in when nothing else is
  connected — exactly what a restart already allows.
  """
  use ExUnit.Case, async: false

  alias Hoodride.SessionStamp

  @day_ms 86_400_000

  defp id, do: 4_294_967_296 + System.unique_integer([:positive])
  defp now_ms, do: System.system_time(:millisecond)

  # stands in for a connected device of the account (what UserSocket.admit
  # registers for the life of the connection)
  defp connected(user_id) do
    me = self()

    pid =
      spawn(fn ->
        {:ok, _} = Registry.register(Hoodride.SocketStamps, user_id, 1)
        send(me, :registered)
        receive do: (:stop -> :ok)
      end)

    assert_receive :registered
    pid
  end

  defp disconnect(user_id, pid) do
    ref = Process.monitor(pid)
    send(pid, :stop)
    assert_receive {:DOWN, ^ref, :process, ^pid, _}
    # the Registry drops a dead process's entries asynchronously: wait for it
    # (a fixed 20 ms could lose that race on a busy machine)
    unregistered(user_id, pid, 500)
  end

  defp unregistered(_user_id, _pid, 0), do: flunk("the Registry never dropped the device")

  # Waits for what prune/1 checks — the ACCOUNT's entry (lookup by user id),
  # not the process's own (keys by pid): the Registry takes the process's
  # first and the account's a moment later (Elixir's Registry.Partition:
  # :ets.take(pid), then __unregister__ per key). Waiting on the first, a
  # busy gate ran prune/1 in between, saw the device still connected, and
  # kept the row (owner, 2026-11-06)
  defp unregistered(user_id, pid, tries) do
    if Enum.any?(Registry.lookup(Hoodride.SocketStamps, user_id), fn {p, _} -> p == pid end) do
      Process.sleep(10)
      unregistered(user_id, pid, tries - 1)
    end
  end

  test "an account with a device connected keeps its row, however old" do
    u = id()
    SessionStamp.saw(u, 100)
    dev = connected(u)
    t = now_ms()
    SessionStamp.prune(t)
    SessionStamp.prune(t + 10 * @day_ms)
    assert SessionStamp.highest(u) == 100
    disconnect(u, dev)
  end

  test "nothing connected: kept through a short gap and through 23 hours" do
    u = id()
    SessionStamp.saw(u, 100)
    t = now_ms()
    SessionStamp.prune(t)
    SessionStamp.prune(t + 60_000)
    SessionStamp.prune(t + 23 * 3_600_000)
    assert SessionStamp.highest(u) == 100
  end

  test "nothing connected for over a day: dropped" do
    u = id()
    SessionStamp.saw(u, 100)
    t = now_ms()
    SessionStamp.prune(t)
    SessionStamp.prune(t + @day_ms + 1)
    assert SessionStamp.highest(u) == nil
  end

  test "the day counts from the LAST time a device was connected" do
    u = id()
    SessionStamp.saw(u, 100)
    t = now_ms()
    # the clock starts while nothing is connected…
    SessionStamp.prune(t)
    dev = connected(u)
    # …and a pass that finds the device connected moves it on
    SessionStamp.prune(t + 5 * @day_ms)
    disconnect(u, dev)
    # 5 days after the row was made, but only 12 h after the device left
    SessionStamp.prune(t + 5 * @day_ms + 12 * 3_600_000)
    assert SessionStamp.highest(u) == 100
    SessionStamp.prune(t + 6 * @day_ms + 1)
    assert SessionStamp.highest(u) == nil
  end

  test "a dropped account leaves nothing behind (its last-seen entry goes too)" do
    u = id()
    SessionStamp.saw(u, 100)
    t = now_ms()
    SessionStamp.prune(t)
    SessionStamp.prune(t + @day_ms + 1)
    assert :ets.lookup(:session_last_live, u) == []
  end

  test "after a drop, the next connect fences again (a choice gets a fresh row)" do
    u = id()
    SessionStamp.saw(u, 100)
    t = now_ms()
    SessionStamp.prune(t)
    SessionStamp.prune(t + @day_ms + 1)
    SessionStamp.saw(u, 200)
    assert SessionStamp.highest(u) == 200
    # an old tab's automatic reconnect is told "moved" again
    assert SessionStamp.decide(false, 100, SessionStamp.highest(u), []) == :moved
  end

  test "forget (account deletion) drops the last-seen entry too" do
    u = id()
    SessionStamp.saw(u, 100)
    SessionStamp.prune(now_ms())
    SessionStamp.forget(u)
    assert :ets.lookup(:session_last_live, u) == []
  end

  test "the Sweeper's tick prunes" do
    u = id()
    SessionStamp.saw(u, 100)
    :ets.insert(:session_last_live, {u, now_ms() - @day_ms - 1})
    Hoodride.Sweeper.sweep_now()
    assert SessionStamp.highest(u) == nil
  end
end
