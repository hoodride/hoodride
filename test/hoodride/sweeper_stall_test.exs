defmodule Hoodride.SweeperStallTest do
  @moduledoc """
  The cleanup pass never stalls on backed-up map writers (server review,
  2026-11-13). It took stale cars and ✋ off the map one by one, waiting up
  to 5 s for each: with the writers backed up, 100 stale cars held the pass
  ~8 minutes — and every step after it (sign-ins, chats, rate rows, the
  recount) waited too.

  Now it waits at most a second; once a writer has kept it waiting, the
  rest of the pass doesn't wait at all. Nothing is lost: each change is
  already in its writer's queue and lands, in order, when it catches up
  (Hoodride.GeoWriter.exec).

  The writers are made "stuck" with :sys.suspend; the waits are the real
  ones (no :geo_call_timeout override).
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Geo}

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp writers do
    for {_, pid, _, _} <- PartitionSupervisor.which_children(Hoodride.GeoWriters),
        is_pid(pid),
        do: pid
  end

  defp stale_car(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, @spot, [])
    # silent for an hour
    [row] = :ets.lookup(:geo_drivers, u.id)
    :ets.insert(:geo_drivers, put_elem(row, 3, System.system_time(:second) - 3600))
    u.id
  end

  test "stale cars with every writer stuck: the pass ends within seconds; the cars still go" do
    ids = for i <- 1..30, do: stale_car("ss-#{i}")
    ws = writers()
    Enum.each(ws, &:sys.suspend/1)

    sweep = Task.async(fn -> Hoodride.Sweeper.sweep_now() end)

    try do
      # (before: ~5 s per car — 30 cars, 2½ minutes)
      assert Task.yield(sweep, 4_000) == {:ok, :ok}, "the pass stalled on the writers"
    after
      Task.shutdown(sweep, :brutal_kill)
      Enum.each(ws, &:sys.resume/1)
      Enum.each(ws, &:sys.get_state/1)
    end

    # what it asked for landed once the writers caught up
    for id <- ids, do: refute(Geo.driver_on_map?(id))
  end

  test "the short wait is the pass's own: afterwards the same process waits as before" do
    Application.put_env(:hoodride, :geo_call_timeout, 300)
    on_exit(fn -> Application.delete_env(:hoodride, :geo_call_timeout) end)
    id = stale_car("ss-own")
    ws = writers()
    Enum.each(ws, &:sys.suspend/1)

    try do
      # (in THIS process: the timer's pass runs in the Sweeper's)
      assert Hoodride.Sweeper.sweep_now() == :ok
      {us, result} = :timer.tc(fn -> Geo.hand_down(id) end)
      assert result == {:error, :timeout}
      assert us >= 250_000, "the pass's 'don't wait' leaked out of it"
    after
      Enum.each(ws, &:sys.resume/1)
      Enum.each(ws, &:sys.get_state/1)
    end
  end
end
